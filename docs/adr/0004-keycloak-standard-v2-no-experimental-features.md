# ADR 0004: Keycloak Standard Token Exchange V2のみ使用（実験的機能を使わない）

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

RFC 8693 の `act` クレームは、サービス間委任チェーンをJWT上で表現する手段。Keycloakでこれを得る方法として2つの候補があった。

| 候補 | 概要 |
|---|---|
| Standard Token Exchange V2 | `act`クレームを生成しない（ダウンスコープのみの新トークンを発行） |
| `token-exchange-delegation`（実験的機能） | `actor_token`を渡すことで`act`クレーム（`may_act`相当）を生成できる |

## Decision

実験的機能には依存せず、**Standard Token Exchange V2 のみを使用する**。

- `token-exchange-delegation`は「管理者がユーザーとして振る舞う（admin-as-user）」ユースケース向けの設計であり、本サンプルの「サービス間多段委任」とは目的が異なる
- 安定機能のみに依存し、Keycloakバージョンアップ時の互換性リスクを避ける

## Consequences

| 観点 | 内容 |
|---|---|
| 委任チェーンの記録 | `act`クレームはJWTに残らない。事後監査はKeycloakイベントログ＋OTelトレースの突合で代替する（[ADR 0005](0005-delegation-audit-with-opentelemetry.md)） |
| RFC 8693上の分類 | `actor_token`を渡さないため、厳密には**Impersonation**に分類される（[architecture.md](../architecture.md) §6参照） |
| トークンサイズ | `act`クレームはホップ数に応じてネストし（外側=現在のアクター、内側=過去のアクター）、ホップを重ねるたびにJWTペイロードが線形に太る（RFC 8693 [§4.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-4.1)）。本サンプルは`act`クレームを持たないため、この増大が発生しない |
| キャッシュ適合性 | `(jti, audience)`突合（[ADR 0012](0012-jti-audience-correlation-for-token-exchange-audit.md)）は同じトークンが複数リクエストに跨って再利用されても偽陽性を生まない設計。トークン自体が経路の証跡を持たないからこそ再利用しても監査上の意味が変わらず、キャッシュ（[ADR 0013](0013-token-exchange-result-caching.md)）を安全に導入できる。結果としてToken Exchangeのたびに発生するKeycloakへのラウンドトリップを実際に削減できている |
| 業界動向 | `act`クレームの限界（各ホップの認可制約・スコープ縮小を表現できない、`actor_token`に委任元の暗号学的確認が伴わない）を指摘し`delegation_chain`クレームを提案する[draft-liu-oauth-chain-delegation](https://www.ietf.org/archive/id/draft-liu-oauth-chain-delegation-00.html)（2026-06公開のInternet-Draft、未採択）が存在する。トークン内に経路の証跡を持たせず外部監査（ADR 0005・ADR 0012）に委ねる本サンプルの構成は、この複雑さを避ける選択とも言える |
