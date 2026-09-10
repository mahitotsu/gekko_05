import json
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from opentelemetry import trace
from pymongo import MongoClient

from auth import AuthContext, get_claims, has_role


def getenv(key: str, fallback: str) -> str:
    return os.environ.get(key, fallback)


@asynccontextmanager
async def lifespan(app: FastAPI):
    keycloak_internal_url = getenv(
        "KEYCLOAK_INTERNAL_URL", "http://localhost:8080/realms/kikan-system"
    )
    keycloak_issuer = getenv(
        "KEYCLOAK_ISSUER", "http://localhost:8080/realms/kikan-system"
    )
    jwks_url = f"{keycloak_internal_url}/protocol/openid-connect/certs"
    app.state.auth_ctx = AuthContext(jwks_url, keycloak_issuer)

    mongo_uri = getenv("MONGO_URI", "mongodb://localhost:27017")
    # DB名はemployee_serviceではなく、このcomposeサービス自身の名前
    # ("employee-mongo")に合わせている——pymongoの自動計装は実際のMongo DB名を
    # そのままdb.nameスパン属性として報告するため、これがTempoのservice graph上の
    # ノード名にもなる。employee_serviceのままだと、このサービス自身の
    # "employee-service"ノードと紛らわしい"双子"に見えてしまう。
    app.state.mongo = MongoClient(mongo_uri)["employee-mongo"]
    yield


app = FastAPI(lifespan=lifespan)


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
    # logging.getLogger()ではなくprint()を使う：ハンドラ・レベルを設定していない
    # 素のロガーは.info()呼び出しを無音で捨てる（実機で確認済み：出力が一切無い）。
    # 他サービス（Go/Rust/TS）もアクセスログは直接stdoutへ書き出している。
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


@app.get("/health")
def health():
    return "ok"


@app.get("/employees/{username}")
def get_employee(username: str, claims: dict = Depends(get_claims)):
    # セルフサービス：自分自身の情報は誰でも照会できる。他人の情報にはhr-viewerが
    # 必要。subではなくpreferred_usernameをキーにする：Keycloakのsubはrealmを
    # 再インポートするたびに再生成されるが、usernameは変わらないため。
    is_self = claims.get("preferred_username") == username
    if not is_self and not has_role(claims, "hr-viewer"):
        raise HTTPException(status_code=403, detail="insufficient role")

    employee = app.state.mongo.employees.find_one({"username": username}, {"_id": False})
    if employee is None:
        raise HTTPException(status_code=404, detail="employee not found")
    return employee
