#!/usr/bin/env python3
"""
デモシナリオ: Token Exchange チェーン全体を通るトラフィックを生成する。

実行:  docker compose --profile audit run --rm scenario

Keycloak の KC_HOSTNAME は http://localhost:3000 (edge-proxy の公開 URL) に固定されているため、
コンテナ内からは localhost:3000 が解決できない。
FRONTEND_URL を http://edge-proxy:3000 に設定することで、
リダイレクト URL を Docker 内部名に書き換えてフローを辿る。

正規シナリオに加えて、Token Exchange を経ないバイパスアクセスを1件生成する
（run_bypass_attempt）。監査ツール（audit/audit.py CHECK2）が実際に不正を検知する
様子をデモするための、意図的な異常系トラフィック。
"""

import base64
import html
import json
import os
import re
import time

import requests

# コンテナ内からは edge-proxy:3000 経由でシステム全体にアクセスする
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://edge-proxy:3000")
# Keycloak が認知している公開 URL (KC_HOSTNAME 値)
PUBLIC_URL = "http://localhost:3000"
# コンテナ内からはdocker内部名でKeycloak・各サービスに直接到達できる
# （scenarioコンテナも他サービスと同じdocker networkに参加しているため）。
KEYCLOAK_INTERNAL_URL = os.environ.get(
    "KEYCLOAK_INTERNAL_URL", "http://keycloak:8080/realms/kikan-system"
)
INVENTORY_SERVICE_URL = os.environ.get(
    "INVENTORY_SERVICE_BASE_URL", "http://inventory-service:8082"
)


def rewrite(url: str) -> str:
    """Keycloak 生成の localhost:3000 URL を Docker 内部の edge-proxy:3000 に書き換える。"""
    return url.replace(PUBLIC_URL, FRONTEND_URL)


def do_login(username: str, password: str) -> requests.Session:
    """PKCE フローを模倣して BFF セッション Cookie を取得する。"""
    s = requests.Session()

    # Step 1: /api/login → Keycloak 認証ページへのリダイレクト URL を取得
    r = s.get(f"{FRONTEND_URL}/api/login", allow_redirects=False, timeout=10)
    if r.status_code != 302:
        raise RuntimeError(f"/api/login: expected 302, got {r.status_code}")
    keycloak_auth_url = rewrite(r.headers["Location"])

    # Step 2: Keycloak ログインフォームを取得
    r = s.get(keycloak_auth_url, allow_redirects=True, timeout=10)
    if r.status_code != 200:
        raise RuntimeError(f"ログインページ取得失敗: {r.status_code}")

    # form action URL を HTML から抽出 (HTML エンティティを復元)
    m = re.search(r'id="kc-form-login"[^>]*action="([^"]+)"', r.text)
    if not m:
        m = re.search(r'action="([^"]+authenticate[^"]+)"', r.text)
    if not m:
        raise RuntimeError("Keycloak ログインフォームの action が見つからない")
    action_url = rewrite(html.unescape(m.group(1)))

    # Step 3: 認証情報を POST
    r = s.post(
        action_url,
        data={"username": username, "password": password},
        allow_redirects=False,
        timeout=10,
    )
    if r.status_code != 302:
        raise RuntimeError(f"ログイン POST 失敗: {r.status_code}: {r.text[:200]}")

    # Step 4: BFF コールバック (/api/callback?code=...) を辿りセッション Cookie を受け取る
    callback_url = rewrite(r.headers["Location"])
    r = s.get(callback_url, allow_redirects=True, timeout=15)
    if r.status_code not in (200, 302):
        raise RuntimeError(f"コールバック失敗: {r.status_code}: {r.text[:200]}")

    return s


def call(s: requests.Session, method: str, path: str, **kwargs) -> tuple[int, object]:
    r = s.request(method, f"{FRONTEND_URL}{path}", timeout=15, **kwargs)
    body = None
    if r.content:
        try:
            body = r.json()
        except Exception:
            body = r.text[:120]
    return r.status_code, body


def run_scenario(username: str, password: str, label: str, steps: list[tuple]) -> None:
    print(f"\n  ── {label} ({username}) ──")
    try:
        s = do_login(username, password)
    except Exception as e:
        print(f"    ✗ ログイン失敗: {e}")
        return
    print(f"    ✓ ログイン")

    for desc, method, path, kwargs in steps:
        try:
            status, body = call(s, method, path, **kwargs)
        except Exception as e:
            print(f"    ✗ {method} {path}  → エラー: {e}")
            continue
        mark = "✓" if status < 400 else "✗"
        print(f"    {mark} {desc:<28} {method} {path}  → HTTP {status}")
        if status >= 400:
            print(f"        {str(body)[:100]}")

    # ログが Loki に届くまで少し待つ
    time.sleep(0.5)


