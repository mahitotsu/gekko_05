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

// jwksCacheはKeycloakの署名鍵を保持する。プロセス起動時に一度だけ取得するのではなく、
// 見覚えのないkidを持つトークンが来たとき（例：Keycloakが再起動で鍵をローテーション
// した後）にオンデマンドで再取得する。minIntervalは再取得をレート制限しており、偽の
// kidを送りつけ続けることでKeycloakへの鍵検索が自己誘発的なDoSと化すのを防ぐ。
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

// authMiddlewareはbearerトークンの署名・issuer・audienceを検証したうえで、
// requiredRolesが空でなければ、呼び出し元がそのうち少なくとも1つのrealmロール
// （realm_access.roles）を持つことを要求する。requiredRolesがnil/空の場合は、この
// ルート自身がチェックすべきロールを持たないことを意味する——認証のみがゲートであり、
// この先で行使される権限は完全に下流の責務になる（main.goの/warehouse-stock登録と
// architecture.md §20を参照）。
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

		// ロールチェックより前に設定する：この時点でトークン自体は正当（正規の
		// Token Exchangeの結果）なので、ロール不足で拒否される場合でもアクセス
		// ログにはsub/jtiを記録すべきである。そうしないと、ここでの403が監査の
		// jtiベースのチェック上、トークンが素通り／欠落した場合と区別できなく
		// なってしまう。
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

// logAuthzDenyは構造化された`authz_deny`ログ行を出力する。accessLogMiddlewareの
// リクエストごとのログ行（status/pathを持つが「なぜ」を問い合わせ可能なフィールド
// としては持たない、例：POST /inventory/{id}/reserveの403）とは別に出す。意図的に
// DENYのみを記録する：これは判断を下した当のコード自身が書く自己申告ログであり
// （§10のKeycloak対access_logのjti/TOKEN_EXCHANGE突合とは異なり）判断を検証する
// 独立した第二のソースを持たず、PERMITが正しかったことを立証する力もない
// （architecture.md §19参照）。その価値は異常の兆候検知とサポート用デバッグに
// 限られ、監査ではない。フィールドはaccess_logのsub/jti/trace_idと揃えており、
// 両者を突合できる（permission-matrix.md 表3）。
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
