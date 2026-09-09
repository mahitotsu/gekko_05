use opentelemetry::global;
use opentelemetry_http::HeaderInjector;
use serde::Deserialize;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;

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

        // No axum layer wraps this outgoing call (unlike the inbound side, which
        // OtelAxumLayer handles) -- axum-tracing-opentelemetry only instruments
        // incoming requests, and reqwest has no auto-instrumentation of its own here
        // (see main.rs's "hyper-client" note on why: pulling in a reqwest-tracing
        // crate new enough to speak this project's opentelemetry 0.32/tracing-opentelemetry
        // 0.33 would force a reqwest 0.13 bump -- and 0.13's rustls needs aws-lc-rs,
        // i.e. cmake, in the musl/alpine build; the version of reqwest-tracing that
        // stays on reqwest 0.12 tops out at opentelemetry 0.26, which axum-tracing-opentelemetry
        // 0.39 can't build against either). So this call is instead: (a) wrapped in an
        // explicit CLIENT span (so it shows correctly in Tempo's service graph, whose
        // client/server-pairing algorithm needs one -- an inbound-only SERVER span,
        // otherwise, reads as caller-less), and (b) has the current span's context
        // injected into the request as a W3C `traceparent` header by hand, exactly
        // like the employee-service call in handlers.rs already does.
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
