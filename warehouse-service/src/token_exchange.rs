use serde::Deserialize;

/// Performs RFC 8693 Token Exchange as warehouse-service's own confidential client,
/// downscoping a subject token to a narrower audience/scope.
pub struct TokenExchangeClient {
    token_endpoint: String,
    client_id: String,
    client_secret: String,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
}

impl TokenExchangeClient {
    pub fn new(keycloak_internal_url: &str, client_id: &str, client_secret: &str) -> Self {
        Self {
            token_endpoint: format!("{keycloak_internal_url}/protocol/openid-connect/token"),
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn exchange(&self, subject_token: &str, audience: &str, scope: &str) -> Result<String, String> {
        let params = [
            ("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"),
            ("subject_token", subject_token),
            ("subject_token_type", "urn:ietf:params:oauth:token-type:access_token"),
            ("audience", audience),
            ("scope", scope),
            ("client_id", &self.client_id),
            ("client_secret", &self.client_secret),
        ];

        let resp = self
            .http
            .post(&self.token_endpoint)
            .form(&params)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json::<TokenResponse>()
            .await
            .map_err(|e| e.to_string())?;

        resp.access_token
            .ok_or_else(|| format!("token exchange for audience={audience} failed: {:?}", resp.error))
    }
}
