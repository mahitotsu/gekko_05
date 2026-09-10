mod auth;
mod handlers;
mod token_exchange;

use axum::{extract::Request, middleware, middleware::Next, response::Response, routing::{get, post}, Router};
use serde_json::json;
use axum_tracing_opentelemetry::middleware::{OtelAxumLayer, OtelInResponseLayer};
use opentelemetry::global;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::runtime;
use opentelemetry_sdk::trace::span_processor_with_async_runtime::BatchSpanProcessor;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use std::env;
use std::sync::Arc;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

fn getenv(key: &str, fallback: &str) -> String {
    env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// Wires up OpenTelemetry: an OTLP/HTTP span exporter, a batch tracer provider tagged
/// with `service.name`, W3C traceparent propagation, and a `tracing` subscriber whose
/// spans are bridged to OTel. Returns the provider so the caller keeps it alive for the
/// process lifetime (dropping it flushes and shuts down the exporter).
pub(crate) fn current_trace_id() -> String {
    use opentelemetry::trace::TraceContextExt;
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    let ctx = tracing::Span::current().context();
    let span = ctx.span();
    let span_ctx = span.span_context();
    if span_ctx.is_valid() {
        span_ctx.trace_id().to_string()
    } else {
        "-".to_string()
    }
}

async fn access_log_middleware(request: Request, next: Next) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let (sub, jti) = request
        .extensions()
        .get::<auth::Claims>()
        .map(|c| (c.sub.clone(), c.jti.clone().unwrap_or_else(|| "-".to_string())))
        .unwrap_or_else(|| ("-".to_string(), "-".to_string()));
    let start = std::time::Instant::now();

    let response = next.run(request).await;

    // Write flat JSON directly to stdout so the structure matches other services
    // (tracing's JSON format nests structured fields under "fields", breaking
    // cross-service LogQL queries that filter by top-level type="access_log").
    let entry = json!({
        "type": "access_log",
        "method": method,
        "path": path,
        "status": response.status().as_u16(),
        "duration_ms": start.elapsed().as_millis(),
        "sub": sub,
        "jti": jti,
        "trace_id": current_trace_id(),
    });
    println!("{}", entry);

    response
}

fn init_telemetry(service_name: &str, otlp_endpoint: &str) -> SdkTracerProvider {
    // Propagator shared by the incoming-request middleware (extracts `traceparent`) and
    // the outgoing reqwest calls (inject `traceparent`), so traces connect across services.
    global::set_text_map_propagator(TraceContextPropagator::new());

    // opentelemetry-otlp's HTTP exporter only auto-appends the signal path (`/v1/traces`)
    // when the endpoint comes from the environment; a programmatically supplied endpoint is
    // used verbatim. OTEL_EXPORTER_OTLP_ENDPOINT is a base URL, so append the path ourselves.
    let traces_endpoint = format!("{}/v1/traces", otlp_endpoint.trim_end_matches('/'));
    let exporter = SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(traces_endpoint)
        .build()
        .expect("failed to build OTLP span exporter");

    // The hyper-based OTLP exporter needs an async Tokio context to run in, unlike
    // the default with_batch_exporter()'s plain-OS-thread processor -- use the
    // Tokio-integrated BatchSpanProcessor instead (see rt-tokio note in Cargo.toml).
    let batch_processor = BatchSpanProcessor::builder(exporter, runtime::Tokio).build();
    let provider = SdkTracerProvider::builder()
        .with_span_processor(batch_processor)
        .with_resource(
            Resource::builder()
                .with_service_name(service_name.to_string())
                .build(),
        )
        .build();

    let tracer = provider.tracer("warehouse-service");
    global::set_tracer_provider(provider.clone());

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        // JSON format: structured fields in tracing events become JSON keys,
        // and ANSI colour codes are absent (no terminal formatting in JSON mode).
        .with(tracing_subscriber::fmt::layer().json())
        .with(tracing_opentelemetry::layer().with_tracer(tracer))
        .init();

    provider
}

#[tokio::main]
async fn main() {
    let otel_endpoint = getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    let service_name = getenv("OTEL_SERVICE_NAME", "warehouse-service");
    // Held until the end of main so the batch span processor stays alive for the whole run.
    let _tracer_provider = init_telemetry(&service_name, &otel_endpoint);

    let keycloak_internal_url = getenv("KEYCLOAK_INTERNAL_URL", "http://localhost:8080/realms/kikan-system");
    let keycloak_issuer = getenv("KEYCLOAK_ISSUER", "http://localhost:8080/realms/kikan-system");
    let client_id = getenv("WAREHOUSE_SERVICE_CLIENT_ID", "warehouse-service");
    let client_secret = getenv("WAREHOUSE_SERVICE_CLIENT_SECRET", "warehouse-service-secret");
    let redis_url = getenv("REDIS_URL", "redis://localhost:6379");
    let employee_service_base_url = getenv("EMPLOYEE_SERVICE_BASE_URL", "http://localhost:8084");

    let jwks_url = format!("{keycloak_internal_url}/protocol/openid-connect/certs");
    let auth_ctx = auth::build_auth_context(&jwks_url, &keycloak_issuer, "warehouse-service")
        .await
        .expect("failed to fetch JWKS from Keycloak");

    let redis_client = redis::Client::open(redis_url).expect("invalid redis url");

    let token_exchange = token_exchange::TokenExchangeClient::new(&keycloak_internal_url, &client_id, &client_secret);
    let state = Arc::new(handlers::AppState {
        redis: redis_client,
        token_exchange,
        employee_service_base_url,
        http: reqwest::Client::new(),
    });

    let protected = Router::new()
        // UC8/UC9: no :branch segment -- see get_stock_by_branches and architecture.md §20.
        .route("/warehouse/stock/:product_id", get(handlers::get_stock_by_branches))
        .route("/warehouse/:branch/stock/:product_id/reserve", post(handlers::reserve_stock))
        // Axum: last .layer() is outermost (runs first). auth runs first and inserts
        // Claims into extensions; access_log runs second and reads those Claims.
        .layer(middleware::from_fn(access_log_middleware))
        .layer(middleware::from_fn_with_state(auth_ctx, auth::auth_middleware))
        .with_state(state);

    let app = Router::new()
        .merge(protected)
        // OtelAxumLayer (outermost) starts a span per request and adopts any incoming
        // W3C traceparent as its parent; OtelInResponseLayer echoes the trace id back.
        .layer(OtelInResponseLayer::default())
        .layer(OtelAxumLayer::default())
        // /health is added AFTER the otel layers, not merged in before them: axum's
        // .layer() only wraps routes already present on the router at that point, so
        // this route is deliberately left untraced -- otherwise the compose
        // healthcheck (every 5s) would flood the service graph with a caller-less
        // node. This ordering is the pattern documented by axum-tracing-opentelemetry
        // itself for excluding a route from tracing.
        .route("/health", get(|| async { "ok" }));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8083").await.unwrap();
    tracing::info!("warehouse-service listening on :8083");
    axum::serve(listener, app).await.unwrap();
}
