#!/usr/bin/env bash
# docs/permission-matrix.mdに記載されたKeycloak層の認可ルールを検証する。
# docker-compose.ymlのスタックが起動しており、edge-proxy経由でlocalhost:3000へ
# 到達できることが前提（Keycloakは直接ホストへ公開されなくなったため）。
set -uo pipefail

BASE_URL="http://localhost:3000"
REALM="kikan-system"

# アサーションのヘルパーは、シェル変数ではなくこのファイルへPASS/FAILを追記する。
# 一部のアサーションはトークンも同時に取得するためコマンド置換`$(...)`（サブ
# シェル）の中で実行され、サブシェルは親シェルの変数を変更できないため。
RESULTS_FILE=$(mktemp)
trap 'rm -f "$RESULTS_FILE"' EXIT

decode_claim() {
  # decode_claim <jwt> <claim_path...>  例: decode_claim "$tok" realm_access roles
  local tok="$1"; shift
  python3 -c "
import sys, base64, json
tok = sys.argv[1]
payload = tok.split('.')[1]
payload += '=' * (-len(payload) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload))
node = claims
for key in sys.argv[2:]:
    node = node.get(key) if isinstance(node, dict) else None
    if node is None:
        break
if isinstance(node, list):
    node = sorted(node)
print(json.dumps(node))
" "$tok" "$@"
}

dpop_proof() {
  # dpop_proof <htm> <htu> -- 使い捨ての新規EC鍵ペアからProofを生成する。
  # frontendクライアントはdpop.bound.access.tokens=trueを持つため
  # （architecture.md §11）、tokenエンドポイントはリソースサーバーだけでなく
  # ログインのたびにもDPoP Proofを要求する。
  python3 -c "
import sys, time, uuid, base64
import jwt
from cryptography.hazmat.primitives.asymmetric import ec

htm, htu = sys.argv[1], sys.argv[2]
key = ec.generate_private_key(ec.SECP256R1())
n = key.public_key().public_numbers()

def b64url(v, length):
    return base64.urlsafe_b64encode(v.to_bytes(length, 'big')).rstrip(b'=').decode()

jwk = {'kty': 'EC', 'crv': 'P-256', 'x': b64url(n.x, 32), 'y': b64url(n.y, 32)}
proof = jwt.encode(
    {'jti': str(uuid.uuid4()), 'htm': htm, 'htu': htu, 'iat': int(time.time())},
    key, algorithm='ES256', headers={'typ': 'dpop+jwt', 'jwk': jwk},
)
print(proof)
" "$1" "$2"
}

get_user_token() {
  # get_user_token <username> <scope...>
  local username="$1"; shift
  local token_url="$BASE_URL/realms/$REALM/protocol/openid-connect/token"
  curl -s -X POST "$token_url" \
    -H "DPoP: $(dpop_proof POST "$token_url")" \
    -d "client_id=frontend" -d "client_secret=frontend-secret" \
    -d "username=$username" -d "password=password" \
    -d "grant_type=password" -d "scope=$*" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('access_token',''))"
}

exchange() {
  # exchange <client_id> <client_secret> <subject_token> <audience> <scope>
  local client_id="$1" client_secret="$2" subject_token="$3" audience="$4" scope="$5"
  curl -s -X POST "$BASE_URL/realms/$REALM/protocol/openid-connect/token" \
    -u "$client_id:$client_secret" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
    -d "subject_token=$subject_token" \
    -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
    -d "audience=$audience" -d "scope=$scope"
}

record() {
  # record <PASS|FAIL> <message>  -- messageはstderrへ出す。stdoutはコマンド置換で
  # 戻り値を受け取る呼び出し元のために空けておくため。
  echo "$1: $2" >&2
  echo "$1" >> "$RESULTS_FILE"
}

assert_exchange_success() {
  # assert_exchange_success <label> <client_id> <client_secret> <subject_token> <audience> <scope>
  # 交換後のaccess_tokenをstdoutへ出力する（失敗時は""）。呼び出し元がホップを
  # 連鎖させられるようにするため。
  local label="$1"; shift
  local response; response=$(exchange "$@")
  local token; token=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
  if [ -n "$token" ]; then
    record PASS "$label (succeeded as expected)"
  else
    record FAIL "$label (expected success, got: $response)"
  fi
  echo "$token"
}

