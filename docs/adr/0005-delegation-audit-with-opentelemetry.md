# ADR 0005: 委任チェーン監査にOpenTelemetry（W3C Trace Context）を採用

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

多段委任チェーンを通じた「誰が誰の代わりにどこを呼んだか」という経路を事後に検証・可視化する手段を決める必要があった。候補は独自ヘッダ／ログ形式（例: `X-Delegation-Chain`）の自作と、W3C Trace Context標準への準拠。

## Decision

**OpenTelemetry（W3C Trace Context）** に従い、`traceparent` ヘッダで `trace_id` を全ホップに伝播する。可視化には **`grafana/otel-lgtm`** を採用する。

- 独自ヘッダ・独自ログ形式は発明しない：署名も検証もされず認可判断の根拠にできないため不採用
- 認可トポロジーのリアルタイム制御は optional client scope の割当が担う（ADR 0007）。認可交換の事実の記録は Keycloak 管理イベントログが担い、OTel トレースは経路の可視化を担う。役割が異なるため両方を維持する

## Consequences

| 観点 | 内容 |
|---|---|
| 可視化基盤 | `grafana/otel-lgtm` は Grafana+Tempo+Loki+Prometheus が1コンテナに統合された公式イメージで、OTLPエンドポイントが1つで完結し設定不要。Jaeger等との連携も失われない |
| イベントログの既定設定 | `eventsEnabled`はデフォルト`false`で、LOGIN/TOKEN_EXCHANGE等の成功イベントは最初から一切記録されない（実機で`GET /admin/realms/{realm}/events/config`を確認して判明。DPoP proof欠落等の認証エラーは`eventsEnabled`と無関係に別経路でWARNログに出るため「イベントログ自体は機能している」と誤認しやすい）。`realm-export.json`に`"eventsEnabled": true, "eventsListeners": ["jboss-logging"]`を追加して有効化した（Dockerfileに焼き込まれるため`docker compose build keycloak`での再ビルドが必要） |
| 成功イベントのログレベル | `eventsEnabled`を有効化しても、成功イベントのデフォルトログレベルはDEBUGで、ルートのINFO設定では出力されない。`KC_SPI_EVENTS_LISTENER_JBOSS_LOGGING_SUCCESS_LEVEL: "info"`を追加して解決した（実機で確認：追加前は成功イベントが0件、追加後は`type="LOGIN"`/`type="TOKEN_EXCHANGE"`を確認） |
| traceIdの自動付与 | `KC_TRACING_ENABLED=true`の環境下では、イベントログ行に`traceId=…`が追加実装なしに自動付与される。各サービスの`traceparent`伝播と組み合わせ、KeycloakイベントログとOTelトレースをtrace_idで機械的に突合できることを確認した |
