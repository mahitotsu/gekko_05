use opentelemetry::global;
use opentelemetry_http::HeaderInjector;
use serde::Deserialize;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;

/// warehouse-service自身の機密クライアントとしてRFC 8693 Token Exchangeを実行し、
/// subject tokenをより狭いaudience/scopeへ絞り込む。
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

        // この発信呼び出しにはaxumのレイヤーが掛かっていない（受信側はOtelAxumLayer
        // が計装するが、axum-tracing-opentelemetryは受信のみが対象で、reqwestにも
        // この経路の自動計装は無い。依存バージョンの制約でreqwest-tracingクレートが
        // 使えない事情はdocs/insights.md参照）。そこで、(a) 明示的なCLIENTスパンで
        // 包み（Tempoのservice graphはCLIENT/SERVERのペアを要求するため。受信のみの
        // SERVERスパンだと呼び出し元不明に見える）、(b) 現在のスパンのcontextを
        // W3C `traceparent`ヘッダーとして手動で注入する——handlers.rsの
        // employee-service呼び出しと同じ手法。
        let span = tracing::info_span!(
            "keycloak.token_exchange",
            "otel.kind" = "client",
            "otel.name" = %format!("POST {}", self.token_endpoint),
            "http.method" = "POST",
            "http.url" = %self.token_endpoint,
        );
        let resp = async {
            let mut trace_headers = reqwest::header::HeaderMap::new();
            let cx = tracing::Span::current().context();
            global::get_text_map_propagator(|propagator| {
                propagator.inject_context(&cx, &mut HeaderInjector(&mut trace_headers));
            });

            self.http
                .post(&self.token_endpoint)
                .headers(trace_headers)
                .form(&params)
                .send()
                .await
        }
        .instrument(span)
        .await
        .map_err(|e| e.to_string())?
        .json::<TokenResponse>()
        .await
        .map_err(|e| e.to_string())?;

        resp.access_token
            .ok_or_else(|| format!("token exchange for audience={audience} failed: {:?}", resp.error))
    }
}
