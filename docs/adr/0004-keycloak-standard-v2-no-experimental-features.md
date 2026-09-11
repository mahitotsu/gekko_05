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
- **`act`クレームが無いこと（＝RFC 8693上はImpersonationに分類される、[architecture.md](../architecture.md) §6参照）は制約だけでなく利点もある。**RFC 8693 [§4.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-4.1)の`act`クレームはホップ数に応じてネストする構造（外側が現在のアクター、内側にいくほど過去のアクター）で、ホップを重ねるたびにJWTペイロードが線形に太る。RFC自体は「認可判断はトップレベルのクレームと現在のアクターのみを考慮しなければならない（MUST）。ネストされた過去のアクターは情報提供のみで認可判断には使用しない」と定めており、認可判断コスト自体は本来ホップ数に対して一定のはずだが、実運用ではトークンサイズの増大がヘッダーサイズ上限やキャッシュ効率（ADR 0013）に影響しうる。本サンプルのように3ホップそれぞれでToken Exchangeを都度実行する構成では、`act`クレームを持たない分トークンが軽量に保たれる恩恵がある
- トレードオフとして「どのサービスを経由してきたか」という証跡がトークン自体には残らない。この情報は要件（[requirements.md](../requirements.md)「委任チェーンの事後監査」）に基づき、トークンの外側にある監査機構（ADR 0005・ADR 0012）で別途保証している——`act`クレームの限界（各ホップの認可制約・スコープ縮小を表現できない、`actor_token`が委任元の暗号学的な確認を伴わない等）を指摘し`delegation_chain`クレームを提案する[draft-liu-oauth-chain-delegation](https://www.ietf.org/archive/id/draft-liu-oauth-chain-delegation-00.html)（2026年6月のInternet-Draft、未採択）が示すように、`act`クレーム単体で委任チェーンの認可制約まで表現しようとする設計には別の複雑さが伴う。トークン内に証跡を持たせず外部監査に委ねる本サンプルの構成は、その複雑さを避ける選択とも言える
