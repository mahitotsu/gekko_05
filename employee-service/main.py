import json
import os
import time

from fastapi import Depends, FastAPI, HTTPException, Request
from opentelemetry import trace
from pymongo import MongoClient

from auth import AuthContext, get_claims, has_role


def getenv(key: str, fallback: str) -> str:
    return os.environ.get(key, fallback)


app = FastAPI()


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    start = time.monotonic()
    response = await call_next(request)
    span_ctx = trace.get_current_span().get_span_context()
    trace_id = format(span_ctx.trace_id, "032x") if span_ctx.is_valid else "-"
    sub = getattr(request.state, "sub", "-")
    jti = getattr(request.state, "jti", "-")
    # print(), not logging.getLogger(): a fresh logger with no handler/level
    # configured silently drops .info() calls (verified: produces zero output).
    # Other services (Go/Rust/TS) all write access logs straight to stdout too.
    print(json.dumps({
        "type": "access_log",
        "method": request.method,
        "path": request.url.path,
        "status": response.status_code,
        "duration_ms": int((time.monotonic() - start) * 1000),
        "sub": sub,
        "jti": jti,
        "trace_id": trace_id,
    }), flush=True)
    return response


@app.on_event("startup")
def startup():
    keycloak_internal_url = getenv(
        "KEYCLOAK_INTERNAL_URL", "http://localhost:8080/realms/kikan-system"
    )
    keycloak_issuer = getenv(
        "KEYCLOAK_ISSUER", "http://localhost:8080/realms/kikan-system"
    )
    jwks_url = f"{keycloak_internal_url}/protocol/openid-connect/certs"
    app.state.auth_ctx = AuthContext(jwks_url, keycloak_issuer)

    mongo_uri = getenv("MONGO_URI", "mongodb://localhost:27017")
    # DB name matches this compose service's own name ("employee-mongo"), not
    # employee_service -- pymongo's auto-instrumentation reports the real Mongo db
    # name verbatim as the db.name span attribute, so this is also what shows up as
    # the node name in Tempo's service graph. Keeping it as employee_service would
    # read as a confusing near-twin of this service's own "employee-service" node.
    app.state.mongo = MongoClient(mongo_uri)["employee-mongo"]


@app.get("/health")
def health():
    return "ok"


@app.get("/employees/{username}")
def get_employee(username: str, claims: dict = Depends(get_claims)):
    # Self-service: anyone can look up their own record. Anyone else's requires
    # hr-viewer. Keyed by preferred_username, not sub: Keycloak subs are regenerated
    # on every realm re-import, usernames aren't.
    is_self = claims.get("preferred_username") == username
    if not is_self and not has_role(claims, "hr-viewer"):
        raise HTTPException(status_code=403, detail="insufficient role")

    employee = app.state.mongo.employees.find_one({"username": username}, {"_id": False})
    if employee is None:
        raise HTTPException(status_code=404, detail="employee not found")
    return employee
