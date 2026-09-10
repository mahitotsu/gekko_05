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

// tracedHTTPClientはリクエストcontextの有効なスパンから導かれるW3C traceparent
// ヘッダーを発信呼び出しに注入し、トレースツリーへ接続する。
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

// getProductはInventory Service自身が持つ集計値ビューから「どこかに在庫があるか」に
// 答える。Warehouse Serviceを呼び出すことは一切ない：実運用ではこの集計値は
// Warehouse Serviceから非同期に同期される（本サンプルではdb/init.sqlで種データを
// 投入する形で代替している）。
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

// reserveは拠点固有の実際の引当てを必要とし、これを権威を持って行えるのは
// Warehouse Serviceだけである（実際の支店別在庫と支店アクセスポリシーを保有する
// のはWarehouse Service）。呼び出し元のトークンをwarehouse-service向けaudienceへ
// 交換し、商品の担当支店に対する/reserveエンドポイントを呼び出す。
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

// reserveAtWarehouseは成功時(true, nil)を返し、Warehouse Serviceが在庫不足を報告
// した場合も支店アクセスを拒否した場合も(false, nil)を返す（どちらの場合も呼び
// 出し元には「この引当ては行われなかった」とだけ伝わり、どちらが理由かは漏らさない）。
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

// getWarehouseStock（UC8/UC9, docs/use-cases.md）は、物流部門向け全支店照会画面が
// 使う、Warehouse Service自身の支店可視性フィルタ済み在庫照会への中継である。
// 「支店Xには何があるか」ではなく「この呼び出し元に何が見えるか」を問う——この
// リクエストにはそもそも支店が含まれず、productIDのみなので、呼び出し元が指定した
// 支店を拒否するという状況自体が発生しない。Warehouse Serviceは呼び出し元が見て
// よい支店の集合（空、1件、全件のいずれもありうる）をそのまま返し、ここではその
// レスポンスをそのまま中継する。唯一の例外はwarehouse-viewer・warehouse-viewer-all
// のどちらも持たない場合の403（ABAC/支店の問題ではなく、UC3/UC7と同種の「この画面
// の対象外です」というRBACゲート）で、これも解釈を加えずそのまま中継する：
// architecture.md §20。
func (h *InventoryHandlers) getWarehouseStock(w http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("productId")

	rawToken := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	warehouseToken, err := h.tokenExchange.Exchange(r.Context(), rawToken, "warehouse-service", "warehouse")
	if err != nil {
		log.Printf("token exchange for warehouse-service failed: %v", err)
		http.Error(w, "downstream authorization failed", http.StatusBadGateway)
		return
	}

	url := fmt.Sprintf("%s/warehouse/stock/%s", h.warehouseBaseURL, productID)
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
