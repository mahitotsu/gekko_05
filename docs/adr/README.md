# アーキテクチャ決定記録（ADR）

本ディレクトリは、設計判断1件ごとの根拠・選択経緯を記録する。[architecture.md](../architecture.md) は現在有効な設計断面のみを記載し、個々の判断の根拠はここに委譲する。

決定が覆った場合は、旧 ADR の Status を `Superseded by NNNN` に更新し、新しい ADR を追加する。

## 一覧

| # | タイトル | Status |
|---|---|---|
| [0001](0001-authorization-server-keycloak.md) | 認可サーバーにKeycloakを採用 | Accepted |
| [0002](0002-token-exchange-in-application-layer.md) | Token Exchange実装をアプリ本体に配置（プロキシ委譲しない） | Accepted |
| [0003](0003-local-orchestration-docker-compose.md) | ローカル実行環境にDocker Composeを採用 | Accepted |
| [0004](0004-keycloak-standard-v2-no-experimental-features.md) | Keycloak Standard Token Exchange V2のみ使用（実験的機能を使わない） | Accepted |
| [0005](0005-delegation-audit-with-opentelemetry.md) | 委任チェーン監査にOpenTelemetry（W3C Trace Context）を採用 | Accepted |
| [0006](0006-dpop-for-frontend-not-mtls.md) | トークン送信者拘束にDPoPを採用（mTLSは不採用、内部チェーンは短TTLで代替） | Accepted |
| [0007](0007-topology-control-via-optional-client-scopes.md) | 委任トポロジー制御をoptional client scopeのみで実現（Client Policies不要） | Accepted |
| [0008](0008-minimal-realm-export-json.md) | realm-export.jsonを意図的変更項目のみの縮小版で記述 | Accepted |
| [0009](0009-bff-with-edge-proxy.md) | BFF構成とedge-proxyの導入 | Accepted |
| [0010](0010-authz-deny-log-for-debugging.md) | アプリ層認可拒否ログをauthz_denyとして記録（異常検知・デバッグ用） | Accepted |
| [0011](0011-warehouse-stock-visibility-endpoint.md) | 在庫照会を「支店指定」から「見える範囲を返す」設計に変更（UC8/UC9/UC10） | Accepted |
| [0012](0012-jti-audience-correlation-for-token-exchange-audit.md) | Token Exchange監査の突合キーをtrace_idから(jti, audience)へ変更 | Accepted |
| [0013](0013-token-exchange-result-caching.md) | Token Exchange結果をsubject jti単位でキャッシュする（frontend/order-service） | Accepted |
