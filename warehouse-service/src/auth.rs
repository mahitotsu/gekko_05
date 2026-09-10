use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RealmAccess {
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Claims {
    #[serde(default)]
    pub preferred_username: Option<String>,
    #[serde(default)]
    pub realm_access: Option<RealmAccess>,
}

impl Claims {
    pub fn has_any_role(&self, required: &[&str]) -> bool {
        match &self.realm_access {
            Some(ra) => ra.roles.iter().any(|r| required.contains(&r.as_str())),
            None => false,
        }
    }
}

const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(10);

struct KeySet {
    keys: HashMap<String, DecodingKey>,
    last_fetch: Instant,
}

pub struct AuthContext {
    keyset: Arc<RwLock<KeySet>>,
    jwks_url: String,
    issuer: String,
    audience: String,
    http: reqwest::Client,
    // Deduplicates concurrent refresh attempts: only one background refetch in flight
    // at a time, regardless of how many requests hit an unknown kid simultaneously.
    refreshing: Arc<AtomicBool>,
}

async fn fetch_keys(
    http: &reqwest::Client,
    jwks_url: &str,
) -> Result<HashMap<String, DecodingKey>, Box<dyn std::error::Error>> {
    let resp = http.get(jwks_url).send().await?.json::<JwkSet>().await?;
    let mut keys = HashMap::new();
    for jwk in resp.keys {
        if let Ok(key) = DecodingKey::from_rsa_components(&jwk.n, &jwk.e) {
            keys.insert(jwk.kid, key);
        }
    }
    Ok(keys)
}

/// Fetches Keycloak's signing keys once at startup, kept in sync afterward by
/// `AuthContext::verify` triggering a background refetch whenever a token presents a
/// kid we don't recognize (e.g. after Keycloak rotates its keys on a restart).
pub async fn build_auth_context(
    jwks_url: &str,
    issuer: &str,
    audience: &str,
) -> Result<Arc<AuthContext>, Box<dyn std::error::Error>> {
    let http = reqwest::Client::new();
    let keys = fetch_keys(&http, jwks_url).await?;
    Ok(Arc::new(AuthContext {
        keyset: Arc::new(RwLock::new(KeySet { keys, last_fetch: Instant::now() })),
        jwks_url: jwks_url.to_string(),
        issuer: issuer.to_string(),
        audience: audience.to_string(),
        http,
        refreshing: Arc::new(AtomicBool::new(false)),
    }))
}

impl AuthContext {
    // Deliberately synchronous (no `.await`): auth_middleware is registered via
    // `middleware::from_fn_with_state`, whose trait-bound resolution against this
    // repo's split axum 0.7/0.8 dependency graph (axum-tracing-opentelemetry pulls in
    // 0.8) is fragile -- adding an extra `.await` hop here broke it in practice. Doing
    // the actual key refetch in a spawned background task instead keeps
    // auth_middleware's own async shape untouched.
    fn verify(&self, token: &str) -> Result<Claims, String> {
        let header = decode_header(token).map_err(|e| e.to_string())?;
        let kid = header.kid.ok_or("missing kid")?;

        let key_present = self.keyset.read().unwrap().keys.contains_key(&kid);
        if !key_present {
            self.maybe_spawn_refresh();
        }

        let guard = self.keyset.read().unwrap();
        let key = guard.keys.get(&kid).ok_or("unknown kid")?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);

        let data = decode::<Claims>(token, key, &validation).map_err(|e| e.to_string())?;
        Ok(data.claims)
    }

    /// Rate-limited (MIN_REFRESH_INTERVAL) and deduplicated (refreshing flag), so a
    /// stream of bogus kids can't turn this into a self-inflicted DoS against Keycloak.
    /// The request that triggered this still sees "unknown kid" -- the refetch lands in
    /// time for the *next* request, not this one.
    fn maybe_spawn_refresh(&self) {
        if self.keyset.read().unwrap().last_fetch.elapsed() < MIN_REFRESH_INTERVAL {
            return;
        }
        if self.refreshing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return;
        }

        let keyset = self.keyset.clone();
        let http = self.http.clone();
        let jwks_url = self.jwks_url.clone();
        let refreshing = self.refreshing.clone();
        tokio::spawn(async move {
            if let Ok(fresh) = fetch_keys(&http, &jwks_url).await {
                let mut guard = keyset.write().unwrap();
                guard.keys = fresh;
                guard.last_fetch = Instant::now();
            }
            refreshing.store(false, Ordering::SeqCst);
        });
    }
}

/// Extracts and validates the bearer token, storing its Claims as a request extension
/// so downstream handlers can read `sub`, `preferred_username` and roles.
pub async fn auth_middleware(
    axum::extract::State(ctx): axum::extract::State<Arc<AuthContext>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token: String = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?
        .to_string();

    let claims = ctx.verify(&token).map_err(|_| StatusCode::UNAUTHORIZED)?;

    req.extensions_mut().insert(claims);
    req.extensions_mut().insert(token);
    Ok(next.run(req).await)
}
