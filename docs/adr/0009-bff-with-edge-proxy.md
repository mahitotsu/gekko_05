# ADR 0009: BFF構成とedge-proxyの導入

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

OAuth 2.0 Security BCP（Browser-Based Apps向けガイダンス）への準拠として、アクセストークンをブラウザに渡さないアーキテクチャが必要だった。frontend をどこでトークンを保持するサーバーとして実装するか、また Keycloak へのルーティングをどう統一するかを決める必要があった。

## Decision

- **Frontend を Nuxt（Nitro）の BFF** として実装し、ログイン処理・トークン保有・DPoP 鍵保有をすべてサーバーサイドに閉じる。
- **edge-proxy（nginx）** を frontend の前段に配置し、ホストに公開する唯一の入口とする。`/realms/*`・`/resources/*` は Keycloak へ、それ以外は frontend へ振り分ける。
- `KC_HOSTNAME` を edge-proxy の公開アドレス（`http://localhost:3000`）に固定し、Keycloak コンテナ自体のホストポート公開を削除する。

## Consequences

- frontend クライアントを機密クライアント化（`publicClient: false`、`standard.token.exchange.enabled: true`）。
- ブラウザから見えるオリジンが単一化される。ブラウザ・バックエンドサービスのいずれも同一の `iss` 値（`http://localhost:3000/realms/kikan-system`）に到達する。
- 各マイクロサービス・DB のホストポート公開が不要になり削除。
- Order Service・Employee Service は BFF 経由でのみ呼ばれるため CORS 設定を削除。
- `directAccessGrantsEnabled` はテストハーネス（`permission-matrix.sh` のパスワードグラント）のためにあえて `true` のまま残す。BFF 自体は Authorization Code + PKCE のみ使用する。
- **`KC_HOSTNAME`の固定が必須**：内部（docker network経由、例: `http://keycloak:8080`）と外部（edge-proxy経由、`http://localhost:3000`）でKeycloakへの到達ホスト名が異なると、Keycloakは自分自身のissuerをリクエストごとに動的算出するため、外部で発行されたトークンをサービスが内部経路でToken Exchangeしようとすると`invalid_request: Invalid token`で拒否される。`KC_HOSTNAME`を固定することで解決した（実機で確認）。
