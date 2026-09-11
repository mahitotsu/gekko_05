#!/usr/bin/env python3
"""
Token Exchange 監査スクリプト

各ソース（サービスのアクセスログ、Keycloakのイベントログ）が独立に主張する事実を
識別子（jti/sub）単位の集合として集め、突き合わせて矛盾がないかを検証する。個々の
リクエストの流れ（trace_id）を追跡・再現するのではなく集合演算に還元することで、
トークンのキャッシュ再利用や並列処理といった実装上の変動に依存しない、決定論的な
判定にする（設計判断の経緯は docs/adr/0012-jti-based-token-exchange-audit.md 参照）。

実行ログ（クエリ内容・取得件数）は標準出力にそのまま流れる。レポートには違反時の
識別子（jti/sub）のみを載せる — 生ログの全件ダンプは行わない（cf. docs/insights.md）。

実行:  docker compose --profile audit run --rm audit
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

import requests

LOKI_URL = os.environ.get("LOKI_URL", "http://otel-lgtm:3100")
WINDOW_SECONDS = int(os.environ.get("AUDIT_WINDOW_SECONDS", "3600"))
# CHECK2用：Keycloak TOKEN_EXCHANGEイベントの遡り幅。中継トークンが発行直後ではなく
# TTL内でキャッシュ再利用された場合、利用時刻はウィンドウ内でも発行（交換）自体は
# ウィンドウ開始より前に起きていることがある。中継トークンのTTLは60秒
# （keycloak/realm-export.json、architecture.md §11）なので、余裕を見て5分遡る。
EXCHANGE_LOOKBACK_SECONDS = int(os.environ.get("AUDIT_EXCHANGE_LOOKBACK_SECONDS", "300"))
WIDTH = 70

# frontend/order-service：ユーザーのブラウザセッション（BFF）に最も近い層。
USER_FACING_SERVICES = "frontend|order-service"
# inventory/warehouse/employee-service：委任チェーンの2ホップ目以降。
DOWNSTREAM_SERVICES = "inventory-service|warehouse-service|employee-service"
# Token Exchangeで受け取ったトークンのみを保持するサービス群（=frontend以外の
# 全バックエンド）。frontendだけは例外で、ブラウザログイン（authorization_code）で
# 得た「本人のセッショントークン」を保持する——これはToken Exchangeの
# "subject_token"（交換の入力）であって"発行結果"ではないため、CHECK2の対象には
# 含めない。Keycloakが"発行した"という記録を持つのは、このセッショントークンを
# 元に交換されたこれより後の各トークンのみ。
EXCHANGED_TOKEN_SERVICES = "order-service|inventory-service|warehouse-service|employee-service"


# ── Loki クエリ ──────────────────────────────────────────────────────────────

def query_loki(logql: str, start_ns: int, end_ns: int, limit: int = 5000) -> list[dict]:
    print(f"    [query] {logql}")
    try:
        resp = requests.get(
            f"{LOKI_URL}/loki/api/v1/query_range",
            params={"query": logql, "start": start_ns, "end": end_ns,
                    "limit": limit, "direction": "forward"},
            timeout=30,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"    [error] Loki クエリ失敗: {e}", file=sys.stderr)
        return []

    entries = []
    for stream in resp.json().get("data", {}).get("result", []):
        labels = stream.get("stream", {})
        for ts_ns, line in stream.get("values", []):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                parsed = {"_raw": line}
            parsed.setdefault("_ts_ns", int(ts_ns))
            parsed.setdefault("_service", labels.get("service", ""))
            entries.append(parsed)
    print(f"    [result] {len(entries)} 件取得")
    if len(entries) >= limit:
        print(f"    [warn] limit={limit} に到達。ウィンドウ内の実件数が上限を超えて"
              f"いる可能性があり、以降の集合突合が不完全になりうる。", file=sys.stderr)
    return entries


def kv_extract(line: str, key: str) -> str | None:
    """Keycloak イベントログから key="value" または key=value 形式のフィールドを取り出す。

    実ログ例: `traceId=dce61dc4..., ... type="LOGIN_ERROR", ..., userId="null", ...`
    値はダブルクォートで囲まれる場合とそうでない場合が混在し、直前のフィールドと
    カンマで区切られていない（timestampの後ろに続く等）ため、カンマ分割ではなく
    正規表現で直接 `key=` の出現位置から値を抜き出す。
    """
    m = re.search(rf'{re.escape(key)}="?([^",]*)"?', line)
    if not m:
        return None
    return m.group(1) or None


def ts_str(ns: int) -> str:
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).strftime("%H:%M:%S")


def header(title: str, desc: str) -> None:
    print(f"\n{'━'*WIDTH}")
    print(f"  CHECK: {title}")
    print(f"  {desc}")


# ── CHECK 1: 隣接ホップ間のjti使い回し検出 ───────────────────────────────────

def check1(start_ns: int, end_ns: int) -> bool:
    header(
        "Token Exchange バイパス検出（隣接ホップ間のjti使い回し）",
        "user-facing層とdownstream層のjtiが重複していないことを確認する"
        "（重複 = 同一トークンがExchangeを経ずに複数ホップで使い回されている。"
        "1回のExchangeが要求スコープ次第で複数audienceを持つトークンを生成しうる"
        "ケースの防御であり、CHECK2の(jti,audience)照合とは独立した観点）。",
    )

    user_logs = query_loki(
        f'{{service=~"{USER_FACING_SERVICES}"}} | json | type = "access_log"',
        start_ns, end_ns,
    )
    ds_logs = query_loki(
        f'{{service=~"{DOWNSTREAM_SERVICES}"}} | json | type = "access_log"',
        start_ns, end_ns,
    )

    user_jtis = {e["jti"]: e for e in user_logs if e.get("jti") not in (None, "-", "")}
    ds_jtis = {e["jti"]: e for e in ds_logs if e.get("jti") not in (None, "-", "")}
    bypassed = sorted(user_jtis.keys() & ds_jtis.keys())

    print(f"  user-facing jti 数 : {len(user_jtis)}")
    print(f"  downstream  jti 数 : {len(ds_jtis)}")
    if bypassed:
        print(f"  ✗ バイパス検出 {len(bypassed)} 件:")
        for jti in bypassed:
            ue, de = user_jtis[jti], ds_jtis[jti]
            print(f"    jti={jti}")
            print(f"      user-facing : {ue['_service']} sub={ue.get('sub','-')} at {ts_str(ue['_ts_ns'])}")
            print(f"      downstream  : {de['_service']} sub={de.get('sub','-')} at {ts_str(de['_ts_ns'])}")
        return False
    print("  ✓ jti の重複なし")
    return True


# ── CHECK 2: downstreamで使われた全jtiがKeycloakの発行記録で裏付けられているか ──

def parse_token_exchange_events(kc_logs: list[dict]) -> dict[tuple[str, str], dict]:
    """Keycloakの生ログ行から (token_id, audience) をキーにした発行記録を作る。

    実機確認済み：KeycloakのTOKEN_EXCHANGEイベントには、発行したトークンのjti
    （`token_id`フィールド）と要求されたaudienceがそのまま記録される。
    例: `type="TOKEN_EXCHANGE", ..., audience="inventory-service", ...,
         token_id="ntrtte:6ff32546-...", ...`
    この `token_id` の値は、後段サービスのaccess_logに記録される `jti` と完全一致
    する（同一トークンの同一クレームを別ソースから見ているだけなので当然だが、
    実ログで突合できることを確認済み）。
    """
    records: dict[tuple[str, str], dict] = {}
    for e in kc_logs:
        raw = e.get("_raw")
        if raw is None:
            continue
        token_id = kv_extract(raw, "token_id")
        audience = kv_extract(raw, "audience")
        if not token_id or not audience:
            continue
        user_id = kv_extract(raw, "userId")
        records[(token_id, audience)] = {"sub": user_id, "_ts_ns": e["_ts_ns"]}
    return records


def check2(start_ns: int, end_ns: int) -> bool:
    header(
        "downstreamで使われたjtiの正当性確認",
        "各バックエンドサービス（frontend以外の全て）で使われた(jti, audience)の組が、"
        "KeycloakのTOKEN_EXCHANGE発行記録に存在するかを確認する。trace_idではなく"
        "jti自体で突合するため、同一トークンが複数リクエストに跨ってキャッシュ・"
        "再利用されても偽陽性にならない（trace_id相関だとリクエスト単位でしか見え"
        "ないため、正当なキャッシュ再利用が「対応する交換なし」と誤検知されうる）。",
    )

    ds_logs = query_loki(
        f'{{service=~"{EXCHANGED_TOKEN_SERVICES}"}} | json | type = "access_log" | status != 401',
        start_ns, end_ns,
    )
    # exchangeイベントの取得だけウィンドウ開始をEXCHANGE_LOOKBACK_SECONDS遡る
    # （キャッシュされたトークンの発行時刻がウィンドウより前になりうるため）。
    kc_logs = query_loki(
        '{service="keycloak"} |= "TOKEN_EXCHANGE"',
        start_ns - EXCHANGE_LOOKBACK_SECONDS * int(1e9), end_ns,
    )
    exchanged = parse_token_exchange_events(kc_logs)

    # (jti, audience) ごとに集約する：同一トークンが何度使われても1件として扱う
    # ——これが「trace単位」ではなく「トークン単位」で監査するということ。
    seen: dict[tuple[str, str], dict] = {}
    for e in ds_logs:
        jti = e.get("jti")
        if not jti or jti in ("-", ""):
            continue
        audience = e.get("_service")
        key = (jti, audience)
        if key not in seen:
            seen[key] = e

    no_record = []
    sub_mismatch = []
    for (jti, audience), e in seen.items():
        record = exchanged.get((jti, audience))
        if record is None:
            no_record.append((jti, audience, e))
        elif record["sub"] and record["sub"] != e.get("sub"):
            sub_mismatch.append((jti, audience, e, record["sub"]))

    print(f"  downstream (jti,audience) 数 : {len(seen)}")
    print(f"  TOKEN_EXCHANGE 記録確認済み  : {len(seen) - len(no_record) - len(sub_mismatch)}")

    ok = True
    if no_record:
        ok = False
        print(f"  ✗ TOKEN_EXCHANGE 記録なし {len(no_record)} 件"
              "（Exchangeを経ずに発行された、または全く別経路のトークン）:")
        for jti, audience, e in sorted(no_record, key=lambda v: v[2]["_ts_ns"]):
            print(f"    jti={jti}  audience={audience}  {e.get('method','')} {e.get('path','')}"
                  f"  sub={e.get('sub','-')}  status={e.get('status','-')}  at {ts_str(e['_ts_ns'])}")
    if sub_mismatch:
        ok = False
        print(f"  ✗ sub不一致 {len(sub_mismatch)} 件（発行時のuserIdと利用時のsubが異なる）:")
        for jti, audience, e, exchanged_sub in sorted(sub_mismatch, key=lambda v: v[2]["_ts_ns"]):
            print(f"    jti={jti}  audience={audience}  利用時sub={e.get('sub','-')}"
                  f"  発行時userId={exchanged_sub}  at {ts_str(e['_ts_ns'])}")
    if not no_record and not sub_mismatch:
        if not seen:
            print("  （対象ログなし：ウィンドウ内にdownstreamアクセスがなかった）")
        else:
            print("  ✓ 全downstreamアクセスがTOKEN_EXCHANGE記録と整合")
    return ok


# ── CHECK 3: LOGIN前アクセスの有無 ─────────────────────────────────────────

def check3(start_ns: int, end_ns: int) -> bool:
    header(
        "LOGIN 前アクセスの有無",
        "アクセスログに現れた各subについて、それより前にKeycloak LOGINイベントが"
        "存在するかを確認する。ウィンドウ内にLOGINが見つからない場合は「ウィンドウ"
        "より前にログインしてセッションを継続している」可能性と区別できないため、"
        "違反とは扱わず参考情報としてのみ報告する。真の違反はLOGINがアクセスより"
        "後（＝認証前アクセス）になっているケースのみ。",
    )

    svc_logs = query_loki(
        f'{{service=~"{USER_FACING_SERVICES}|{DOWNSTREAM_SERVICES}"}} | json | type = "access_log"',
        start_ns, end_ns,
    )
    # Keycloak の実ログは値をダブルクォートで囲む（type="LOGIN"）。閉じクォートまで
    # 含めることで type="LOGIN_ERROR" 等の部分一致を除外する。
    kc_logs = query_loki('{service="keycloak"} |= "type=\\"LOGIN\\""', start_ns, end_ns)

    first_access: dict[str, tuple[int, str]] = {}
    for e in svc_logs:
        sub = e.get("sub")
        if not sub or sub == "-":
            continue
        ts = e["_ts_ns"]
        if sub not in first_access or ts < first_access[sub][0]:
            first_access[sub] = (ts, e["_service"])

    login_ts: dict[str, int] = {}
    for e in kc_logs:
        uid = e.get("userId") or e.get("user_id")
        if not uid and "_raw" in e:
            uid = kv_extract(e["_raw"], "userId")
        if uid:
            ts = e["_ts_ns"]
            if uid not in login_ts or ts < login_ts[uid]:
                login_ts[uid] = ts

    hard_violations = []  # LOGIN > access：認証前アクセス、真の違反
    info_only = []        # ウィンドウ内にLOGIN記録なし：違反と断定できない参考情報
    for sub, (access_ts, first_svc) in first_access.items():
        login = login_ts.get(sub)
        if login is None:
            info_only.append((sub, access_ts, first_svc))
        elif login > access_ts:
            hard_violations.append((sub, login, access_ts, first_svc))

    print(f"  ユニーク sub 数       : {len(first_access)}")
    print(f"  LOGIN 先行確認済み     : {len(first_access) - len(hard_violations) - len(info_only)}")
    if info_only:
        print(f"  ・ウィンドウ内にLOGIN記録なし（参考情報。違反とは断定しない） {len(info_only)} 件:")
        for sub, access_ts, svc in sorted(info_only, key=lambda v: v[1]):
            print(f"    sub={sub}  初回アクセス={ts_str(access_ts)}({svc})")
    if hard_violations:
        print(f"  ✗ LOGINよりアクセスが先行（真の違反） {len(hard_violations)} 件:")
        for sub, login, access_ts, svc in sorted(hard_violations, key=lambda v: v[2]):
            print(f"    sub={sub}  LOGIN={ts_str(login)}  初回アクセス={ts_str(access_ts)}({svc})")
        return False
    if not first_access:
        print("  （対象ログなし：ウィンドウ内にアクセスがなかった）")
    elif not info_only:
        print("  ✓ 全 sub に LOGIN の先行を確認")
    return True


# ── エントリポイント ──────────────────────────────────────────────────────────

def main() -> None:
    now_ns = int(datetime.now(timezone.utc).timestamp() * 1e9)
    start_ns = now_ns - WINDOW_SECONDS * int(1e9)
    window_end = datetime.fromtimestamp(now_ns / 1e9, tz=timezone.utc)
    window_start = datetime.fromtimestamp(start_ns / 1e9, tz=timezone.utc)

    print(f"{'━'*WIDTH}")
    print("  Token Exchange 監査レポート")
    print(f"  Loki : {LOKI_URL}")
    print(f"  期間 : {window_start:%Y-%m-%d %H:%M:%S} UTC ～ {window_end:%Y-%m-%d %H:%M:%S} UTC"
          f" ({WINDOW_SECONDS // 60} 分間)")
    print(f"{'━'*WIDTH}")

    results = [
        check1(start_ns, now_ns),
        check2(start_ns, now_ns),
        check3(start_ns, now_ns),
    ]

    ok = all(results)
    marks = ["✓" if r else "✗" for r in results]
    print(f"\n{'━'*WIDTH}")
    print(f"  総合判定:  CHECK1={marks[0]}  CHECK2={marks[1]}  CHECK3={marks[2]}")
    print(f"  結論    :  {'✓ 異常は検出されなかった' if ok else '✗ 要確認の項目がある（上記の ✗ 行を参照）'}")
    print(f"{'━'*WIDTH}\n")

    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
