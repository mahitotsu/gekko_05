package com.example.orderservice;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.HttpClientErrorException;

/**
 * UC8/UC9 (docs/use-cases.md): the logistics all-branch inquiry screen. Deliberately
 * carries no @PreAuthorize: branch-level access (warehouse-viewer/-all, ABAC branch
 * match) is not order-service's business (services.md declares its own feature set as
 * just 受注登録/受注照会) -- it is Warehouse Service's alone (services.md: "組織的に独立
 * した拠点システム"). order-service is forced to be this request's first hop only
 * because the delegation topology gives frontend no other way to reach it (permission-
 * matrix.md 表1), not because it has any authority to exercise here. Gating on
 * order-writer/order-reader would be equally wrong (sato-logistics, UC8's persona,
 * holds neither), and gating on warehouse-viewer(-all) -- what the previous version of
 * this file did -- duplicates Warehouse Service's own RBAC and silently goes stale if
 * that role vocabulary ever changes (docs/backlog.md, now resolved; see
 * architecture.md §20). So: authenticate (already enforced by SecurityConfig's
 * `.anyRequest().authenticated()`) and relay; let the chain's authority (Warehouse
 * Service) decide and propagate its denial back untouched.
 */
@RestController
public class WarehouseStockController {

    private final TokenExchangeClient tokenExchangeClient;
    private final InventoryClient inventoryClient;

    public WarehouseStockController(TokenExchangeClient tokenExchangeClient, InventoryClient inventoryClient) {
        this.tokenExchangeClient = tokenExchangeClient;
        this.inventoryClient = inventoryClient;
    }

    @GetMapping("/warehouse-stock/{productId}")
    public ResponseEntity<String> getWarehouseStock(
            @PathVariable String productId, @AuthenticationPrincipal Jwt jwt) {
        String inventoryToken = tokenExchangeClient.exchange(jwt.getTokenValue(), "inventory-service", "inventory");
        try {
            String body = inventoryClient.getWarehouseStock(inventoryToken, productId);
            return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(body);
        } catch (HttpClientErrorException e) {
            return ResponseEntity.status(e.getStatusCode())
                .contentType(MediaType.APPLICATION_JSON)
                .body(e.getResponseBodyAsString());
        }
    }
}
