use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use opentelemetry::global;
use opentelemetry_http::HeaderInjector;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::auth::Claims;
use crate::token_exchange::TokenExchangeClient;

pub struct AppState {
    pub redis: redis::Client,
    pub token_exchange: TokenExchangeClient,
    pub employee_service_base_url: String,
    pub http: reqwest::Client,
}

#[derive(Deserialize)]
struct EmployeeRecord {
    branch: Option<String>,
}

#[derive(Serialize)]
pub struct StockResponse {
    branch: String,
    product_id: String,
    quantity: i64,
}

/// UC8/UC9（docs/use-cases.md）：「支店Xには何があるか」ではなく「この商品について
/// 自分にはどの支店が見えるか」を表す。`branches`は呼び出し元が見てよい支店の集合
/// そのものになる（warehouse-viewer-allでこの商品をどこも扱ったことが無ければ空、
/// 一般のwarehouse-viewerなら1件、warehouse-viewer-allなら任意の件数）。
/// get_stock_by_branchesとarchitecture.md §20を参照。
#[derive(Serialize)]
pub struct BranchStockResponse {
    product_id: String,
    branches: HashMap<String, i64>,
}

#[derive(Deserialize)]
pub struct ReserveRequest {
    quantity: i64,
}

/// リクエストごとのaccess_logとは別に、構造化された`authz_deny`ログ行を出力する。
/// access_logはstatus/pathを持つが（例：`/warehouse/osaka/...`の403）「なぜ」までは
/// 分からない——ロール不足なのかABACの支店不一致なのかはそれだけでは区別できない。
/// 意図的にDENYのみを記録する：これは判断を下した当のコード自身が書く自己申告ログで
/// あり、独立した第二のソースと突合できる§10のKeycloak対access_log突合と異なり、
/// PERMITが正しかったことを立証する力を持たない（詳細はarchitecture.md §19）。用途は
/// 異常の兆候検知（同一subからのbranch_mismatch連発など）とサポート用デバッグに限られ、
/// 監査ではない。フィールドはaccess_logのsub/jti/trace_idと揃えており突合できる
/// （permission-matrix.md 表5）。
fn log_authz_deny(claims: &Claims, branch: &str, reason: &str, employee_branch: Option<&str>) {
    let entry = json!({
        "type": "authz_deny",
        "sub": claims.sub,
        "jti": claims.jti.clone().unwrap_or_else(|| "-".to_string()),
        "trace_id": crate::current_trace_id(),
        "branch": branch,
        "reason": reason,
        "employee_branch": employee_branch,
    });
    println!("{}", entry);
}

/// Employee Serviceを通じて呼び出し元本人の所属支店を解決する（preferred_username
/// をキーにした自分自身の照会。Keycloakのsubはrealmを再インポートするたびに
/// 再生成されるが、usernameは変わらないため）。`authorize_branch`（reserve経路の
/// ABAC支店一致判定）と`get_stock_by_branches`（UC8/UC9の一括読み取り）の双方が
/// 共有する：どちらも「このwarehouse-viewerはどの支店に属するか」という同じ事実
/// を必要とする。
async fn resolve_own_branch(state: &AppState, claims: &Claims, token: &str) -> Result<Option<String>, StatusCode> {
    let employee_token = state
        .token_exchange
        .exchange(token, "employee-service", "employee")
        .await
        .map_err(|e| {
            tracing::error!("token exchange for employee-service failed: {e}");
            StatusCode::BAD_GATEWAY
        })?;

    let username = claims.preferred_username.as_deref().unwrap_or("");
    let url = format!("{}/employees/{}", state.employee_service_base_url, username);

    // 発信呼び出しにはaxumのレイヤーが掛からない（OtelAxumLayerは受信側のみを計装
    // する）ため、明示的なCLIENTスパンで手動で包む。そうしないとTempoのservice
    // graph上でemployee-service側の呼び出し元不明なSERVERスパンに見えてしまう。
    // token_exchange.rsのKeycloak呼び出しと同じ理由。
    let span = tracing::info_span!(
        "employee_service.get",
        "otel.kind" = "client",
        "otel.name" = %format!("GET {}", url),
        "http.method" = "GET",
        "http.url" = %url,
    );
    let resp = async {
        // 現在の（CLIENT）スパンのcontextをW3C `traceparent`ヘッダーとして
        // employee-serviceへ伝播し、両サービスが1つの分散トレースを共有できる
        // ようにする。
        let mut trace_headers = reqwest::header::HeaderMap::new();
        let cx = tracing::Span::current().context();
        global::get_text_map_propagator(|propagator| {
            propagator.inject_context(&cx, &mut HeaderInjector(&mut trace_headers));
        });

        state
            .http
            .get(&url)
            .bearer_auth(&employee_token)
            .headers(trace_headers)
            .send()
            .await
    }
    .instrument(span)
    .await
    .map_err(|e| {
        tracing::error!("employee-service call failed: {e}");
        StatusCode::BAD_GATEWAY
    })?;

    if !resp.status().is_success() {
        return Err(StatusCode::FORBIDDEN);
    }
    let employee: EmployeeRecord = resp.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(employee.branch)
}

