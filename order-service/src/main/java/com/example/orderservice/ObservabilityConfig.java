package com.example.orderservice;

import io.micrometer.observation.ObservationPredicate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.observation.ServerRequestObservationContext;

@Configuration
public class ObservabilityConfig {

    /**
     * GET /health（composeのヘルスチェック対象で5秒ごとに叩かれる）をHTTPサーバーの
     * observationから除外する。Micrometer TracingがこれをOTelトレースへブリッジする
     * ため、除外しないとservice graphが呼び出し元不明のノードで埋め尽くされる。
     * このBean型はObservationRegistry（Spring Bootのobservability機能）へ自動登録
     * される。falseを返すことが「これは計測しない」を意味する。
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