def decode_jwt_claims(access_token: str) -> dict:
    payload = access_token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def run_bypass_attempt() -> None:
    """Token Exchangeを経ないバイパスアクセスを1件生成する（監査デモ用）。

    order-service自身のクライアント資格情報（client_id/client_secret）で、
    Token Exchange専用に割り当てられているはずのoptional client scope
    "inventory"（architecture.md §12のトポロジー制御）を、client_credentials
    グラントで直接要求する。Keycloakのトポロジー制御はこれを拒否しない
    ——scopeの付与自体は「このクライアントがinventory-service宛のトークンを
    持ちうるか」を制御しているだけで、「その入手経路がToken Exchangeか」までは
    見ていない。結果、audience=inventory-serviceの正当な署名付きトークンが
    Token Exchangeを一切経由せずに手に入る。

    このトークンは実際にinventory-serviceの署名・issuer・audience検証を
    通過する（実機確認済み：ロール不足により最終的に403にはなるが、認証自体は
    成功しX-Subject/X-Jtiがアクセスログに記録される）。Keycloak側にはこの
    発行に対応するTOKEN_EXCHANGEイベントが存在しない
    （type="CLIENT_LOGIN"として記録される）ため、audit.py CHECK2が
    「TOKEN_EXCHANGE記録なし」として検知する。
    """
    print(f"\n  ── [バイパスデモ] order-serviceが自分の資格情報でinventory-service宛トークンを直接取得 ──")

    order_service_secret = os.environ.get("ORDER_SERVICE_CLIENT_SECRET", "order-service-secret")
    try:
        r = requests.post(
            f"{KEYCLOAK_INTERNAL_URL}/protocol/openid-connect/token",
            data={
                "grant_type": "client_credentials",
                "client_id": "order-service",
                "client_secret": order_service_secret,
                "scope": "inventory roles",
            },
            timeout=10,
        )
        r.raise_for_status()
        access_token = r.json()["access_token"]
    except Exception as e:
        print(f"    ✗ client_credentialsでのトークン取得に失敗: {e}")
        return

    claims = decode_jwt_claims(access_token)
    print(f"    ✓ Token Exchangeを経ずにaudience={claims.get('aud')}のトークンを取得"
          f"（sub={claims.get('sub')}, jti={claims.get('jti')}）")

    try:
        r = requests.get(
            f"{INVENTORY_SERVICE_URL}/inventory/product-A",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
    except Exception as e:
        print(f"    ✗ inventory-serviceへの直接アクセスに失敗: {e}")
        return
    mark = "✓" if r.status_code < 400 else "✗"
    print(f"    {mark} inventory-serviceへ直接アクセス  GET /inventory/product-A  → HTTP {r.status_code}"
          "（Bearer認証自体は通過。これがCHECK2で検知されるべきバイパス）")

    time.sleep(0.5)


def main() -> None:
    print(f"\n{'━'*60}")
    print(f"  Token Exchange デモシナリオ")
    print(f"  対象: {FRONTEND_URL}")
    print(f"{'━'*60}")

    # ── シナリオ定義 ──────────────────────────────────────────────
    # Token Exchange チェーンの種類:
    #   受注作成    : frontend → order-service → inventory-service
    #   在庫確認    : frontend → order-service → warehouse-service
    #   社員情報照会: frontend → employee-service

    scenarios = [
        (
            "yamada-sales", "password",
            "営業担当: 受注作成・在庫確認・社員情報照会",
            [
                ("受注一覧取得",     "GET",  "/api/orders", {}),
                ("受注作成",         "POST", "/api/orders",
                 {"json": {"customerId": "customer-1", "productId": "product-A", "quantity": 1}}),
                ("在庫確認(自支店)", "GET",  "/api/warehouse-stock/product-A", {}),
                ("自身の社員情報",   "GET",  "/api/employees/yamada-sales", {}),
            ],
        ),
        (
            "suzuki-support", "password",
            "サポート担当: 受注閲覧のみ",
            [
                ("受注一覧取得",   "GET", "/api/orders", {}),
                ("社員情報(自身)", "GET", "/api/employees/suzuki-support", {}),
            ],
        ),
        (
            "tanaka-hr", "password",
            "HR担当: 社員情報照会（他者含む）",
            [
                ("社員情報(自身)", "GET", "/api/employees/tanaka-hr", {}),
                ("社員情報(他者)", "GET", "/api/employees/yamada-sales", {}),
            ],
        ),
    ]

    for username, password, label, steps in scenarios:
        run_scenario(username, password, label, steps)

    run_bypass_attempt()

    print(f"\n{'━'*60}")
    print(f"  シナリオ完了。以下を実行して監査を開始してください:")
    print(f"  docker compose --profile audit run --rm audit")
    print(f"{'━'*60}\n")


if __name__ == "__main__":
    main()
