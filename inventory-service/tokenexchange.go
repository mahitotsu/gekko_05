package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// TokenExchangeClientはinventory-service自身の機密クライアントとしてRFC 8693
// Token Exchangeを実行し、subject tokenをより狭いaudience/scopeへ絞り込む。
type TokenExchangeClient struct {
	tokenEndpoint string
	clientID      string
	clientSecret  string
}

func NewTokenExchangeClient(keycloakInternalURL, clientID, clientSecret string) *TokenExchangeClient {
	return &TokenExchangeClient{
		tokenEndpoint: keycloakInternalURL + "/protocol/openid-connect/token",
		clientID:      clientID,
		clientSecret:  clientSecret,
	}
}

func (c *TokenExchangeClient) Exchange(ctx context.Context, subjectToken, audience, scope string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange")
	form.Set("subject_token", subjectToken)
	form.Set("subject_token_type", "urn:ietf:params:oauth:token-type:access_token")
	form.Set("audience", audience)
	form.Set("scope", scope)
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("building token request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := tracedHTTPClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("calling token endpoint: %w", err)
	}
	defer resp.Body.Close()

	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("decoding token response: %w", err)
	}
	if body.AccessToken == "" {
		return "", fmt.Errorf("token exchange for audience=%s failed: %s", audience, body.Error)
	}
	return body.AccessToken, nil
}
