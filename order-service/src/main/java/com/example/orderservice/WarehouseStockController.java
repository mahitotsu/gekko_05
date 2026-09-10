package com.example.orderservice;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.HttpClientErrorException;

/**
 * UC8/UC9 (docs/use-cases.md): the logistics all-branch inquiry screen. Gated by
 * warehouse-viewer(-all) rather than order-writer/order-reader -- sato-logistics
 * (warehouse-viewer-all) holds neither of the latter, so gating on those would deny
 * UC8's own正常系 persona at this entry point before the delegation chain even starts.
 */
@RestController
public class WarehouseStockController {

    private final TokenExchangeClient tokenExchangeClient;
    private final InventoryClient inventoryClient;

    public WarehouseStockController(TokenExchangeClient tokenExchangeClient, InventoryClient inventoryClient) {
        this.tokenExchangeClient = tokenExchangeClient;
        this.inventoryClient = inventoryClient;
    }

    @GetMapping("/warehouse-stock/{branch}/{productId}")
    @PreAuthorize("hasRole('warehouse-viewer') or hasRole('warehouse-viewer-all')")
    public ResponseEntity<String> getWarehouseStock(
            @PathVariable String branch, @PathVariable String productId, @AuthenticationPrincipal Jwt jwt) {
        String inventoryToken = tokenExchangeClient.exchange(jwt.getTokenValue(), "inventory-service", "inventory");
        try {
            String body = inventoryClient.getWarehouseStock(inventoryToken, branch, productId);
            return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(body);
        } catch (HttpClientErrorException e) {
            return ResponseEntity.status(e.getStatusCode())
                .contentType(MediaType.APPLICATION_JSON)
                .body(e.getResponseBodyAsString());
        }
    }
}
