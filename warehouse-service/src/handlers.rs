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

/// UC8/UC9 (docs/use-cases.md): "what branches can I see for this product", not "what's
/// at branch X" -- `branches` holds exactly the set the caller may see (empty for
/// warehouse-viewer-all when nothing anywhere has ever stocked this product; one entry
/// for a plain warehouse-viewer; any number for warehouse-viewer-all). See
/// get_stock_by_branches and architecture.md §20.
#[derive(Serialize)]
pub struct BranchStockResponse {
    product_id: String,
    branches: HashMap<String, i64>,
}

#[derive(Deserialize)]
pub struct ReserveRequest {
    quantity: i64,
}

/// Emits a structured `authz_deny` log line, separate from the per-request access_log
/// line: the latter carries status/path (403 on `/warehouse/osaka/...`) but not *why*
/// -- role missing vs. ABAC branch mismatch are indistinguishable from that alone.
/// DENY-only, deliberately: this is a self-reported log written by the same code whose
/// judgment it describes, so (unlike §10's Keycloak-vs-access_log jti/TOKEN_EXCHANGE
/// cross-check) it has no independent second source to verify a decision against, and
/// can't prove a PERMIT was correct -- see architecture.md §19. Its value is limited to
/// anomaly triage (repeated branch_mismatch from one sub) and support debugging ("why
/// was this order rejected"), not audit. Fields mirror access_log's sub/jti/trace_id so
/// the two correlate in queries (permission-matrix.md 表5).
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

/// Resolves the caller's own assigned branch via Employee Service (self-lookup keyed by
/// preferred_username -- Keycloak subs are regenerated on every realm re-import,
/// usernames aren't, see DESIGN.md §16). Shared by `authorize_branch` (ABAC branch-match
/// check for the reserve path) and `get_stock_by_branches` (UC8/UC9's bulk read): both
/// need "what branch does this warehouse-viewer belong to" for the same underlying fact.
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

    // No axum layer wraps outgoing calls (OtelAxumLayer only instruments the inbound
    // side), so this is wrapped in an explicit CLIENT span by hand -- otherwise it
    // reads to Tempo's service graph as a caller-less SERVER span on employee-service's
    // end, same reasoning as token_exchange.rs's Keycloak call.
    let span = tracing::info_span!(
        "employee_service.get",
        "otel.kind" = "client",
        "otel.name" = %format!("GET {}", url),
        "http.method" = "GET",
        "http.url" = %url,
    );
    let resp = async {
        // Propagate the current (CLIENT) span's context to employee-service as a W3C
        // `traceparent` header, so the two services share one distributed trace.
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

/// Two-stage authorization: warehouse-viewer/warehouse-viewer-all gates access at all
/// (RBAC), then, unless the caller holds warehouse-viewer-all, the requested branch
/// must match the employee's own assigned branch (ABAC). See permission-matrix.md 表5.
/// Used by the reserve path only (`reserve_stock`), where the target branch is chosen by
/// the product-branch mapping, not the caller -- a mismatch here is a genuine denial of
/// a specific request, unlike the read path (`get_stock_by_branches`) where there is no
/// caller-chosen branch to mismatch against.
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

/// UC8/UC9 (docs/use-cases.md): "what branches can I see for this product" -- there is
/// no caller-chosen branch in this request at all, so unlike `reserve_stock` there is no
/// ABAC mismatch to deny; the RBAC gate (do you hold either role at all) is the only
/// denial left, and branch-level scoping is folded honestly into the response shape
/// (fewer/more entries in `branches`) instead. See architecture.md §20.
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
        // Discover every branch that has ever recorded stock for this product by
        // scanning this service's own Redis keys -- the only "branch list" this service
        // needs, and the only one it owns (no shared branch master exists anywhere in
        // the system; see architecture.md §20's note on that).
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
        // Plain warehouse-viewer: exactly their own branch, or an empty (not denied)
        // result if Employee Service has no branch on file for them -- ABAC scoping is
        // part of what this endpoint honestly answers, not a per-request denial.
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
