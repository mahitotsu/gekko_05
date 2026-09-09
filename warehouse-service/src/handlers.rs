use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use opentelemetry::global;
use opentelemetry_http::HeaderInjector;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
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

#[derive(Deserialize)]
pub struct ReserveRequest {
    quantity: i64,
}

/// Two-stage authorization: warehouse-viewer/warehouse-viewer-all gates access at all
/// (RBAC), then, unless the caller holds warehouse-viewer-all, the requested branch
/// must match the employee's own assigned branch (ABAC). See permission-matrix.md 表5.
async fn authorize_branch(state: &AppState, claims: &Claims, branch: &str, token: &str) -> Result<(), StatusCode> {
    if !claims.has_any_role(&["warehouse-viewer", "warehouse-viewer-all"]) {
        return Err(StatusCode::FORBIDDEN);
    }
    if claims.has_any_role(&["warehouse-viewer-all"]) {
        return Ok(());
    }

    let employee_token = state
        .token_exchange
        .exchange(token, "employee-service", "employee")
        .await
        .map_err(|e| {
            tracing::error!("token exchange for employee-service failed: {e}");
            StatusCode::BAD_GATEWAY
        })?;

    // Self-lookup, keyed by preferred_username (Keycloak subs are regenerated on every
    // realm re-import, usernames aren't -- see DESIGN.md §16).
    let username = claims.preferred_username.as_deref().unwrap_or("");
    let url = format!("{}/employees/{}", state.employee_service_base_url, username);

    // Propagate the current request's trace context to employee-service as a W3C
    // `traceparent` header, so the two services share one distributed trace.
    let mut trace_headers = reqwest::header::HeaderMap::new();
    let cx = tracing::Span::current().context();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&cx, &mut HeaderInjector(&mut trace_headers));
    });

    let resp = state
        .http
        .get(&url)
        .bearer_auth(&employee_token)
        .headers(trace_headers)
        .send()
        .await
        .map_err(|e| {
            tracing::error!("employee-service call failed: {e}");
            StatusCode::BAD_GATEWAY
        })?;

    if !resp.status().is_success() {
        return Err(StatusCode::FORBIDDEN);
    }
    let employee: EmployeeRecord = resp.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;

    match employee.branch {
        Some(employee_branch) if employee_branch == branch => Ok(()),
        _ => Err(StatusCode::FORBIDDEN),
    }
}

pub async fn get_stock(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Extension(token): Extension<String>,
    Path((branch, product_id)): Path<(String, String)>,
) -> Result<Json<StockResponse>, StatusCode> {
    authorize_branch(&state, &claims, &branch, &token).await?;

    let mut conn = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let key = format!("stock:{branch}:{product_id}");
    let quantity: i64 = conn.get(&key).await.unwrap_or(0);

    Ok(Json(StockResponse { branch, product_id, quantity }))
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
    let result: i64 = script
        .key(&key)
        .arg(req.quantity)
        .invoke_async(&mut conn)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if result < 0 {
        return Err(StatusCode::CONFLICT);
    }

    Ok(Json(StockResponse { branch, product_id, quantity: result }))
}
