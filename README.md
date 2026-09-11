# gekko_05

OAuth 2.0 Token Exchange (RFC 8693) のサンプル実装。**ローカル環境で完結する参照実装であり、本番投入を想定した設定ではない**（テストユーザーのパスワードが全員固定など、後述）。目的・背景・要求水準は[docs/requirements.md](docs/requirements.md)を参照。

## クイックスタート

```
docker compose up --build
```

起動後、`http://localhost:3000` にブラウザでアクセス（唯一の公開ポート。テストユーザーは`keycloak/realm-export.json`参照、パスワードは全員`password`）。OTelトレースは`http://localhost:3000/grafana/`から参照できる。

## フォルダ構成

| パス | 内容 |
|---|---|
| `docs/` | 設計・要件・運用ドキュメント一式（下記「ドキュメントの読み方」参照） |
| `keycloak/` | 認可サーバー設定（`realm-export.json`）・検証スクリプト（`tests/permission-matrix.sh`） |
| `edge-proxy/` | nginx。ホストに公開する唯一の入口 |
| `frontend/` | BFF (Nuxt/Nitro)。ユーザーの唯一の入口。E2Eテスト（`e2e/uc*.mjs`、`npm run e2e`で一括実行）を含む |
| `order-service/` | 受注登録（Java / Spring Boot） |
| `inventory-service/` | 在庫確認（Go） |
| `warehouse-service/` | 支店別在庫（Rust） |
| `employee-service/` | 社員属性（Python） |
| `audit/` | トークン発行・利用記録とアクセスログの突合監査ツール |
| `alloy/` | ログ収集エージェント設定（Grafana Alloy） |

## ドキュメントの読み方

- [docs/requirements.md](docs/requirements.md) — 目的・背景・要求水準（何を・なぜ実現するか）
- [docs/architecture.md](docs/architecture.md) — 現在有効なアーキテクチャの断面（どう構築したか）
- [docs/adr/](docs/adr/) — 個々の設計判断の根拠・選択経緯
- [docs/services.md](docs/services.md) — 各サービスの存在意義・提供機能・保有データ
- [docs/permission-matrix.md](docs/permission-matrix.md) — 認可のディシジョンテーブル
- [docs/use-cases.md](docs/use-cases.md) — 具体的な業務シナリオと委任チェーンの流れ
- [docs/audit-demo.md](docs/audit-demo.md) — トークン発行・利用記録とアクセスログの突合デモ
- [docs/insights.md](docs/insights.md) — 実装中に見つかった罠・気づき
- [docs/backlog.md](docs/backlog.md) — 未着手の改善項目

## テスト

- `keycloak/tests/permission-matrix.sh` — Keycloak層（Token Exchangeの許可/拒否）の検証
- `frontend/e2e/uc*.mjs`（`npm run e2e`で一括実行） — 各ユースケース（[docs/use-cases.md](docs/use-cases.md)）に対応する実ブラウザでのE2E検証

## 監査デモ

```
make audit-scenario  # トラフィック生成
make audit-report    # トークン発行・利用記録とアクセスログの突合レポート
```

詳細は[docs/audit-demo.md](docs/audit-demo.md)を参照。

## License

[MIT](LICENSE)
