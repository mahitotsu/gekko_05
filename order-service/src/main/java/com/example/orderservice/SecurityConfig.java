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
            // Must run after BearerTokenAuthenticationFilter: it needs the JWT already
            // authenticated (to read cnf.jkt) plus the raw token value (to check ath).
            .addFilterAfter(dpopValidationFilter, BearerTokenAuthenticationFilter.class);
        return http.build();
    }

    /**
     * The frontend sends `Authorization: DPoP <token>` (the token_type Keycloak issues
     * for a DPoP-bound token), which Spring's default resolver -- hardcoded to the
     * "Bearer" scheme -- wouldn't recognize. This accepts either scheme for extracting
     * the raw token; DpopValidationFilter is what actually enforces the DPoP proof.
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
     * JWKS is fetched from the internal docker-network hostname (order-service always
     * talks to Keycloak over the internal network), but the expected `iss` claim is
     * validated separately against the externally-visible issuer. Keycloak's `iss` claim
     * reflects whatever host/port the token requester used, which for browser/host-machine
     * clients is not the same as the internal docker hostname order-service resolves.
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
     * Maps Keycloak's realm_access.roles claim to Spring Security authorities
     * (ROLE_xxx), so @PreAuthorize("hasRole('order-writer')") works directly.
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
