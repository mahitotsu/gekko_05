# サービス仕様

各サービスの存在意義・提供機能・保有データを定義する。認可の詳細は`permission-matrix.md`、委任トポロジーの実装は`architecture.md`を参照。

## edge-proxy (nginx)

実装済み（`edge-proxy/`。architecture.md §14）。ドメインロジックを持たない純粋なインフラ層のため、認可上の主体ではない。

- **存在意義**：ホストに公開する唯一の入口。CDN/APIゲートウェイ相当の位置に置き、ブラウザから見えるオリジンを単一化する
- **提供機能**：パスベースの振り分けのみ（`/realms/*`・`/resources/*`→Keycloak、それ以外→Frontend）
- **保有データ**：なし
- **連携相手**：Keycloak、Frontend（いずれも内部ネットワーク経由）

## Frontend (Nuxt / TypeScript, BFF)

実装済み（`frontend/`。architecture.md §11, §14）。

- **存在意義**：ユーザー（社員）がシステムに触れる唯一の入口。BFF (Backend for Frontend) として、OIDCログイン・トークン保有・DPoP鍵保有を全てサーバーサイドで行い、ブラウザにはアクセストークンを一切渡さない
- **提供機能**：ログイン（Authorization Code + PKCE、サーバー側で自前実装）、受注登録・照会画面、社員情報照会画面（自分の情報／HR向け全件）。画面から`/api/*`（同一オリジン）を経由してのみ下流サービスへ到達する
- **保有データ**：ログインセッション（インメモリ、コンテナ内のみ。ユーザーのアクセストークン・DPoP鍵ペアを保持）
- **連携相手**：Keycloak（認証、edge-proxy経由でブラウザから到達・内部ネットワーク経由でサーバーから到達）、Order Service（受注関連の全操作）、Employee Service（社員情報照会のみ、直接）。ホストへの直接公開はなく、edge-proxyの背後に置かれる

## Order Service (Java / Spring Boot)

実装済み（`order-service/`）。

- **存在意義**：受発注業務のドメイン境界。ユーザーが直接操作できる唯一のバックエンドであり、下流サービスへの委任チェーンの起点
- **提供機能**：受注登録（write）、受注照会（read）。ロール（`order-writer`/`order-reader`）で操作を区別する（permission-matrix.md 表2）
- **保有データ**：Order（顧客ID、明細、ステータス）— PostgreSQL
- **連携相手**：frontendから呼ばれる。在庫確認のためInventory Serviceへ委任する

## Inventory Service (Go)

実装済み（`inventory-service/`）。

- **存在意義**：商品カタログ横断の**集計・ルーティング層**。「この商品はどこかに在庫があるか」という全社視点の問いに答える。支店が違っても答えは同じであり、拠点別のアクセス制御はここでは行わない
- **提供機能**：
  - 商品の総在庫確認（read）：Warehouse Serviceから非同期に同期した集計値を返すのみで、都度Warehouse Serviceを呼び出さない。そのため`warehouse-viewer`ロールがなくても照会できる
  - 在庫の引当・減算（write）：実処理はWarehouse Serviceに委譲するため、この操作のときだけWarehouse Serviceへ委任する
  - ロール（`inventory-writer`/`inventory-reader`）で操作を区別する（permission-matrix.md 表3）
- **保有データ**：Product、商品-支店マッピング（どの支店がこの商品を扱っているか）、Warehouse Serviceから同期した集計在庫数 — MySQL
- **連携相手**：Order Serviceから委任で呼ばれる。引当・減算が必要なときのみWarehouse Serviceへさらに委任する

## Warehouse Service (Rust)

実装済み（`warehouse-service/`）。

- **存在意義**：特定拠点の**実運用在庫データ**を持つ、組織的に独立した拠点システム。多くの企業で支店ごとに実在庫は独立して管理され、他拠点の実数値は組織的に見せないという業務ルールをここで表現する
- **提供機能**：支店別在庫確認（実数量・引当数）、引当処理。`warehouse-viewer`ロール保持 かつ 照会対象支店が本人の所属支店と一致する場合のみ許可（RBAC+ABAC）。`warehouse-viewer-all`ロール保持者（物流管理担当等）は所属支店と無関係に全支店を照会できる（permission-matrix.md 表5）
- **保有データ**：支店別在庫（数量、引当数）— Redis
- **連携相手**：Inventory Serviceから委任で呼ばれる。所属支店の確認のためEmployee Serviceへさらに委任する

## Employee Service (Python)

実装済み（`employee-service/`）。

- **存在意義**：社員の属性情報を一元管理する**属性局**。他サービスが認可判断のために参照する外部データソース。支店所属のような変化しうる業務データはKeycloakのロールにせず、ここで一元管理する
- **提供機能**：社員情報照会。トークンの`sub`と一致する自分の情報は誰でも照会可、`hr-viewer`ロール保持者は他人の情報も照会可（permission-matrix.md 表4）
- **保有データ**：社員（所属部署、所属支店、ロール等）— MongoDB
- **連携相手**：Warehouse Serviceから委任で呼ばれる（所属支店確認）。frontendからも直接呼ばれる（自分の情報照会、HRによる照会）
