#!/usr/bin/env python3
"""
Token Exchange 監査スクリプト

3つの不変条件を Loki ログから検証する。実行ログ（クエリ内容・取得件数）は
標準出力にそのまま流れる。レポートには違反時の識別子（trace_id/jti/sub）
のみを載せる — 生ログの全件ダンプは行わない（cf. docs/insights.md）。

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
WIDTH = 70


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


# ── CHECK 1: Token Exchange バイパス検出 ─────────────────────────────────────

def check1(start_ns: int, end_ns: int) -> bool:
    header(
        "Token Exchange バイパス検出",
        "user-facing 層と downstream 層の jti が重複していないことを確認する"
        "（重複 = Exchangeを経ずに上位層のトークンを下位層に持ち込んでいる）。",
    )

    user_logs = query_loki(
        '{service=~"frontend|order-service"} | json | type = "access_log"',
        start_ns, end_ns,
    )
    ds_logs = query_loki(
        '{service=~"inventory-service|warehouse-service|employee-service"}'
        ' | json | type = "access_log"',
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


# ── CHECK 2: TOKEN_EXCHANGE ↔ downstream アクセス対応確認 ────────────────────

def check2(start_ns: int, end_ns: int) -> bool:
    header(
        "TOKEN_EXCHANGE ↔ downstream アクセス対応確認",
        "downstream サービスへアクセスがあった trace_id ごとに、"
        "同一traceのKeycloak TOKEN_EXCHANGEイベントの存在を確認する。",
    )

    # status != 401 を除外: 認証失敗（無効トークン）は Exchange の対応証跡を
    # 求める対象ではない。
    ds_logs = query_loki(
        '{service=~"inventory-service|warehouse-service|employee-service"}'
        ' | json | type = "access_log" | status != 401',
        start_ns, end_ns,
    )
    kc_logs = query_loki('{service="keycloak"} |= "TOKEN_EXCHANGE"', start_ns, end_ns)

    ds_by_trace: dict[str, dict] = {}
    for e in ds_logs:
        tid = e.get("trace_id")
        if tid and tid not in ("-", "") and tid not in ds_by_trace:
            ds_by_trace[tid] = e

    kc_traces: set[str] = set()
    for e in kc_logs:
        tid = (e.get("trace_id") or e.get("traceId") or e.get("TraceId"))
        if not tid and "_raw" in e:
            tid = kv_extract(e["_raw"], "traceId") or kv_extract(e["_raw"], "trace_id")
        if tid and tid not in ("-", ""):
            kc_traces.add(tid)

    missing = sorted(
        (t for t in ds_by_trace if t not in kc_traces),
        key=lambda t: ds_by_trace[t]["_ts_ns"],
    )

    print(f"  downstream trace 数        : {len(ds_by_trace)}")
    print(f"  TOKEN_EXCHANGE 対応確認済み : {len(ds_by_trace) - len(missing)}")
    if missing:
        print(f"  ✗ TOKEN_EXCHANGE 未記録 {len(missing)} 件:")
        for tid in missing:
            e = ds_by_trace[tid]
            print(f"    trace_id={tid}  {e['_service']} {e.get('method','')} {e.get('path','')}"
                  f"  sub={e.get('sub','-')}  at {ts_str(e['_ts_ns'])}")
        return False
    if not ds_by_trace:
        print("  （対象ログなし：ウィンドウ内に downstream アクセスがなかった）")
        return True
    print("  ✓ 全 trace に TOKEN_EXCHANGE イベントが対応")
    return True


# ── CHECK 3: LOGIN 前アクセスの有無 ─────────────────────────────────────────

def check3(start_ns: int, end_ns: int) -> bool:
    header(
        "LOGIN 前アクセスの有無",
        "アクセスログに現れた各subについて、同一ウィンドウ内にそれ以前の"
        "Keycloak LOGINイベントが存在するかを確認する"
        "（LOGINがウィンドウ外の場合は「ウィンドウ内未記録」と報告されるが違反とは限らない）。",
    )

    svc_logs = query_loki(
        '{service=~"order-service|inventory-service|warehouse-service'
        '|employee-service|frontend"} | json | type = "access_log"',
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

    violations = []
    for sub, (access_ts, first_svc) in first_access.items():
        login = login_ts.get(sub)
        if login is None:
            violations.append((sub, "LOGIN記録なし（ウィンドウ内未記録）", access_ts, first_svc))
        elif login > access_ts:
            violations.append((sub, f"LOGINよりアクセスが先行 (LOGIN={ts_str(login)})", access_ts, first_svc))

    print(f"  ユニーク sub 数       : {len(first_access)}")
    print(f"  LOGIN 先行確認済み     : {len(first_access) - len(violations)}")
    if violations:
        print(f"  ✗ 要確認 {len(violations)} 件:")
        for sub, reason, access_ts, svc in sorted(violations, key=lambda v: v[2]):
            print(f"    sub={sub}  {reason}  初回アクセス={ts_str(access_ts)}({svc})")
        return False
    if not first_access:
        print("  （対象ログなし：ウィンドウ内にアクセスがなかった）")
        return True
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
