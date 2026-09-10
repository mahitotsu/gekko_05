package com.example.orderservice;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.web.BearerTokenResolver;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    private static final String AUDIENCE = "order-service";

    @Value("${app.keycloak.internal-url}")
    private String keycloakInternalUrl;

    @Value("${app.keycloak.issuer}")
    private String keycloakIssuer;

    private final DpopValidationFilter dpopValidationFilter;

    public SecurityConfig(DpopValidationFilter dpopValidationFilter) {
        this.dpopValidationFilter = dpopValidationFilter;
    }

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(AbstractHttpConfigurer::disable)
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/health").permitAll()
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2
                .bearerTokenResolver(dpopAwareBearerTokenResolver())
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter())))
            // BearerTokenAuthenticationFilterより後段で実行する必要がある：cnf.jktを
            // 読むにはJWTが認証済みであること、athの検証には生のトークン値が必要。
            .addFilterAfter(dpopValidationFilter, BearerTokenAuthenticationFilter.class);
        return http.build();
    }

    /**
     * frontendは`Authorization: DPoP <token>`（Keycloakが DPoP-bound トークンに対して
     * 発行するtoken_type）で送ってくる。Springの既定のリゾルバは"Bearer"スキームに
     * 固定されておりこれを認識できないため、両方のスキームを受け付けて生のトークン値を
     * 取り出す。DPoP Proofの実際の検証はDpopValidationFilterが担う。
     */
    private BearerTokenResolver dpopAwareBearerTokenResolver() {
        return request -> {
            String header = request.getHeader("Authorization");
            if (header == null) {
                return null;
            }
            for (String scheme : List.of("Bearer ", "DPoP ")) {
                if (header.startsWith(scheme)) {
                    return header.substring(scheme.length());
                }
            }
            return null;
        };
    }

    /**
     * JWKSはdockerネットワーク内部のホスト名から取得する（order-serviceは常に内部
     * ネットワーク経由でKeycloakと通信する）が、期待する`iss`クレームの検証はこれとは
     * 別に、外部から見えるissuer値に対して行う。Keycloakの`iss`クレームはトークンを
     * 要求した側が使ったホスト/ポートをそのまま反映するため、ブラウザ／ホストマシン側の
     * クライアントにとってのそれは、order-serviceが名前解決するdocker内部ホスト名とは
     * 一致しない。
     */
    @Bean
    JwtDecoder jwtDecoder() {
        NimbusJwtDecoder decoder = NimbusJwtDecoder
            .withJwkSetUri(keycloakInternalUrl + "/protocol/openid-connect/certs")
            .build();

        OAuth2TokenValidator<Jwt> validator = JwtValidators.createDefaultWithValidators(
            new JwtTimestampValidator(),
            new JwtIssuerValidator(keycloakIssuer),
            audienceValidator()
        );
        decoder.setJwtValidator(validator);
        return decoder;
    }

    private OAuth2TokenValidator<Jwt> audienceValidator() {
        return token -> {
            List<String> audience = token.getAudience();
            if (audience != null && audience.contains(AUDIENCE)) {
                return OAuth2TokenValidatorResult.success();
            }
            return OAuth2TokenValidatorResult.failure(
                new OAuth2Error("invalid_token", "Required audience '" + AUDIENCE + "' is missing", null));
        };
    }

    /**
     * Keycloakのrealm_access.rolesクレームをSpring Securityの権限表現(ROLE_xxx)へ
     * マッピングする。これにより@PreAuthorize("hasRole('order-writer')")がそのまま
     * 使えるようになる。
     */
    private JwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(this::realmRolesToAuthorities);
        return converter;
    }

    @SuppressWarnings("unchecked")
    private Collection<GrantedAuthority> realmRolesToAuthorities(Jwt jwt) {
        Map<String, Object> realmAccess = jwt.getClaim("realm_access");
        if (realmAccess == null || !(realmAccess.get("roles") instanceof List<?> roles)) {
            return List.of();
        }
        return roles.stream()
            .map(role -> new SimpleGrantedAuthority("ROLE_" + role))
            .collect(Collectors.toList());
    }
}
