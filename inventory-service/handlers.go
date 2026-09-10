package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// tracedHTTPClient injects the W3C traceparent header derived from the request
// context's active span into outgoing calls, connecting them into the trace tree.
var tracedHTTPClient = &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}

type Product struct {
	ID             string `json:"productId"`
	Name           string `json:"name"`
	AggregateStock int    `json:"aggregateStock"`
	PrimaryBranch  string `json:"-"`
}

type InventoryHandlers struct {
	db               *sql.DB
	tokenExchange    *TokenExchangeClient
	warehouseBaseURL string
}

// getProduct answers "is there stock somewhere" from Inventory Service's own aggregate
// view. It never calls Warehouse Service: the aggregate is synced from there
// asynchronously in a real deployment (here, seeded via db/init.sql instead).
func (h *InventoryHandlers) getProduct(w http.ResponseWriter, r *http.Request) {
	product, err := h.loadProduct(r.PathValue("id"))
	if err == sql.ErrNoRows {
		http.Error(w, "product not found", http.StatusNotFound)
		return
	}
	if err != nil {
		log.Printf("loadProduct error: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, product)
}

type reserveRequest struct {
	Quantity int `json:"quantity"`
}

// reserve requires an actual location-specific reservation, which only Warehouse
// Service can authoritatively perform (it owns the real per-branch stock and the
// branch-access policy). This exchanges the caller's token for warehouse-service's
// audience and calls its /reserve endpoint for the product's designated branch.
func (h *InventoryHandlers) reserve(w http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("id")

	var req reserveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	product, err := h.loadProduct(productID)
	if err == sql.ErrNoRows {
		http.Error(w, "product not found", http.StatusNotFound)
		return
	}
	if err != nil {
		log.Printf("loadProduct error: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if product.AggregateStock < req.Quantity {
		http.Error(w, "insufficient stock", http.StatusConflict)
		return
	}

	rawToken := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	warehouseToken, err := h.tokenExchange.Exchange(r.Context(), rawToken, "warehouse-service", "warehouse")
	if err != nil {
		log.Printf("token exchange for warehouse-service failed: %v", err)
		http.Error(w, "downstream authorization failed", http.StatusBadGateway)
		return
	}

	reserved, err := h.reserveAtWarehouse(r.Context(), warehouseToken, product.PrimaryBranch, productID, req.Quantity)
	if err != nil {
		log.Printf("warehouse-service call failed: %v", err)
		http.Error(w, "downstream call failed", http.StatusBadGateway)
		return
	}
	if !reserved {
		http.Error(w, "insufficient stock at branch", http.StatusConflict)
		return
	}

	newStock := product.AggregateStock - req.Quantity
	if _, err := h.db.Exec("UPDATE products SET aggregate_stock = ? WHERE id = ?", newStock, productID); err != nil {
		log.Printf("update stock error: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	product.AggregateStock = newStock
	writeJSON(w, http.StatusOK, product)
}

// reserveAtWarehouse returns (true, nil) on success, (false, nil) if Warehouse Service
// reports insufficient stock or denies branch access (both surfaced to the caller as
// "this reservation didn't happen", without leaking which of the two it was).
func (h *InventoryHandlers) reserveAtWarehouse(ctx context.Context, token, branch, productID string, quantity int) (bool, error) {
	body, _ := json.Marshal(reserveRequest{Quantity: quantity})
	url := fmt.Sprintf("%s/warehouse/%s/stock/%s/reserve", h.warehouseBaseURL, branch, productID)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := tracedHTTPClient.Do(httpReq)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusConflict, http.StatusForbidden:
		return false, nil
	default:
		return false, fmt.Errorf("unexpected status %d from warehouse-service", resp.StatusCode)
	}
}

// getWarehouseStock (UC8/UC9, docs/use-cases.md) is a passthrough for a specific
// branch's real stock, used by the logistics all-branch inquiry screen. Unlike
// reserveAtWarehouse, this is a read with no business-state outcome to hide behind, so
// Warehouse Service's actual status/body (200 with the real quantity, or 403 for a
// denied branch) is relayed as-is rather than collapsed into a generic result --
// branch access denial should be visible here, not disguised.
func (h *InventoryHandlers) getWarehouseStock(w http.ResponseWriter, r *http.Request) {
	branch := r.PathValue("branch")
	productID := r.PathValue("productId")

	rawToken := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	warehouseToken, err := h.tokenExchange.Exchange(r.Context(), rawToken, "warehouse-service", "warehouse")
	if err != nil {
		log.Printf("token exchange for warehouse-service failed: %v", err)
		http.Error(w, "downstream authorization failed", http.StatusBadGateway)
		return
	}

	url := fmt.Sprintf("%s/warehouse/%s/stock/%s", h.warehouseBaseURL, branch, productID)
	httpReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	httpReq.Header.Set("Authorization", "Bearer "+warehouseToken)

	resp, err := tracedHTTPClient.Do(httpReq)
	if err != nil {
		log.Printf("warehouse-service call failed: %v", err)
		http.Error(w, "downstream call failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func (h *InventoryHandlers) loadProduct(id string) (Product, error) {
	var p Product
	err := h.db.QueryRow("SELECT id, name, aggregate_stock, primary_branch FROM products WHERE id = ?", id).
		Scan(&p.ID, &p.Name, &p.AggregateStock, &p.PrimaryBranch)
	return p, err
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
