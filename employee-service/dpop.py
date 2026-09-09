import base64
import hashlib
import json
import time

import jwt
from cryptography.hazmat.primitives.asymmetric.ec import (
    EllipticCurvePublicNumbers,
    SECP256R1,
)
from fastapi import HTTPException, Request

IAT_TOLERANCE_SECONDS = 60


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _jwk_thumbprint(jwk: dict) -> str:
    # RFC 7638: SHA-256 over a JSON object with exactly these keys, in this order.
    canonical = json.dumps({"crv": jwk["crv"], "kty": jwk["kty"], "x": jwk["x"], "y": jwk["y"]}, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _base64url_sha256(value: str) -> str:
    digest = hashlib.sha256(value.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def validate_dpop(request: Request, claims: dict, access_token: str) -> None:
    """Validates the RFC 9449 DPoP proof for a DPoP-bound access token (cnf.jkt
    present). Mirrors order-service's DpopValidationFilter (Java) -- see DESIGN.md
    §11 for the same demo-scale simplification noted there (no jti replay cache).
    """
    cnf = claims.get("cnf")
    if not cnf or "jkt" not in cnf:
        return  # token isn't DPoP-bound; nothing to check.

    proof = request.headers.get("DPoP")
    if not proof:
        raise HTTPException(status_code=401, detail="DPoP proof is missing for a DPoP-bound token")

    header_b64, payload_b64, _ = proof.split(".")
    header = json.loads(_b64url_decode(header_b64))
    payload = json.loads(_b64url_decode(payload_b64))

    if header.get("typ") != "dpop+jwt":
        raise HTTPException(status_code=401, detail="DPoP proof has wrong typ header")

    jwk = header["jwk"]
    public_key = EllipticCurvePublicNumbers(
        x=int.from_bytes(_b64url_decode(jwk["x"]), "big"),
        y=int.from_bytes(_b64url_decode(jwk["y"]), "big"),
        curve=SECP256R1(),
    ).public_key()

    try:
        jwt.decode(proof, public_key, algorithms=["ES256"], options={"verify_exp": False})
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"DPoP proof signature is invalid: {e}")

    if _jwk_thumbprint(jwk) != cnf["jkt"]:
        raise HTTPException(status_code=401, detail="DPoP proof key does not match the token's cnf.jkt")
    if payload.get("htm") != request.method:
        raise HTTPException(status_code=401, detail="DPoP proof htm does not match the request method")
    if payload.get("htu") != str(request.url).split("?")[0]:
        raise HTTPException(status_code=401, detail="DPoP proof htu does not match the request URL")
    if abs(time.time() - payload.get("iat", 0)) > IAT_TOLERANCE_SECONDS:
        raise HTTPException(status_code=401, detail="DPoP proof iat is outside the acceptable window")
    if payload.get("ath") != _base64url_sha256(access_token):
        raise HTTPException(status_code=401, detail="DPoP proof ath does not match the presented access token")
