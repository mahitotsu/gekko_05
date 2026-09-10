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
 * DPoP-boundなアクセストークン（cnf.jktクレームを持つ）が付いたリクエストについて、
 * RFC 9449のDPoP Proofを検証する。JWT認証の後段で実行する：生のbearerトークン値
 * （`ath`の検証用）と、認証済みJWTの`cnf.jkt`クレームの両方が必要なため。
 *
 * デモ規模での簡略化：`jti`のリプレイキャッシュを持たないため、捕捉された
 * (proof, token)のペアはここで検証している約60秒のiatウィンドウ内であれば再送
 * されうる。本番システムでは、見たことのある`jti`を（例えばこのウィンドウに合わせた
 * TTLでRedisに）記録し、この穴を塞ぐ必要がある。
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
            // DPoP-boundなトークンではないため、ここでは何も検証しない。
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
