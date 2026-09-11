# ADR 0004: Keycloak Standard Token Exchange V2のみ使用（実験的機能を使わない）

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

RFC 8693 の `act` クレームはサービス間委任チェーンを JWT 上で表現する手段として理想的だが、Keycloak の Standard Token Exchange V2 では標準では生成されない。`token-exchange-delegation` 等の実験的機能を使えば `may_act` 相当を利用できる。

## Decision

実験的機能には依存せず、**Standard Token Exchange V2 のみを使用する**。

## Consequences

- `act` クレームは委任後の JWT に残らない。委任チェーンの事後監査はKeycloakイベントログとOTelトレースの突合で代替する（ADR 0005）。
- `token-exchange-delegation` は「管理者がユーザーとして振る舞う（admin-as-user）」ユースケース向けの設計であり、本サンプルの「サービス間多段委任」とは目的が異なるため採用対象として適切でない。
- 安定機能のみに依存することで、Keycloak バージョンアップ時の互換性リスクを低減する。
