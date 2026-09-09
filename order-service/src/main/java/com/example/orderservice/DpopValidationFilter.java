package com.example.orderservice;

import com.nimbusds.jose.crypto.ECDSAVerifier;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jwt.SignedJWT;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;

/**
 * Validates the RFC 9449 DPoP proof for requests carrying a DPoP-bound access token
 * (cnf.jkt claim present). Runs after JWT authentication, since it needs both the raw
 * bearer token (to check `ath`) and the authenticated JWT's `cnf.jkt` claim.
 *
 * Demo-scale simplification: no `jti` replay cache, so a captured (proof, token) pair
 * could be replayed within the ~60s iat window this checks. A production system would
 * track seen `jti`s (e.g. in Redis with a TTL matching the window) to close that gap.
 */
@Component
public class DpopValidationFilter extends OncePerRequestFilter {

    private static final long IAT_TOLERANCE_SECONDS = 60;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {

        var authentication = SecurityContextHolder.getContext().getAuthentication();
        if (!(authentication instanceof JwtAuthenticationToken jwtAuth)) {
            chain.doFilter(request, response);
            return;
        }

        Jwt jwt = jwtAuth.getToken();
        Map<String, Object> cnf = jwt.getClaim("cnf");
        if (cnf == null || cnf.get("jkt") == null) {
            // Token isn't DPoP-bound; nothing to check here.
            chain.doFilter(request, response);
            return;
        }
        String expectedThumbprint = (String) cnf.get("jkt");

        String proofHeader = request.getHeader("DPoP");
        if (proofHeader == null) {
            reject(response, "DPoP proof is missing for a DPoP-bound token");
            return;
        }

        try {
            SignedJWT proof = SignedJWT.parse(proofHeader);

            if (!"dpop+jwt".equals(proof.getHeader().getType().getType())) {
                reject(response, "DPoP proof has wrong typ header");
                return;
            }

            ECKey publicKey = proof.getHeader().getJWK().toECKey();
            if (!proof.verify(new ECDSAVerifier(publicKey))) {
                reject(response, "DPoP proof signature is invalid");
                return;
            }

            String actualThumbprint = publicKey.computeThumbprint().toString();
            if (!actualThumbprint.equals(expectedThumbprint)) {
                reject(response, "DPoP proof key does not match the token's cnf.jkt");
                return;
            }

            var claims = proof.getJWTClaimsSet();

            if (!request.getMethod().equals(claims.getStringClaim("htm"))) {
                reject(response, "DPoP proof htm does not match the request method");
                return;
            }
            if (!requestUrl(request).equals(claims.getStringClaim("htu"))) {
                reject(response, "DPoP proof htu does not match the request URL");
                return;
            }

            Instant iat = claims.getIssueTime().toInstant();
            if (iat.isBefore(Instant.now().minusSeconds(IAT_TOLERANCE_SECONDS))
                    || iat.isAfter(Instant.now().plusSeconds(IAT_TOLERANCE_SECONDS))) {
                reject(response, "DPoP proof iat is outside the acceptable window");
                return;
            }

            String expectedAth = base64UrlSha256(jwt.getTokenValue());
            if (!expectedAth.equals(claims.getStringClaim("ath"))) {
                reject(response, "DPoP proof ath does not match the presented access token");
                return;
            }
        } catch (Exception e) {
            reject(response, "DPoP proof could not be validated: " + e.getMessage());
            return;
        }

        chain.doFilter(request, response);
    }

    private String requestUrl(HttpServletRequest request) {
        return request.getRequestURL().toString();
    }

    private String base64UrlSha256(String value) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
    }

    private void reject(HttpServletResponse response, String message) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.getWriter().write(message);
    }
}