assert_exchange_denied() {
  # assert_exchange_denied <label> <client_id> <client_secret> <subject_token> <audience> <scope>
  local label="$1"; shift
  local response; response=$(exchange "$@")
  local error; error=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
  if [ -n "$error" ]; then
    record PASS "$label (denied as expected: $error)"
  else
    record FAIL "$label (expected denial, got a token: $response)"
  fi
}

assert_equals() {
  # assert_equals <label> <expected> <actual>
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" == "$actual" ]; then
    record PASS "$label (got $actual)"
  else
    record FAIL "$label (expected $expected, got $actual)"
  fi
}

assert_no_frontend_audience() {
  # assert_no_frontend_audience <label> <jwt>
  # "frontend"をaudienceにマッピングするclient scopeは存在しないため、誰に発行
  # されたトークンもaud=frontendを持つことは無いはずである。frontend->frontend
  # のマスに使う：このマスにはそもそもexchange呼び出しが存在しない
  # （frontendはトークンを交換しない）。
  local label="$1" tok="$2"
  local aud; aud=$(decode_claim "$tok" aud)
  if [ "$aud" != '"frontend"' ] && [[ "$aud" != *'"frontend"'* ]]; then
    record PASS "$label (aud=$aud, does not contain frontend)"
  else
    record FAIL "$label (expected aud to exclude frontend, got $aud)"
  fi
}

echo "=== ログイン：ユーザーごとのロールクレーム伝播 ==="
YAMADA_TOKEN=$(get_user_token yamada-sales "openid order")
assert_equals "yamada-sales has order-writer + inventory-writer + warehouse-viewer roles" '["inventory-writer", "order-writer", "warehouse-viewer"]' "$(decode_claim "$YAMADA_TOKEN" realm_access roles)"

SUZUKI_TOKEN=$(get_user_token suzuki-support "openid order")
assert_equals "suzuki-support has order-reader + inventory-reader roles (no warehouse-viewer)" '["inventory-reader", "order-reader"]' "$(decode_claim "$SUZUKI_TOKEN" realm_access roles)"

TANAKA_TOKEN=$(get_user_token tanaka-hr "openid order")
assert_equals "tanaka-hr has hr-viewer role" '["hr-viewer"]' "$(decode_claim "$TANAKA_TOKEN" realm_access roles)"

SATO_TOKEN=$(get_user_token sato-logistics "openid order")
assert_equals "sato-logistics has warehouse-viewer-all role" '["warehouse-viewer-all"]' "$(decode_claim "$SATO_TOKEN" realm_access roles)"

echo
echo "=== ディシジョンテーブル1：委任トポロジー（docs/permission-matrix.md、全25マス） ==="

# 行: frontend（直接ログイン。この行にexchange呼び出しは存在しない）
assert_no_frontend_audience      "frontend            -> frontend           : DENY" "$YAMADA_TOKEN"
assert_equals                    "frontend            -> order-service      : ALLOW" '"order-service"' "$(decode_claim "$YAMADA_TOKEN" aud)"
TOKEN_URL="$BASE_URL/realms/$REALM/protocol/openid-connect/token"
FRONTEND_INVENTORY=$(curl -s -X POST "$TOKEN_URL" \
  -H "DPoP: $(dpop_proof POST "$TOKEN_URL")" \
  -d "client_id=frontend" -d "client_secret=frontend-secret" \
  -d "username=yamada-sales" -d "password=password" \
  -d "grant_type=password" -d "scope=openid inventory")
assert_equals "frontend            -> inventory-service : DENY" "invalid_scope" "$(echo "$FRONTEND_INVENTORY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))")"
FRONTEND_WAREHOUSE=$(curl -s -X POST "$TOKEN_URL" \
  -H "DPoP: $(dpop_proof POST "$TOKEN_URL")" \
  -d "client_id=frontend" -d "client_secret=frontend-secret" \
  -d "username=yamada-sales" -d "password=password" \
  -d "grant_type=password" -d "scope=openid warehouse")
assert_equals "frontend            -> warehouse-service : DENY" "invalid_scope" "$(echo "$FRONTEND_WAREHOUSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))")"