/// 二段階の認可判定：まずwarehouse-viewer/warehouse-viewer-allでアクセス可否自体を
/// ゲートし（RBAC）、warehouse-viewer-allを持たない場合は要求された支店が本人の
/// 所属支店と一致することを要求する（ABAC）。permission-matrix.md 表5参照。
/// reserveの経路（`reserve_stock`）のみで使う。対象支店は商品-支店マッピングで
/// 決まりcaller自身は選べないため、ここでの不一致はその特定リクエストへの正当な
/// 拒否になる。読み取り経路（`get_stock_by_branches`）と異なり、呼び出し元が選んだ
/// 支店との不一致という状況自体が存在しない。
async fn authorize_branch(state: &AppState, claims: &Claims, branch: &str, token: &str) -> Result<(), StatusCode> {
    if !claims.has_any_role(&["warehouse-viewer", "warehouse-viewer-all"]) {
        log_authz_deny(claims, branch, "role_missing", None);
        return Err(StatusCode::FORBIDDEN);
    }
    if claims.has_any_role(&["warehouse-viewer-all"]) {
        return Ok(());
    }

    match resolve_own_branch(state, claims, token).await? {
        Some(employee_branch) if employee_branch == branch => Ok(()),
        Some(employee_branch) => {
            log_authz_deny(claims, branch, "branch_mismatch", Some(&employee_branch));
            Err(StatusCode::FORBIDDEN)
        }
        None => {
            log_authz_deny(claims, branch, "employee_branch_unknown", None);
            Err(StatusCode::FORBIDDEN)
        }
    }
}

/// UC8/UC9（docs/use-cases.md）：「この商品について自分にはどの支店が見えるか」を
/// 問う。このリクエストには呼び出し元が選ぶ支店がそもそも存在しないため、
/// `reserve_stock`と違いABACによる不一致を理由とした拒否は発生しない。残るのは
/// RBACゲート（いずれかのロールを持っているか）のみで、支店レベルの絞り込みは
/// 拒否ではなくレスポンスの形（`branches`の件数）に正直に反映される。
/// architecture.md §20参照。
pub async fn get_stock_by_branches(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Extension(token): Extension<String>,
    Path(product_id): Path<String>,
) -> Result<Json<BranchStockResponse>, StatusCode> {
    if !claims.has_any_role(&["warehouse-viewer", "warehouse-viewer-all"]) {
        log_authz_deny(&claims, "-", "role_missing", None);
        return Err(StatusCode::FORBIDDEN);
    }

    let mut conn = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let branches = if claims.has_any_role(&["warehouse-viewer-all"]) {
        // このサービス自身のRedisキーをスキャンし、この商品の在庫を記録した
        // ことのある全支店を洗い出す——このサービスが必要とし、かつ保有する唯一の
        // 「支店一覧」である（システム全体で共有の支店マスタは存在しない。
        // architecture.md §20の該当箇所を参照）。
        let pattern = format!("stock:*:{product_id}");
        let keys: Vec<String> = async { conn.keys(&pattern).await.unwrap_or_default() }
            .instrument(tracing::info_span!(
                "redis.keys",
                "otel.kind" = "client",
                "db.system" = "redis",
                "db.name" = "warehouse-redis",
                "db.statement" = %format!("KEYS {pattern}"),
            ))
            .await;

        let mut branches = HashMap::new();
        for key in keys {
            let Some(branch) = key
                .strip_prefix("stock:")
                .and_then(|s| s.strip_suffix(&format!(":{product_id}")))
            else {
                continue;
            };
            let quantity: i64 = conn.get(&key).await.unwrap_or(0);
            branches.insert(branch.to_string(), quantity);
        }
        branches
    } else {
        // 一般のwarehouse-viewer：自分の所属支店のみ。Employee Serviceに支店情報が
        // 登録されていなければ空集合を返す（拒否ではない）——ABACによる絞り込みは、
        // このエンドポイントが正直に答える内容の一部であり、リクエスト単位の拒否
        // ではない。
        match resolve_own_branch(&state, &claims, &token).await? {
            Some(own_branch) => {
                let key = format!("stock:{own_branch}:{product_id}");
                let quantity: i64 = async { conn.get(&key).await.unwrap_or(0) }
                    .instrument(tracing::info_span!(
                        "redis.get",
                        "otel.kind" = "client",
                        "db.system" = "redis",
                        "db.name" = "warehouse-redis",
                        "db.statement" = %format!("GET {key}"),
                    ))
                    .await;
                HashMap::from([(own_branch, quantity)])
            }
            None => HashMap::new(),
        }
    };

    Ok(Json(BranchStockResponse { product_id, branches }))
}

pub async fn reserve_stock(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Extension(token): Extension<String>,
    Path((branch, product_id)): Path<(String, String)>,
    Json(req): Json<ReserveRequest>,
) -> Result<Json<StockResponse>, StatusCode> {
    authorize_branch(&state, &claims, &branch, &token).await?;

    let mut conn = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let key = format!("stock:{branch}:{product_id}");
    let script = redis::Script::new(
        r"
        local current = tonumber(redis.call('GET', KEYS[1]) or '0')
        local qty = tonumber(ARGV[1])
        if current < qty then
            return -1
        end
        redis.call('DECRBY', KEYS[1], qty)
        return current - qty
        ",
    );
    let result: i64 = async { script.key(&key).arg(req.quantity).invoke_async(&mut conn).await }
        .instrument(tracing::info_span!(
            "redis.eval",
            "otel.kind" = "client",
            "db.system" = "redis",
            "db.name" = "warehouse-redis",
        ))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if result < 0 {
        return Err(StatusCode::CONFLICT);
    }

    Ok(Json(StockResponse { branch, product_id, quantity: result }))
}
