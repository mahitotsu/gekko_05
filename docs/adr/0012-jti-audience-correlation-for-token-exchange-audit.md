# ADR 0012: Token Exchange監査の突合キーをtrace_idから(jti, audience)へ変更

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

[ADR 0005](0005-delegation-audit-with-opentelemetry.md)で導入した`audit/audit.py`のCHECK2は、downstreamサービスへのアクセスがあった`trace_id`ごとに、同一traceでKeycloakのTOKEN_EXCHANGEイベントが記録されているかを確認する設計だった。運用に近い形で見直した結果、以下の問題が判明した。

| 問題 | 内容 |
|---|---|
| trace_idはリクエスト単位の相関にしかならない | 中継トークンを「発行のたびに使い捨てる」実装は現状そうなっている（各APIハンドラが毎回`exchangeForAudience`/`TokenExchangeClient.exchange`を呼ぶ）が、これは実装上の選択であって不変の前提ではない。将来キャッシュして複数リクエストに跨って再利用する実装に変えた場合、2回目以降のリクエストは新たなtrace_idを持つ一方、対応するTOKEN_EXCHANGEイベントはキャッシュされた1回分しか存在せず、CHECK2は「対応するTOKEN_EXCHANGEが無い」として誤検知する |
| trace_idの伝播が途切れると偽陽性になる | `docs/audit-demo.md`の実例（OTelの計装が及ばない経路から手動でToken Exchangeを実行したケース）が示す通り、trace_id相関は「実際にExchangeを経ずに使われた」ケースと「Exchangeは正当だがtrace伝播が途切れただけ」のケースを区別できない |

いずれも根本原因は同じ：trace_idは「このリクエストの経路」を表す値であり、「このトークンが正当に発行されたか」という監査したい事実そのものではない。

一方、実機検証（Keycloak 26.4）でTOKEN_EXCHANGEイベントログの実際のフィールドを確認したところ、発行したトークンのjti（`token_id`フィールド）と要求されたaudience（`audience`フィールド）、対象ユーザー（`userId`フィールド）がそのまま記録されていることが分かった。

```
type="TOKEN_EXCHANGE", ..., audience="inventory-service", ...,
token_id="ntrtte:6ff32546-3349-41c9-2977-ff73fcf879ca", ..., userId="c98454aa-..."
```

この`token_id`は、当該トークンを受け取ったdownstreamサービスのアクセスログに記録される`jti`と（プレフィックス`ntrtte:`/`onrtte:`等を含めて）完全に一致することを実データで確認済み。このプレフィックスはKeycloakのToken Exchange V2が内部的に付与するもの（要求元クライアントごとに異なる値になる）で、ロジック側がこの形式に依存する必要はない——単なる文字列としてtrace_idと同様に扱えばよい。

## Decision

CHECK2の突合キーを`trace_id`から**`(jti, audience)`のペア**に変更する。

- 対象は「Token Exchangeで受け取ったトークンのみを保持するサービス」全て（order-service・inventory-service・warehouse-service・employee-service）。frontendは対象外——ブラウザログイン（authorization_code）で得た「本人のセッショントークン」を保持するという例外的な立場であり、Keycloakが"発行した"記録を持つのはこのセッショントークンを元に交換された後続のトークンのみである
- Keycloakの`TOKEN_EXCHANGE`イベントから`(token_id, audience)`の集合を作り、各サービスのアクセスログに現れる`(jti, service)`の集合がこれに包含されているかを確認する
- 副次的に`userId`（発行時のsub）とアクセスログの`sub`が一致するかも確認する
- 集合演算のため、同一トークンが何度使われても1件として扱われる。キャッシュ再利用は最初から偽陽性の余地がない
- CHECK2の「downstream」対象がinventory/warehouse/employee-serviceのみだったのをorder-serviceにも広げる。order-serviceが受け取るトークンもToken Exchangeの発行結果であり、同じ不変条件の対象であるべきだったため

CHECK1（隣接ホップ間のjti使い回し検出、user-facing⇔downstreamのjti集合の重複確認）は変更しない。これは「1回の交換が複数audienceを持つトークンを発行し、それが隣接ホップでそのまま再提示される」という、(jti, audience)の包含チェックだけでは捉えられない別の不変条件であり、独立した価値がある。

## Consequences

| 観点 | 内容 |
|---|---|
| OTelトレースへの依存解消 | CHECK2はOTelのtrace伝播が及ぶ範囲に依存しなくなった。手動検証・計装されていないツール経由のアクセスであっても、Keycloakの発行記録さえあれば正しく「正当」と判定される |
| キャッシュとの両立 | 将来、委任チェーンの中継トークンをキャッシュして複数リクエストで再利用する実装に変えても、CHECK2は偽陽性を出さない（実装・検証は[ADR 0013](0013-token-exchange-result-caching.md)） |
| クエリのlookback | Keycloakへの`TOKEN_EXCHANGE`イベントクエリは、レポート対象ウィンドウの開始時刻より`AUDIT_EXCHANGE_LOOKBACK_SECONDS`（既定300秒）遡って取得する。中継トークンのTTLは60秒（architecture.md §8）だが、キャッシュされたトークンの発行時刻がウィンドウ開始前になりうるケースに余裕を持たせるため |
| 実際に検知できた例 | order-serviceの資格情報で、Token Exchange専用のoptional client scope（`inventory`、[ADR 0007](0007-topology-control-via-optional-client-scopes.md)）をclient_credentialsグラントで直接要求し、Token Exchangeを経ずにaudience=inventory-serviceのトークンを取得してinventory-serviceへ直接アクセスするケース。Keycloakはこれを`type="CLIENT_LOGIN"`として記録し`TOKEN_EXCHANGE`イベントを生成しないため、CHECK2が確実に検知する（詳細と実行結果は[audit-demo.md](../audit-demo.md)） |
| trace_idの役割 | 経路の可視化・デバッグの手段としては引き続き有効であり撤去しない（[ADR 0005](0005-delegation-audit-with-opentelemetry.md)の役割分担は維持）。監査の正当性判定の根拠としてのみ使わなくなった |
