package com.example.orderservice;

import io.micrometer.observation.ObservationPredicate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.observation.ServerRequestObservationContext;

@Configuration
public class ObservabilityConfig {

    /**
     * Excludes GET /health (the compose healthcheck target, hit every 5s) from HTTP
     * server observations -- and therefore from the OTel traces Micrometer Tracing
     * bridges them into -- so the service graph isn't flooded with a caller-less node.
     * Beans of this type are auto-registered on the ObservationRegistry (Spring Boot's
     * Observability support); returning false means "don't observe this one".
     */
    @Bean
    public ObservationPredicate noHealthCheckObservations() {
        return (name, context) -> {
            if (context instanceof ServerRequestObservationContext serverContext) {
                return !serverContext.getCarrier().getRequestURI().equals("/health");
            }
            return true;
        };
    }
}
