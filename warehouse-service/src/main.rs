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

/// 現在アクティブなOTelスパンのtrace_idを文字列で返す。有効なスパンが無ければ"-"。
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

    // 他サービスと構造を揃えるため、フラットなJSONを直接stdoutへ書き出す
    // （tracingのJSON形式は構造化フィールドを"fields"の下にネストするため、
    // トップレベルのtype="access_log"で絞り込むサービス横断LogQLクエリが壊れる）。
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

/// OpenTelemetryを構成する：OTLP/HTTPのスパンエクスポーター、`service.name`を
/// 付与したバッチ方式のtracer provider、W3C traceparent伝播、そしてスパンをOTelへ
/// ブリッジする`tracing`サブスクライバー。providerを返すので、呼び出し側がプロセス
/// 生存期間中これを保持し続けること（dropするとエクスポーターがflush・シャットダウン
/// される）。
fn init_telemetry(service_name: &str, otlp_endpoint: &str) -> SdkTracerProvider {
    // このpropagatorは受信リクエストのミドルウェア（`traceparent`の抽出）と発信の
    // reqwest呼び出し（`traceparent`の注入）の両方で共有し、サービス間でトレースを
    // 繋げる。
    global::set_text_map_propagator(TraceContextPropagator::new());

    // opentelemetry-otlpのHTTPエクスポーターは、エンドポイントを環境変数から取得した
    // 場合のみシグナルパス(`/v1/traces`)を自動付与する。プログラムから明示的に渡した
    // エンドポイントはそのまま使われるため、ベースURLであるOTEL_EXPORTER_OTLP_ENDPOINT
    // にはこちらでパスを付与する。
    let traces_endpoint = format!("{}/v1/traces", otlp_endpoint.trim_end_matches('/'));
    let exporter = SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(traces_endpoint)
        .build()
        .expect("failed to build OTLP span exporter");

    // hyperベースのOTLPエクスポーターは、既定のwith_batch_exporter()が使う素のOS
    // スレッド方式のプロセッサと異なり、非同期のTokioコンテキスト上で動く必要が
    // ある。そのためTokio統合版のBatchSpanProcessorを使う（Cargo.tomlのrt-tokioに
    // 関する注記を参照）。
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
        // JSON形式：tracingイベントの構造化フィールドがJSONのキーになる。JSONモード
        // ではターミナル向けの装飾が無いためANSIカラーコードも付かない。
        .with(tracing_subscriber::fmt::layer().json())
        .with(tracing_opentelemetry::layer().with_tracer(tracer))
        .init();

    provider
}

#[tokio::main]
async fn main() {
    let otel_endpoint = getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    let service_name = getenv("OTEL_SERVICE_NAME", "warehouse-service");
    // mainの終わりまで保持することで、バッチ方式のスパンプロセッサをプロセス実行中
    // ずっと生かしておく。
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
        // UC8/UC9：:branchセグメントを持たない——get_stock_by_branchesと
        // architecture.md §20を参照。
        .route("/warehouse/stock/:product_id", get(handlers::get_stock_by_branches))
        .route("/warehouse/:branch/stock/:product_id/reserve", post(handlers::reserve_stock))
        // Axum：最後に呼んだ.layer()が最外層（最初に実行される）。authが先に実行
        // されてClaimsをextensionsへ挿入し、access_logが後で実行されてそれを読む。
        .layer(middleware::from_fn(access_log_middleware))
        .layer(middleware::from_fn_with_state(auth_ctx, auth::auth_middleware))
        .with_state(state);

    let app = Router::new()
        .merge(protected)
        // OtelAxumLayer（最外層）はリクエストごとにスパンを開始し、受信した
        // W3C traceparentがあればそれを親として採用する。OtelInResponseLayerは
        // trace idをレスポンスへ返す。
        .layer(OtelInResponseLayer::default())
        .layer(OtelAxumLayer::default())
        // /healthはotelレイヤーより前にmergeするのではなく、後から追加する：axumの
        // .layer()はその時点でルーターに存在するルートしかラップしないため、この
        // ルートは意図的にトレース対象外になる。そうしないとcomposeのヘルスチェック
        // （5秒ごと）がservice graphを呼び出し元不明のノードで埋め尽くしてしまう。
        // この順序はaxum-tracing-opentelemetry自身がルートをトレースから除外する
        // ために文書化しているパターンである。
        .route("/health", get(|| async { "ok" }));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8083").await.unwrap();
    tracing::info!("warehouse-service listening on :8083");
    axum::serve(listener, app).await.unwrap();
}
