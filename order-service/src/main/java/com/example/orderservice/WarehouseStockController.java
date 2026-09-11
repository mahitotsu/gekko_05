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
 * UC8/UC9（docs/use-cases.md）：物流部門向けの全支店在庫照会画面。意図的に
 * @PreAuthorizeを持たない。支店レベルのアクセス制御（warehouse-viewer/-all、ABACの
 * 支店一致判定）はorder-serviceの守備範囲ではなく（services.mdが定義する自身の
 * 提供機能は受注登録/受注照会のみ）、Warehouse Service単独の権威である
 * （services.md：「組織的に独立した拠点システム」）。order-serviceがこのリクエストの
 * 最初のホップになるのは、委任トポロジー上frontendが他に到達手段を持たないためで
 * あり（permission-matrix.md 表1）、order-service自身がここで行使すべき権限がある
 * からではない。order-writer/order-readerで絞るのも同様に誤り（UC8のペルソナである
 * sato-logisticsはどちらも持たない）、warehouse-viewer(-all)で絞るのも
 * （このファイルの旧版がまさにそうしていた）Warehouse Service自身のRBACの二重実装
 * になり、そちら側のロール体系が変われば静かに陳腐化する（docs/backlog.mdに起票、
 * architecture.md §20で解消済み）。したがって：認証のみ行い（SecurityConfigの
 * `.anyRequest().authenticated()`で既に強制済み）、中継に徹する。判断はチェーン上の
 * 権威（Warehouse Service）に委ね、その拒否結果をそのまま伝播させる。
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
        String inventoryToken = tokenExchangeClient.exchange(jwt, "inventory-service", "inventory");
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
