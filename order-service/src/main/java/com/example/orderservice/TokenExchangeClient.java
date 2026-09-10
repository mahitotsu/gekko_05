package com.example.orderservice;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;

/**
 * order-service自身の機密クライアントとしてRFC 8693 Token Exchangeを実行し、
 * ユーザーのトークンを下流呼び出し向けのより狭いaudience/scopeへ絞り込む。
 */
@Component
public class TokenExchangeClient {

    private static final String GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
    private static final String TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

    private final RestClient restClient;
    private final String clientId;
    private final String clientSecret;

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

    public String exchange(String subjectToken, String audience, String scope) {
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
        return response.access_token();
    }

    private record TokenResponse(String access_token) {
    }
}
