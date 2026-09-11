package com.example.orderservice;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * order-service自身の機密クライアントとしてRFC 8693 Token Exchangeを実行し、
 * ユーザーのトークンを下流呼び出し向けのより狭いaudience/scopeへ絞り込む。
 *
 * 交換結果は(subjectトークンのjti, audience)をキーにキャッシュし、有効期限
 * （`expires_in`、委任チェーンの中継トークンは60秒に短縮済み。
 * architecture.md §11）が切れるまで同じトークンを使い回す。監査
 * （audit/audit.py CHECK2）はリクエストごとのtrace_idではなく(jti, audience)の
 * 組でKeycloakの発行記録と突合するため、キャッシュされたトークンが複数
 * リクエストに跨って再利用されても正当なアクセスとして扱われる
 * （docs/adr/0012参照）。
 */
@Component
public class TokenExchangeClient {

    private static final String GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
    private static final String TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
    // トークンの実際の有効期限より少し早めに再交換する。ネットワーク遅延や
    // クロックずれがあっても、キャッシュから返した直後に下流サービス側で
    // 期限切れとして拒否される事態を避けるための安全マージン。
    private static final int CACHE_SAFETY_MARGIN_SECONDS = 5;

    private final RestClient restClient;
    private final String clientId;
    private final String clientSecret;
    // このBeanはシングルトンとして全リクエストで共有されるため、並行アクセスに
    // 安全なMapが必要。
    private final Map<CacheKey, CachedToken> cache = new ConcurrentHashMap<>();

    public TokenExchangeClient(
            @Value("${app.keycloak.internal-url}") String keycloakInternalUrl,
            @Value("${app.order-service.client-id}") String clientId,
            @Value("${app.order-service.client-secret}") String clientSecret,
            RestClient.Builder restClientBuilder) {
        // Spring が自動構成する RestClient.Builder（Micrometer の ObservationRegistry が
        // 組み込み済み）を使う。KeycloakへのToken Exchange呼び出しが自動計装のOTel
        // スパンを持つようにするためで、素の RestClient.builder() は使わない。
        this.restClient = restClientBuilder
            .baseUrl(keycloakInternalUrl + "/protocol/openid-connect/token")
            .build();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
    }

    public String exchange(Jwt subjectJwt, String audience, String scope) {
        CacheKey key = new CacheKey(subjectJwt.getId(), audience);
        CachedToken cached = cache.get(key);
        if (cached != null && cached.expiresAt().isAfter(Instant.now())) {
            return cached.accessToken();
        }

        TokenResponse response = requestExchange(subjectJwt.getTokenValue(), audience, scope);
        Instant expiresAt = Instant.now().plusSeconds(response.expires_in() - CACHE_SAFETY_MARGIN_SECONDS);
        cache.put(key, new CachedToken(response.access_token(), expiresAt));
        return response.access_token();
    }

    private TokenResponse requestExchange(String subjectToken, String audience, String scope) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", GRANT_TYPE);
        form.add("subject_token", subjectToken);
        form.add("subject_token_type", TOKEN_TYPE);
        form.add("audience", audience);
        form.add("scope", scope);
        form.add("client_id", clientId);
        form.add("client_secret", clientSecret);

        TokenResponse response = restClient.post()
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
            .body(form)
            .retrieve()
            .body(TokenResponse.class);

        if (response == null || response.access_token() == null) {
            throw new IllegalStateException("Token exchange for audience=" + audience + " returned no access_token");
        }
        return response;
    }

    private record CacheKey(String subjectJti, String audience) {
    }

    private record CachedToken(String accessToken, Instant expiresAt) {
    }

    private record TokenResponse(String access_token, int expires_in) {
    }
}
