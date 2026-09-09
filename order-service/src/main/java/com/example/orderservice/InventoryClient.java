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
}