# 行: order-service（aud=order-serviceのトークンを保有）
assert_exchange_denied           "order-service       -> frontend           : DENY" order-service order-service-secret "$YAMADA_TOKEN" frontend order
assert_exchange_denied           "order-service       -> order-service      : DENY" order-service order-service-secret "$YAMADA_TOKEN" order-service order
HOP1=$(assert_exchange_success   "order-service       -> inventory-service  : ALLOW" order-service order-service-secret "$YAMADA_TOKEN" inventory-service inventory)
assert_exchange_denied           "order-service       -> warehouse-service  : DENY" order-service order-service-secret "$YAMADA_TOKEN" warehouse-service warehouse
assert_exchange_denied           "order-service       -> employee-service   : DENY" order-service order-service-secret "$YAMADA_TOKEN" employee-service employee

# 行: inventory-service（hop1のaud=inventory-serviceトークンを保有）
assert_exchange_denied           "inventory-service    -> frontend          : DENY" inventory-service inventory-service-secret "$HOP1" frontend inventory
assert_exchange_denied           "inventory-service    -> order-service     : DENY" inventory-service inventory-service-secret "$HOP1" order-service order
assert_exchange_denied           "inventory-service    -> inventory-service : DENY" inventory-service inventory-service-secret "$HOP1" inventory-service inventory
HOP2=$(assert_exchange_success   "inventory-service    -> warehouse-service : ALLOW" inventory-service inventory-service-secret "$HOP1" warehouse-service warehouse)
assert_exchange_denied           "inventory-service    -> employee-service  : DENY" inventory-service inventory-service-secret "$HOP1" employee-service employee

# 行: warehouse-service（hop2のaud=warehouse-serviceトークンを保有）
assert_exchange_denied           "warehouse-service    -> frontend          : DENY" warehouse-service warehouse-service-secret "$HOP2" frontend warehouse
assert_exchange_denied           "warehouse-service    -> order-service     : DENY" warehouse-service warehouse-service-secret "$HOP2" order-service order
assert_exchange_denied           "warehouse-service    -> inventory-service : DENY" warehouse-service warehouse-service-secret "$HOP2" inventory-service inventory
assert_exchange_denied           "warehouse-service    -> warehouse-service : DENY" warehouse-service warehouse-service-secret "$HOP2" warehouse-service warehouse
HOP3=$(assert_exchange_success   "warehouse-service    -> employee-service  : ALLOW" warehouse-service warehouse-service-secret "$HOP2" employee-service employee)

# 行: employee-service（standard.token.exchange.enabled=false。全列が同じ構造的
# 理由で拒否される。各列とも自身が正当に保有するトークンで1回ずつ検証する）
assert_exchange_denied           "employee-service     -> frontend          : DENY" employee-service employee-service-secret "$HOP3" frontend employee
assert_exchange_denied           "employee-service     -> order-service     : DENY" employee-service employee-service-secret "$HOP3" order-service order
assert_exchange_denied           "employee-service     -> inventory-service : DENY" employee-service employee-service-secret "$HOP3" inventory-service inventory
assert_exchange_denied           "employee-service     -> warehouse-service : DENY" employee-service employee-service-secret "$HOP3" warehouse-service warehouse
assert_exchange_denied           "employee-service     -> employee-service  : DENY" employee-service employee-service-secret "$HOP3" employee-service employee

echo
echo "=== subとロールが3ホップのチェーン全体を通じて維持されるか ==="
HOP1_SUB=$(decode_claim "$HOP1" sub)
HOP3_SUB=$(decode_claim "$HOP3" sub)
assert_equals "sub unchanged from hop1 to hop3" "$HOP1_SUB" "$HOP3_SUB"
assert_equals "roles still present at hop3 (employee-service)" '["inventory-writer", "order-writer", "warehouse-viewer"]' "$(decode_claim "$HOP3" realm_access roles)"

echo
echo "=== ディシジョンテーブル1、残るマス：frontend -> employee-service : ALLOW ==="
echo "（Keycloak層では、ログイン済みの誰からでも直接到達可能。自分/他人の区別はアプリ層が担い、ここでは検証しない）"
TANAKA_EMPLOYEE_TOKEN=$(get_user_token tanaka-hr "openid employee")
assert_equals "frontend            -> employee-service   : ALLOW" '"employee-service"' "$(decode_claim "$TANAKA_EMPLOYEE_TOKEN" aud)"

PASS_COUNT=$(grep -c '^PASS$' "$RESULTS_FILE" || true)
FAIL_COUNT=$(grep -c '^FAIL$' "$RESULTS_FILE" || true)
echo
echo "=== 結果: $PASS_COUNT 件成功, $FAIL_COUNT 件失敗 ==="
[ "$FAIL_COUNT" -eq 0 ]
