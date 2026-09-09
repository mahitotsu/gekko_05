package com.example.orderservice;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;

/**
 * Performs RFC 8693 Token Exchange as order-service's own confidential client,
 * downscoping a user's token to a narrower audience/scope for a downstream call.
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
        // Use Spring's auto-configured RestClient.Builder (wired with Micrometer's
        // ObservationRegistry) so the token-exchange call to Keycloak gets an
        // auto-instrumented OTel span, instead of a fresh RestClient.builder().
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
