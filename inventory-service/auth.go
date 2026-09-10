package main

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const audience = "inventory-service"

type jwkSet struct {
	Keys []struct {
		Kid string `json:"kid"`
		Kty string `json:"kty"`
		N   string `json:"n"`
		E   string `json:"e"`
	} `json:"keys"`
}

// jwksCache holds Keycloak's signing keys, refetched on demand when a token presents a
// kid we don't recognize (e.g. after Keycloak rotates its keys on a restart) rather than
// only once at process startup. minInterval rate-limits refetches so a stream of bogus
// kids can't turn key lookups into a self-inflicted DoS against Keycloak.
type jwksCache struct {
	mu          sync.RWMutex
	keys        map[string]*rsa.PublicKey
	jwksURL     string
	lastFetch   time.Time
	minInterval time.Duration
}

func newJWKSCache(jwksURL string) (*jwksCache, error) {
	c := &jwksCache{jwksURL: jwksURL, minInterval: 10 * time.Second}
	if err := c.refresh(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *jwksCache) refresh() error {
	resp, err := http.Get(c.jwksURL)
	if err != nil {
		return fmt.Errorf("fetching JWKS: %w", err)
	}
	defer resp.Body.Close()

	var set jwkSet
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return fmt.Errorf("decoding JWKS: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey)
	for _, k := range set.Keys {
		if k.Kty != "RSA" {
			continue
		}
		nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			continue
		}
		eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{
			N: new(big.Int).SetBytes(nBytes),
			E: int(new(big.Int).SetBytes(eBytes).Int64()),
		}
	}

	c.mu.Lock()
	c.keys = keys
	c.lastFetch = time.Now()
	c.mu.Unlock()
	return nil
}

func (c *jwksCache) keyfunc(token *jwt.Token) (interface{}, error) {
	kid, _ := token.Header["kid"].(string)

	c.mu.RLock()
	key, ok := c.keys[kid]
	staleEnough := time.Since(c.lastFetch) >= c.minInterval
	c.mu.RUnlock()
	if ok {
		return key, nil
	}
	if !staleEnough {
		return nil, fmt.Errorf("unknown kid: %s", kid)
	}

	if err := c.refresh(); err != nil {
		return nil, fmt.Errorf("unknown kid: %s (refresh failed: %w)", kid, err)
	}

	c.mu.RLock()
	key, ok = c.keys[kid]
	c.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown kid: %s", kid)
	}
	return key, nil
}

// authMiddleware validates the bearer token's signature, issuer and audience, then, if
// requiredRoles is non-empty, requires the caller to hold at least one of those realm
// roles (realm_access.roles). A nil/empty requiredRoles means this route has no role of
// its own to check -- authentication alone gates it, and authority for whatever happens
// next lives entirely downstream (see /warehouse-stock's registration in main.go and
// architecture.md §20).
func authMiddleware(keyfunc jwt.Keyfunc, issuer string, requiredRoles []string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		rawToken := strings.TrimPrefix(authHeader, "Bearer ")

		parser := jwt.NewParser(jwt.WithIssuer(issuer), jwt.WithAudience(audience))
		token, err := parser.Parse(rawToken, keyfunc)
		if err != nil || !token.Valid {
			http.Error(w, "invalid token: "+errString(err), http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			http.Error(w, "invalid claims", http.StatusUnauthorized)
			return
		}

		// Set before the role check: the token itself is valid at this point (a
		// legitimate Token Exchange result), so the access log should still record
		// sub/jti even when the request is denied for insufficient role -- otherwise
		// a 403 here would be indistinguishable from a bypassed/absent token in the
		// audit's jti-based checks.
		r.Header.Set("X-Subject", subjectFrom(claims))
		r.Header.Set("X-Jti", jtiFrom(claims))

		if len(requiredRoles) > 0 && !hasAnyRole(claims, requiredRoles) {
			logAuthzDeny(r.Context(), claims, "role_missing", requiredRoles)
			http.Error(w, "insufficient role", http.StatusForbidden)
			return
		}

		next(w, r)
	}
}

// logAuthzDeny emits a structured `authz_deny` log line, separate from
// accessLogMiddleware's per-request line: the latter carries status/path (403 on
// POST /inventory/{id}/reserve) but not *why* in a queryable field. DENY-only,
// deliberately: this is a self-reported log written by the same code whose judgment it
// describes, so (unlike §10's Keycloak-vs-access_log jti/TOKEN_EXCHANGE cross-check) it
// has no independent second source to verify a decision against, and can't prove a
// PERMIT was correct -- see architecture.md §19. Its value is limited to anomaly triage
// and support debugging, not audit. Fields mirror access_log's sub/jti/trace_id so the
// two correlate (permission-matrix.md 表3).
func logAuthzDeny(ctx context.Context, claims jwt.MapClaims, reason string, requiredRoles []string) {
	entry := struct {
		Type          string   `json:"type"`
		Sub           string   `json:"sub"`
		Jti           string   `json:"jti"`
		TraceID       string   `json:"trace_id"`
		Reason        string   `json:"reason"`
		RequiredRoles []string `json:"required_roles"`
	}{
		Type:          "authz_deny",
		Sub:           subjectFrom(claims),
		Jti:           jtiFrom(claims),
		TraceID:       traceIDFromContext(ctx),
		Reason:        reason,
		RequiredRoles: requiredRoles,
	}
	line, _ := json.Marshal(entry)
	os.Stdout.Write(append(line, '\n'))
}

func hasAnyRole(claims jwt.MapClaims, required []string) bool {
	realmAccess, _ := claims["realm_access"].(map[string]interface{})
	if realmAccess == nil {
		return false
	}
	roles, _ := realmAccess["roles"].([]interface{})
	for _, r := range roles {
		roleName, _ := r.(string)
		for _, req := range required {
			if roleName == req {
				return true
			}
		}
	}
	return false
}

func subjectFrom(claims jwt.MapClaims) string {
	sub, _ := claims["sub"].(string)
	return sub
}

func jtiFrom(claims jwt.MapClaims) string {
	jti, _ := claims["jti"].(string)
	if jti == "" {
		return "-"
	}
	return jti
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
