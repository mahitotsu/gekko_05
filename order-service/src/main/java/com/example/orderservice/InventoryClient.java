package com.example.orderservice;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

/**
 * TokenExchangeClientが既にinventory-service向けaudienceへ交換済みのトークンを使い、
 * Inventory Serviceの引当てエンドポイントを呼び出す。
 */
@Component
public class InventoryClient {

    private final RestClient restClient;

    public InventoryClient(
            @Value("${app.inventory-service.base-url}") String baseUrl,
            RestClient.Builder restClientBuilder) {
        // Spring が自動構成する RestClient.Builder（Micrometer の ObservationRegistry が
        // 組み込み済み）を使う。発信呼び出しが自動計装のOTelスパンとW3C traceparent
        // 伝播を持つようにするためで、素の RestClient.builder() は使わない。
        this.restClient = restClientBuilder.baseUrl(baseUrl).build();
    }

    public record ReserveRequest(int quantity) {
    }

    /**
     * @return 引当てに成功した場合はtrue、在庫不足(409)の場合はfalse。
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
        } catch (HttpClientErrorException e) {
            if (e.getStatusCode() == HttpStatus.CONFLICT) {
                return false;
            }
            throw e;
        }
    }

    /**
     * 呼び出し元が閲覧可能な支店（この商品について、UC8/UC9）をそのまま中継する。
     * 「支店Xを見せろ」ではなく「自分に何が見えるか」を問う設計のため支店パラメータは
     * 持たない（architecture.md §20）。2xx以外のレスポンス（例：warehouse-viewer系の
     * ロールを一切持たない場合のWarehouse Serviceの403）はHttpClientErrorException
     * としてそのままthrowさせる。上のreserve()の409処理と異なり、この照会には裏に
     * 隠すべき業務上の結果が無いため、呼び出し元はエラーをそのまま中継すればよい。
     */
    public String getWarehouseStock(String inventoryToken, String productId) {
        return restClient.get()
            .uri("/warehouse-stock/{productId}", productId)
            .header("Authorization", "Bearer " + inventoryToken)
            .retrieve()
            .body(String.class);
    }
}
