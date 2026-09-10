package com.example.orderservice;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderRepository orderRepository;
    private final TokenExchangeClient tokenExchangeClient;
    private final InventoryClient inventoryClient;

    public OrderController(OrderRepository orderRepository, TokenExchangeClient tokenExchangeClient,
            InventoryClient inventoryClient) {
        this.orderRepository = orderRepository;
        this.tokenExchangeClient = tokenExchangeClient;
        this.inventoryClient = inventoryClient;
    }

    public record OrderCreateRequest(String customerId, String productId, int quantity) {
    }

    @PostMapping
    @PreAuthorize("hasRole('order-writer')")
    public ResponseEntity<Order> create(@RequestBody OrderCreateRequest request, @AuthenticationPrincipal Jwt jwt) {
        Order order = new Order(request.customerId(), request.productId(), request.quantity());

        // Token Exchange：このユーザーのトークンをinventory-service向けのaudienceへ
        // 絞り込み、実際の在庫引当てはInventory Serviceに依頼する。
        String inventoryToken = tokenExchangeClient.exchange(jwt.getTokenValue(), "inventory-service", "inventory");
        boolean reserved = inventoryClient.reserve(inventoryToken, request.productId(), request.quantity());
        order.setStatus(reserved ? OrderStatus.CONFIRMED : OrderStatus.REJECTED);

        Order saved = orderRepository.save(order);
        return ResponseEntity.status(HttpStatus.CREATED).body(saved);
    }

    @GetMapping
    @PreAuthorize("hasRole('order-writer') or hasRole('order-reader')")
    public List<Order> list() {
        return orderRepository.findAll();
    }

    @GetMapping("/{id}")
    @PreAuthorize("hasRole('order-writer') or hasRole('order-reader')")
    public ResponseEntity<Order> get(@PathVariable UUID id) {
        return orderRepository.findById(id)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
