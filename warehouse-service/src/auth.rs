use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

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

pub struct AuthContext {
    keys: HashMap<String, DecodingKey>,
    issuer: String,
    audience: String,
}

/// Fetches Keycloak's signing keys once at startup. Demo-scale simplification:
/// keys are cached for the process lifetime, no rotation handling.
pub async fn build_auth_context(
    jwks_url: &str,
    issuer: &str,
    audience: &str,
) -> Result<Arc<AuthContext>, Box<dyn std::error::Error>> {
    let resp = reqwest::get(jwks_url).await?.json::<JwkSet>().await?;
    let mut keys = HashMap::new();
    for jwk in resp.keys {
        if let Ok(key) = DecodingKey::from_rsa_components(&jwk.n, &jwk.e) {
            keys.insert(jwk.kid, key);
        }
    }
    Ok(Arc::new(AuthContext {
        keys,
        issuer: issuer.to_string(),
        audience: audience.to_string(),
    }))
}

impl AuthContext {
    fn verify(&self, token: &str) -> Result<Claims, String> {
        let header = decode_header(token).map_err(|e| e.to_string())?;
        let kid = header.kid.ok_or("missing kid")?;
        let key = self.keys.get(&kid).ok_or("unknown kid")?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);

        let data = decode::<Claims>(token, key, &validation).map_err(|e| e.to_string())?;
        Ok(data.claims)
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
