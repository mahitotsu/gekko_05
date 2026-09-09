# gekko_05

OAuth 2.0 Token Exchange (RFC 8693) の仕組みを、マイクロサービス化された基幹システムを模したローカル実行可能なサンプルで示すプロジェクト。

想定ユースケースは基幹システムにおける**アクセス権の照会・制御**：あるサービスがユーザーの代わりに下流サービスを呼び出す際、元のユーザーの権限とスコープを適切に絞り込みながら伝播させる（Delegation）。受発注システムをモチーフに、Frontend → Order Service → Inventory Service → Warehouse Service → Employee Service という4サービス・3ホップの委任チェーンを、Keycloak（Standard Token Exchange V2）を認可サーバーとして実際に構築している。

各ホップの実装言語は意図的に揃えず、Java・Go・Rust・Python・TypeScriptを使い分けている（Token Exchangeはバックチャネルの HTTP+JWT 操作であり、言語間の技術的な優劣がないことを示すため）。

## クイックスタート

```
docker compose up --build
```

起動後、`http://localhost:3000` にブラウザでアクセス（唯一の公開ポート。テストユーザーは`keycloak/realm-export.json`参照、パスワードは全員`password`）。OTelトレースは`http://localhost:3000/grafana/`から参照できる。

## ドキュメント

- [docs/architecture.md](docs/architecture.md) — 全体アーキテクチャ・設計判断とその根拠
- [docs/services.md](docs/services.md) — 各サービスの存在意義・提供機能・保有データ
- [docs/permission-matrix.md](docs/permission-matrix.md) — 認可のディシジョンテーブル
- [docs/use-cases.md](docs/use-cases.md) — 具体的な業務シナリオと委任チェーンの流れ
- [docs/insights.md](docs/insights.md) — 実装中に見つかった罠・気づき
- [docs/backlog.md](docs/backlog.md) — 未着手の改善項目

## テスト

- `keycloak/tests/permission-matrix.sh` — Keycloak層（Token Exchangeの許可/拒否）の検証
- `frontend/e2e/login-and-order.mjs`（`npm run e2e`） — 実ブラウザでのログイン〜受注登録のE2E検証
