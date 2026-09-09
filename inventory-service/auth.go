package main

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"

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

// fetchJWKS fetches Keycloak's signing keys once at startup and builds a jwt.Keyfunc.
// A demo-scale simplification: keys are cached for the process lifetime, no rotation handling.
func fetchJWKS(jwksURL string) (jwt.Keyfunc, error) {
	resp, err := http.Get(jwksURL)
	if err != nil {
		return nil, fmt.Errorf("fetching JWKS: %w", err)
	}
	defer resp.Body.Close()

	var set jwkSet
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return nil, fmt.Errorf("decoding JWKS: %w", err)
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

	return func(token *jwt.Token) (interface{}, error) {
		kid, _ := token.Header["kid"].(string)
		key, ok := keys[kid]
		if !ok {
			return nil, fmt.Errorf("unknown kid: %s", kid)
		}
		return key, nil
	}, nil
}

// authMiddleware validates the bearer token's signature, issuer and audience, then
// requires the caller to hold at least one of the given realm roles (realm_access.roles).
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

		if !hasAnyRole(claims, requiredRoles) {
			http.Error(w, "insufficient role", http.StatusForbidden)
			return
		}

		r.Header.Set("X-Subject", subjectFrom(claims))
		next(w, r)
	}
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

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
