# ADR 0005: 委任チェーン監査にOpenTelemetry（W3C Trace Context）を採用

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

多段委任チェーンを通じた「誰が誰の代わりにどこを呼んだか」という経路を事後に検証・可視化する手段を決める必要があった。

## Decision

**OpenTelemetry（W3C Trace Context）** に従い、`traceparent` ヘッダで `trace_id` を全ホップに伝播する。独自ヘッダや独自ログ形式は発明しない。可視化には **`grafana/otel-lgtm`** を採用する。

## Consequences

- 独自ヘッダ（例: `X-Delegation-Chain`）は、署名も検証もされず認可判断の根拠にできないため不採用。
- 認可トポロジーのリアルタイム制御は optional client scope の割当が担う（ADR 0007）。認可交換の事実の記録は Keycloak 管理イベントログが担い、OTel トレースは経路の可視化を担う。役割が異なるため両方を維持する。
- `grafana/otel-lgtm` は Grafana+Tempo+Loki+Prometheus が1コンテナに統合された公式イメージで、OTLPエンドポイントが1つで完結し設定不要。Jaeger等との連携も失われない。
- **Keycloakのイベントログはデフォルトでは出力されない**：`eventsEnabled`はデフォルト`false`で、LOGIN/TOKEN_EXCHANGE等の成功イベントは最初から一切記録されない（実機で`GET /admin/realms/{realm}/events/config`を確認して判明。DPoP proof欠落等の認証エラー`LOGIN_ERROR`は`eventsEnabled`に関係なく別経路でWARNログに出るため、「イベントログ自体は機能している」と誤認しやすい）。`keycloak/realm-export.json`のトップレベルに`"eventsEnabled": true, "eventsListeners": ["jboss-logging"]`を追加して有効化した（この変更はDockerfileの`COPY realm-export.json ...`でイメージに焼き込まれるため、`docker compose build keycloak`での再ビルドが必要）。
- **成功イベントはデフォルトでDEBUGログレベル**：`eventsEnabled`を有効化しても、`JBossLoggingEventListenerProvider`の成功イベント（LOGIN/TOKEN_EXCHANGE等）のデフォルトログレベルはDEBUGで、ルートのINFOレベル設定では出力されない（エラーイベントはWARNがデフォルトのため最初から見えていた）。`compose.yml`のkeycloakサービスに`KC_SPI_EVENTS_LISTENER_JBOSS_LOGGING_SUCCESS_LEVEL: "info"`を追加して解決した。実機で確認：追加前は`docker logs`に成功イベントが1行も出ず、追加後は`type="LOGIN"`/`type="TOKEN_EXCHANGE"`が確認できた。
- **traceIdは追加実装なしにイベントログへ自動付与される**：Keycloakはjboss-loggingイベントリスナーをデフォルト有効にしており、`KC_TRACING_ENABLED=true`の環境下では`org.keycloak.events`ロガーが出力する各イベントログ行に`traceId=…`フィールドが自動付与される（出力例：`type="LOGIN_ERROR", realmName=…, traceId=50c1168a…`）。各サービスのToken Exchangeリクエストに`traceparent`ヘッダが伝播していれば、KeycloakのイベントログとOTelトレースをtrace_idで機械的に突合できることを確認した。
