# ADR 0010: アプリ層認可拒否ログをauthz_denyとして記録（異常検知・デバッグ用）

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

アプリ層の認可判断（特に DENY）を記録するかどうか、記録するなら何を目的としどう位置づけるかを決める必要があった。§9・§10 の監査設計（独立した2ソースを突き合わせて矛盾を検出する）と同じ枠組みで扱えるかも検討した。

アプリ層の認可判断ログは、判断を下したコード自身が記録する「自己申告」であり、判断の正しさを立証する独立した第二のソースが存在しない。また DENY 自体（例: 支店不一致による引当拒否）は業務ルール通りの正常系の一部であり、不正の兆候ではない。

## Decision

「監査」ではなく「**異常検知・デバッグの手がかり**」として位置づけ、**DENY のみ**を `authz_deny` ログ行として `access_log` とは別行で記録する。

記録フィールド: `type`（固定値 `"authz_deny"`）・`sub`・`jti`・`trace_id`・`reason`

対象サービス:
- **Warehouse Service**（`authorize_branch`）: RBAC の `role_missing`、ABAC の `branch_mismatch`／`employee_branch_unknown` を `branch`・`employee_branch` フィールドとともに記録
- **Inventory Service**（`authMiddleware`）: RBAC の `role_missing` を `required_roles` フィールドとともに記録

## Consequences

- Order Service・Employee Service は認可判断軸が「ロールの有無」の1軸のみで、`access_log` の status=403 だけで理由が読み取れるため対象外。
- PERMIT ログは不採用。`access_log` の status=200/201 が既に PERMIT の事実であり、情報量が増えない。
- `access_log` への埋め込みは不採用。`access_log` の共通フォーマットを崩さず、DENY が発生した箇所でのみログが増える構造を維持する。
- `audit/audit.py`（CHECK1〜3）は `type = "access_log"` でフィルタしており、`authz_deny` 行は無関係のため影響しない。
