package com.example.orderservice;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * Calls Inventory Service's reservation endpoint using a token already
 * exchanged (by TokenExchangeClient) for inventory-service's audience.
 */
@Component
public class InventoryClient {

    private final RestClient restClient;

    public InventoryClient(
            @Value("${app.inventory-service.base-url}") String baseUrl,
            RestClient.Builder restClientBuilder) {
        // Use Spring's auto-configured RestClient.Builder (wired with Micrometer's
        // ObservationRegistry) so outgoing calls get auto-instrumented OTel spans and
        // W3C traceparent propagation, instead of a fresh RestClient.builder().
        this.restClient = restClientBuilder.baseUrl(baseUrl).build();
    }

    public record ReserveRequest(int quantity) {
    }

    /**
     * @return true if the reservation succeeded, false if stock was insufficient (409).
     */
    public boolean reserve(String inventoryToken, String productId, int quantity) {
        try {
            restClient.post()
                .uri("/inventory/{productId}/reserve", productId)
                .header("Authorization", "Bearer " + inventoryToken)
                .body(new ReserveRequest(quantity))
                .retrieve()
                .toBodilessEntity();
            return true;
        } catch (org.springframework.web.client.HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatusCode.valueOf(409)) {
                return false;
            }
            throw e;
        }
    }

    /**
     * Passthrough for the branches (of this product) the caller may see (UC8/UC9) --
     * no branch parameter, since the request is "what can I see", not "show me branch
     * X" (architecture.md §20). Any non-2xx response (e.g. Warehouse Service's 403 for
     * holding neither warehouse-viewer role at all) is left to throw
     * HttpClientErrorException -- the caller relays it as-is, since this read has no
     * business-state outcome to hide behind, unlike reserve()'s 409 handling above.
     */
    public String getWarehouseStock(String inventoryToken, String productId) {
        return restClient.get()
            .uri("/warehouse-stock/{productId}", productId)
            .header("Authorization", "Bearer " + inventoryToken)
            .retrieve()
            .body(String.class);
    }
}
