import jwt
from fastapi import Depends, HTTPException, Request

from dpop import validate_dpop

AUDIENCE = "employee-service"


class AuthContext:
    """Wraps PyJWT's JWKS client (handles fetching/caching Keycloak's signing keys)
    plus the issuer/audience this service expects."""

    def __init__(self, jwks_url: str, issuer: str):
        self.jwk_client = jwt.PyJWKClient(jwks_url)
        self.issuer = issuer

    def verify(self, token: str) -> dict:
        signing_key = self.jwk_client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=AUDIENCE,
            issuer=self.issuer,
        )


def get_claims(request: Request) -> dict:
    """FastAPI dependency: validates the bearer token (and, if it's DPoP-bound, the
    accompanying DPoP proof) and returns its claims."""
    auth_header = request.headers.get("Authorization", "")
    scheme, _, token = auth_header.partition(" ")
    if scheme not in ("Bearer", "DPoP") or not token:
        raise HTTPException(status_code=401, detail="missing bearer token")

    ctx: AuthContext = request.app.state.auth_ctx
    try:
        claims = ctx.verify(token)
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"invalid token: {e}")

    validate_dpop(request, claims, token)
    return claims


def has_role(claims: dict, role: str) -> bool:
    return role in claims.get("realm_access", {}).get("roles", [])
