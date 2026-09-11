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
