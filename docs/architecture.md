# アーキテクチャ設計

本ドキュメントは現在有効なアーキテクチャの断面のみを記録する。個々の設計判断の根拠・選択経緯は [docs/adr/](adr/) を参照。決定が変わった場合は該当箇所を直接書き換え、対応する ADR を Superseded に更新する。個々の実装で見つかった罠・気づきは[insights.md](insights.md)、未着手の改善項目は[backlog.md](backlog.md)を参照。

## 1. 目的

OAuth 2.0 Token Exchange (RFC 8693) の仕組みを、マイクロサービス化された基幹システムを模したローカル実行可能なサンプルで示す。

想定ユースケース: 基幹システムにおける**アクセス権の照会・制御**。あるサービスがユーザーの代わりに下流サービスを呼び出す際、元のユーザーの権限とスコープを適切に絞り込みながら伝播させる。

## 2. 背景（なぜ Token Exchange が必要か）

Token Exchange 以前に蔓延していたバッドプラクティスとその課題:

| バッドプラクティス | 問題点 |
|---|---|
| ユーザートークンのそのまま転送 | 下流サービスが「誰経由の呼び出しか」を判別できない。スコープが広すぎるまま伝播する |
| サービスアカウントでの一括呼び出し | ユーザーコンテキストが消失。Confused Deputy Problem の温床 |
| 静的な共有シークレット | ローテーション困難、漏洩時の影響範囲が大きい |

RFC 8693 はこれらを解決するため、スコープ絞り込みによる最小権限の伝播を可能にした。本サンプルでは **Delegation（委任）** を採用する（下流サービスから見て「元ユーザー」の権限で処理していることが`sub`クレームで判別できる方式。詳細と制約は§9）。

## 3. 採用する認可サーバー (AS)

**Keycloak**（26.2+, Standard Token Exchange V2）を使用する。→ [ADR 0001](adr/0001-authorization-server-keycloak.md)

## 4. サービス構成（多段委任構成）

基幹システムのモチーフ: **受発注システム**。

```
[Frontend: TypeScript (Nuxt/Nitro BFF)]
   User(営業担当者)が Keycloak にログイン(Authorization Code + PKCE)
        │ access_token (sub=user, aud=order-service, scope=order)
        ▼
[Order Service: Java / Spring Boot]  ── Hop0: ユーザーの生トークンを受理
   受注登録 → 在庫確認が必要
        │ Token Exchange①
        │   subject_token = user token
        │   audience = inventory-service
        │   scope = inventory (絞込)
        │   → 新トークン: sub=user（維持）, aud=inventory-service
        ▼
[Inventory Service: Go]  ── Hop1: 委任トークン受理
   在庫確認 → ユーザーの支店アクセス権に応じた明細が必要
        │ Token Exchange②
        │   subject_token = ①で得たトークン
        │   audience = warehouse-service
        │   scope = warehouse (絞込)
        │   → 新トークン: sub=user（維持）, aud=warehouse-service
        ▼
[Warehouse Service: Rust]  ── Hop2: 委任チェーン継続
   ポリシー判定:
     - sub(user) がこの支店への照会権限を持つか（Employee Serviceへ属性照会が必要）
        │ Token Exchange③
        │   subject_token = ②で得たトークン
        │   audience = employee-service
        │   scope = employee (絞込)
        │   → 新トークン: sub=user（維持）, aud=employee-service
        ▼
[Employee Service: Python]  ── 属性局。ユーザーの所属・権限情報を提供する。委任チェーンの終端
```

「誰が誰に委任できるか」というトポロジー制御（例: warehouse-service向け交換を要求できるのはinventory-serviceのみ）は、各クライアントに付与する optional client scope のみで実現する（[ADR 0007](adr/0007-topology-control-via-optional-client-scopes.md)、§12で実機検証済み）。

各サービスの存在意義・提供機能・保有データは[services.md](services.md)、具体的な業務シナリオは[use-cases.md](use-cases.md)、認可のディシジョンテーブルは[permission-matrix.md](permission-matrix.md)を参照。

### サービスと言語の対応

| サービス | 言語 | 役割 |
|---|---|---|
| edge-proxy | nginx | ホストに公開する唯一の入口（§17） |
| Frontend | TypeScript / Nuxt (Nitro) | ユーザーログイン(OIDC Authorization Code + PKCE)、BFF（§14） |
| Order Service | Java / Spring Boot | 受注登録。委任チェーンの起点（Hop0） |
| Inventory Service | Go | 在庫確認。委任の中継点（Hop1） |
| Warehouse Service | Rust | 支店別在庫。委任の中継点（Hop2）、ポリシー判定 |
| Employee Service | Python | ユーザー属性（所属・権限）提供。委任チェーンの終端（Hop3） |

補足: RFC 8693 の Token Exchange はリダイレクトを伴わないバックチャネルの HTTP+JWT 操作であるため、言語ごとのライブラリ対応に技術的な優劣はない。

### この構成で示すポイント

- スコープの段階的絞り込み（`order` → `inventory` → `warehouse` → `employee`）
- 各ホップでの認可判定の違い（ユーザー権限 vs 委任元サービスの正当性）
- 3ホップ全てをToken Exchange（Delegation）で統一し、`sub`（元ユーザー）を最後まで維持する

## 5. Token Exchange の実装方式

**各サービスのアプリケーション本体で実装する**（Envoy等のプロキシ/サイドカーには委譲しない）。各サービスは Keycloak に対して自身のクライアント認証情報（confidential client）で `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` を直接呼び出す。→ [ADR 0002](adr/0002-token-exchange-in-application-layer.md)

## 6. 業務ロジックのリアリティ水準

「ある程度リアル」な実装とする。ダミーレスポンスではなく、実在感のあるドメインモデルと業務ルールを持たせる。

各サービスの存在意義・提供機能・保有データは`docs/services.md`、具体的な業務シナリオと委任チェーンの流れは`docs/use-cases.md`に定義する。

Inventory ServiceとWarehouse Serviceの機能差の要点：Inventory Serviceは商品カタログ横断の集計・ルーティング層（「どこかに在庫があるか」に答える。支店が違っても答えは同じなので拠点別制御は不要）、Warehouse Serviceは特定拠点の実運用在庫データ（多くの企業で拠点ごとに独立管理され、他拠点の実数値は組織的に見せないという業務ルールをここで表現する）。「ユーザーの所属支店に応じて照会できる支店が制限される」という点が、ユースケースの核である「アクセス権の照会・制御」を体現する（詳細は`docs/services.md`）。

## 7. データストア（サービスごとに使い分け、DB-per-service）

| サービス | DB | 選定理由 |
|---|---|---|
| Order Service (Java) | PostgreSQL | Spring/JPA との定番構成。注文はACIDトランザクションが必要 |
| Inventory Service (Go) | MySQL | 商品マスタ・商品-支店マッピングのリレーショナルデータ |
| Warehouse Service (Rust) | Redis | 在庫数の増減はホットパス。atomic INCR/DECRで引当処理を表現 |
| Employee Service (Python) | MongoDB | 社員属性(所属・権限配列)はスキーマ柔軟なドキュメントが自然 |

## 8. ローカル実行環境のオーケストレーション

**Docker Compose** を採用する。`docker compose up` 一発で Keycloak + 5サービス + 4種DB + edge-proxy + grafana/otel-lgtm（トレース可視化、§10）が起動できる構成とする。→ [ADR 0003](adr/0003-local-orchestration-docker-compose.md)

## 9. Keycloak Standard Token Exchange V2 の制約と対応

Keycloak 26.2+ の Standard Token Exchange V2 は以下の性質を持つ。

- **ダウンスコープのみ**：`audience`パラメータで対象クライアント／スコープを絞り込んだ新トークンを発行する。`sub`（元ユーザー）はそのまま維持される（偽装ではない）
- Fine-Grained Admin Permissions は**不要**（V1からの簡略化）
- `subject_token`の`aud`に要求元クライアントが含まれている必要がある（自分自身のトークンを交換する場合を除く）。Keycloakが交換**時点**でこれを検証するため、権限のないクライアントが他クライアント宛のトークンを流用して交換することはできない
- 委任トポロジーの制御は、**各クライアントに付与するoptional client scope**だけで実現する（詳細は§12）
- **RFC 8693 の `act` クレーム（委任チェーンの表現）は標準では生成されない**。実験的機能（`token-exchange-delegation`等）には依存せず、Standard V2 のみを使用する（→ [ADR 0004](adr/0004-keycloak-standard-v2-no-experimental-features.md)）

### リスク評価

| 情報 | 標準V2での状態 | 評価 |
|---|---|---|
| `sub`（誰の権利で処理しているか） | 維持される。Keycloak発行トークンで暗号学的に保証 | アクセス権の照会・制御はこれのみで実現可能 |
| 委任トポロジーのリアルタイム制御 | optional client scopeの割当で実現。不正なホップ飛ばしはKeycloak自身が拒否する | リスクなし |
| 委任チェーンの事後監査証跡（`act`相当） | 標準V2ではJWTに残らない。Keycloak内部の管理イベントログに残る（**要設定：`eventsEnabled=true`かつinfoレベルのログ出力。デフォルトは無効**。詳細は§10・[insights.md](insights.md)参照） | ログ突合で代替（§10） |

## 10. 委任チェーンの事後監査

**OpenTelemetry（W3C Trace Context）** に従う。→ [ADR 0005](adr/0005-delegation-audit-with-opentelemetry.md)

- `traceparent`ヘッダで trace_id を全ホップに伝播する
- 各サービスは自分のspanとして親span_idのみを記録する。経路全体の再構築は収集基盤側の責務
- 可視化用に **`grafana/otel-lgtm`**（Grafana+Tempo+Loki+Prometheus/Mimirが1コンテナに統合された公式イメージ）を docker-compose に追加する。OTLPエンドポイントが1つで完結し設定不要。今回使うのはトレース（Tempo経由）のみ
- 実装範囲・各言語の計装方式・見つかった罠は[insights.md](insights.md)を参照。edge-proxy（nginx）は意図的に計装しない（同ドキュメント参照）
- トークン発行・利用記録とアクセスログを突合する監査ツールを`audit/`に実装済み。突合キーは`trace_id`ではなく`(jti, audience)`——リクエスト単位の経路相関ではなく、識別子の集合演算に還元することで、トークンのキャッシュ再利用やtrace伝播の途切れに依存しない決定論的な判定にしている（→ [ADR 0012](adr/0012-jti-audience-correlation-for-token-exchange-audit.md)）。デモ手順と実行結果は[audit-demo.md](audit-demo.md)を参照
- OTelトレースは「経路の可視化・デバッグ」を担い、Keycloakイベントログは「認可交換の事実の記録」を担う（役割が異なるため両方を維持する。監査の正当性判定はKeycloakイベントログ側の`(jti, audience)`にのみ依拠する）

## 11. トークン漏洩・再提示リスクへの対策

→ [ADR 0006](adr/0006-dpop-for-frontend-not-mtls.md)

### 採用: DPoP (RFC 9449)

- クライアント（各サービス）が自分の秘密鍵で署名した証明(DPoP Proof JWT)を`DPoP`ヘッダで毎回送信
- アクセストークンの`cnf`クレームに公開鍵のハッシュを埋め込み、リソースサーバーは「提示者が本当に鍵を持っているか」を検証する
- 適用範囲はfrontend（ユーザーがブラウザで直接触る、最も漏洩経路の多い区間）のみ。内部のサービス間委任チェーン（Order→Inventory→Warehouse→Employee）は対象外
- 実装の詳細・伝播ルールの訂正は[insights.md](insights.md)を参照

### 採用: 交換後トークンの短寿命化

- 内部の委任チェーン（Order→Inventory→Warehouse→Employee）で交換される中継トークンはTTLを60秒に設定する（realmデフォルトの5分から短縮）
- 実装は`keycloak/realm-export.json`のorder-service/inventory-service/warehouse-serviceクライアントへの`access.token.lifespan: "60"`属性設定。Token Exchangeで発行されるトークンのTTLは**交換を要求した側（`azp`）のクライアント属性**が効く（詳細は[insights.md](insights.md)参照）
- frontendの中継トークンおよびemployee-serviceは対象外（DPoP送信者拘束済み、またはチェーン末端のため）

### 交換結果のキャッシュ

frontendとorder-serviceは、Token Exchange結果を`(subjectトークンのjti, audience)`単位でキャッシュし、`expires_in`が切れるまで同じトークンを使い回す（→ [ADR 0013](adr/0013-token-exchange-result-caching.md)）。上記の短寿命化（60秒TTL）と両立する設計であることを実データで検証済み——監査ツール（`audit/`、[ADR 0012](adr/0012-jti-audience-correlation-for-token-exchange-audit.md)）が`(jti, audience)`で突合するため、キャッシュされたトークンが複数リクエストに跨って再利用されても偽陽性を生まない。inventory-service・warehouse-serviceには未実装（同ADR参照）。

### 不採用: mTLS(RFC 8705) Certificate-Bound Access Tokens

サービスメッシュ前提でインフラコストが重く、本サンプルのスコープ外（本番導入時の選択肢として付記するに留める）。

## 12. 委任トポロジー制御（実機検証済み・Client Policies不要）

→ [ADR 0007](adr/0007-topology-control-via-optional-client-scopes.md)

**設計（許可ベース）**：各保護対象スコープを、許可されたクライアントにだけ optional client scope として付与する。

| 保護するスコープ | 対象audience | 付与するクライアント（optional client scope） |
|---|---|---|
| `inventory` | inventory-service | order-service |
| `warehouse` | warehouse-service | inventory-service |
| `employee` | employee-service | warehouse-service |

**検証結果**（Keycloak 26.4.7 実機）：

- order-service → inventory-service（`scope=inventory`）: 成功。`sub`維持・`aud=inventory-service`・`azp=order-service`
- inventory-service → warehouse-service（`scope=warehouse`）: 成功。`sub`維持・`aud=warehouse-service`・`azp=inventory-service`
- order-service → warehouse-service（未許可の飛び越し）: `invalid_request: Requested audience not available`
- order-service → warehouse-service（`scope=inventory`を渡し`audience=warehouse-service`を偽装）: 同様に拒否
- inventory-service → employee-service（未許可）: `invalid_scope: Invalid scopes: employee`

DPoP（§11）はClient Policiesの`dpop-bind-enforcer`実行アクションを引き続き使用する（トポロジー制御とは別目的）。

## 13. Keycloak realmのコード化

→ [ADR 0008](adr/0008-minimal-realm-export-json.md)

`keycloak/Dockerfile`（`quay.io/keycloak/keycloak:26.4`を継承し`keycloak/realm-export.json`を`--import-realm`で読み込む）を`compose.yml`のビルド対象とする。`docker compose up`のたびに同じ状態が再現される。

`realm-export.json`は**意図して追加・変更した項目のみ**を記述する（realm本体、client scope 4種とaudienceマッパー、client 5種とその設定、テストユーザー4件）。縮小版realm設定で追加対応が必要だった項目（`sub`クレームマッパーの明示、`KC_HOSTNAME`固定）は[insights.md](insights.md)を参照。

## 14. Frontend実装（BFF）の設計

`frontend/`はNuxt 4（Nitro）による単一コンテナのBFF (Backend for Frontend) として実装する。

- ログイン・トークン保有・DPoP鍵保有は全てサーバーサイド（Nitroの`server/api/*`）で行う。ブラウザにはJSでアクセス可能なアクセストークンを一切渡さない（`httpOnly`セッションクッキー1つのみ）
- Authorization Code + PKCEは自前実装（`server/utils/pkce.ts`）
- セッションは`server/utils/session.ts`のインメモリ`Map`（コンテナ1台構成のため共有ストアは不要。コンテナ再起動で全ユーザーがログアウトされる制約は許容）
- 画面（`app/app.vue`）は受注登録フォーム・受注一覧・社員情報照会のみで、全て同一オリジンの`/api/*`へfetchする
- `frontend/e2e/login-and-order.mjs`（`npm run e2e`）としてPlaywright E2Eテストを常設。ログイン→受注登録→一覧反映→自分の社員情報照会までを実ブラウザで検証する。`keycloak/tests/permission-matrix.sh`がKeycloak層の検証を担うのと対になる、UIからの検証

## 15. DPoPの設計

§11で採用したDPoP (RFC 9449) の適用範囲はfrontendのみ。

- **Keycloak**：`frontend`クライアントの属性に`dpop.bound.access.tokens: true`を設定。トークン発行時にDPoP Proofを必須にし、発行するアクセストークンに`cnf.jkt`（公開鍵のJWK拇印）を埋め込む
- **Frontend（BFF）**：鍵ペア生成・Proof JWT署名は`server/utils/dpop.ts`（`jose`ライブラリ、ES256）でサーバーサイドに自前実装。鍵ペアはセッションと同じインメモリストアに保持し、ログイン時に生成した1つの鍵をそのセッション中は使い回す
- **Order Service・Employee Service**（frontendから直接呼ばれる2サービス）：DPoP Proofの検証を実装。①`typ`ヘッダー確認 ②Proof自体の署名検証 ③Proofの`jwk`から計算したJWK拇印(RFC 7638)とアクセストークンの`cnf.jkt`の一致 ④`htm`/`htu`がリクエストと一致 ⑤`iat`が許容範囲内(±60秒) ⑥`ath`（アクセストークンのSHA-256ハッシュ）が一致

Token Exchangeの呼び出し元がDPoP-boundな場合の交換後トークンへの伝播ルール、および実装中に踏んだ罠は[insights.md](insights.md)を参照。

## 16. OpenTelemetry分散トレーシングの採用範囲

§10で決めた方針を、5アプリサービス＋Keycloakに実装する（edge-proxyは対象外）。

- 各サービスとも自動計装を優先し、独自スパンを最小限に留める（Java: Micrometer OTelブリッジ、Go: `otelhttp`、Rust: `axum-tracing-opentelemetry`、Python: `opentelemetry-instrument`ゼロコード計装、Node/Nuxt: `NodeSDK`、Keycloak: `KC_TRACING_ENABLED`）
- DBレベルのスパンも追加（PostgreSQL/MySQL/MongoDB/H2）。Redis（Warehouse Service）のみ定番の計装ライブラリが無く手動対応
- **edge-proxy（nginx）は意図的に計装しない**：nginxのOTelモジュールは受信側のスパンしか作れず、Tempoのservice graphが要求するCLIENT側スパンを生成できない。CDN/APIゲートウェイ相当の透過的インフラとして扱い、計装自体を撤去した
- 各言語の実装方式の詳細、ヘルスチェックをトレースから除外する方法、DBノードの命名規則、実装中に見つかった罠は[insights.md](insights.md)を参照

## 17. BFF化とedge-proxyの導入

→ [ADR 0009](adr/0009-bff-with-edge-proxy.md)

OAuth 2.0 Security BCP（Browser-Based Apps向けガイダンス）に従い、アクセストークンをブラウザに渡さないBFF構成を採用する。

- **Frontendのサーバー化**：`frontend/`をNuxt（Nitro）の単一コンテナとし、ログイン処理・トークン保有をサーバーサイド（`server/api/*`）に完全に閉じる（§14）
- **edge-proxyの新設**：`edge-proxy/`（nginx）をfrontendの前段に配置し、ホストに公開する唯一の入口とする。`/realms/*`・`/resources/*`はKeycloakへ、それ以外はfrontendへ振り分ける
- **Keycloakのホスト直接公開を廃止**：`KC_HOSTNAME`をedge-proxyの公開アドレス（`http://localhost:3000`）に固定。ブラウザ・バックエンドサービスのいずれも同一の`iss`値に到達する
- **frontendクライアントを機密クライアント化**：`publicClient: false`＋`secret`、`standard.token.exchange.enabled: true`。`directAccessGrantsEnabled`はテストハーネス（`permission-matrix.sh`）のためにあえて`true`のまま残す
- **各サービスのホストポート公開を削除**：edge-proxyの3000のみ公開
- **CORS設定の削除**：Order Service・Employee ServiceはBFF経由でのみ呼ばれるため

## 18. 既知の制約として受容した事項

### 内部サービス間チェーンへのDPoP非適用

Order→Inventory→Warehouse→Employee の委任チェーンでやり取りされるトークンには送信者拘束（DPoP）を適用しない。内部チェーンのトークンは全て Docker private network 内にのみ存在し、ブラウザや外部ネットワークには出ない。残るリスク（TTL内の `aud` 一致サービスへの直接再提示）は短TTLで緩和する。内部サービス間の送信者拘束が本番要件になる場合は mTLS（RFC 8705）が適切な対策。→ [ADR 0006](adr/0006-dpop-for-frontend-not-mtls.md)

### issuerの「localhost」感・ポート番号残存

edge-proxy化後もissuer（`http://localhost:3000/realms/kikan-system`）には`localhost`という文字列とポート番号が残っている。解消するにはホストマシンの`/etc/hosts`に偽のホスト名を追加し edge-proxy をポート80で公開する必要があり、「ローカルで docker compose 一発で動く」という本リポジトリの前提を損なうため、現状を維持する。

## 19. アプリ層の認可DENYログ（異常検知・デバッグ用）

→ [ADR 0010](adr/0010-authz-deny-log-for-debugging.md)

アプリ層の認可拒否は「監査」ではなく「**異常検知・デバッグの手がかり**」として位置づけ、DENYのみを専用の`authz_deny`ログ行として記録する。

- **フィールド**：`type`（固定値`"authz_deny"`）・`sub`・`jti`・`trace_id`・`reason`
- **記録箇所**：
  - Warehouse Service（[handlers.rs](../warehouse-service/src/handlers.rs)の`authorize_branch`）：`role_missing`・`branch_mismatch`・`employee_branch_unknown`を`branch`・`employee_branch`フィールドとともに記録
  - Inventory Service（[auth.go](../inventory-service/auth.go)の`authMiddleware`）：`role_missing`を`required_roles`フィールドとともに記録
- `audit/audit.py`の既存チェック（CHECK1〜3）は`type = "access_log"`でフィルタしており、`authz_deny`行は無関係のため影響しない

## 20. 層の責務逆転（UC8/UC9/UC10）の是正

→ [ADR 0011](adr/0011-warehouse-stock-visibility-endpoint.md)

### 原則

[services.md](services.md)が定義する存在意義に従い、支店アクセスに関する認可判断の権威は**Warehouse Service一箇所にのみ**存在する。Order Service・Inventory Serviceはこの判断について発言権を持たない。

### 採用：質問の形を「支店Xは？」から「私は何が見える？」に変える

- 旧：`GET /warehouse/:branch/stock/:product_id`（支店を呼び出し元が指定）→ 権限がなければ403
- 新：`GET /warehouse/stock/:product_id`（支店をパスに含めない）→ 常に200。**自分が見える支店の在庫のみを返す**

具体的な実装：

- Warehouse Service（[handlers.rs](../warehouse-service/src/handlers.rs)の`get_stock_by_branches`）：RBAC（ロールが全く無ければ403、UC9）はそのまま残す。`warehouse-viewer-all`はこの商品の実在庫を持つ全支店を返す（UC8）。`warehouse-viewer`は自分の支店1件のみを返し、該当データが無ければ空集合（UC10。エラーではなく正直な「該当なし」）
- Inventory Service（[main.go](../inventory-service/main.go)）：`/warehouse-stock/{productId}`（支店なし）。`requiredRoles`は`nil`（認証のみ）で、レスポンスは解釈せずそのまま中継
- Order Service（[WarehouseStockController.java](../order-service/src/main/java/com/example/orderservice/WarehouseStockController.java)）：`@PreAuthorize`なし、`/warehouse-stock/{productId}`を中継
- UC9の403（ロールが全く無い）だけはOrder Serviceまで透過的に伝播する

### なぜOrder Serviceを経由すること自体は問題ないか

frontendのKeycloakクライアントには`order`・`employee`のoptionalClientScopeしか割り当てられておらず（`keycloak/realm-export.json`）、`inventory`・`warehouse`スコープのトークンを得る手段がそもそも存在しない（permission-matrix.md 表1）。Order Service・Inventory Serviceがこの機能について中継に徹するのは、委任トポロジー上の制約に対して誠実な実装であり、両サービスがこの業務について権限判断の権威を持たないことと矛盾しない。

### 支店マスタへの暗黙依存という残存課題

Warehouse Serviceの在庫キー（`stock:{branch}:{product_id}`）とEmployee Serviceの社員の所属支店フィールドは同じ文字列（`tokyo`/`osaka`）を各サービスが独立に採用しているだけで、どちらかが正典（マスタ）というわけではない。`get_stock_by_branches`はWarehouse Serviceが自分の保有データ（Redisキー）だけをスキャンすることでこの問題を回避している。将来「支店マスタそのものを参照する要件」が生じた場合、マイクロサービスにおける参照データ共有問題が顕在化する。現時点では対応しない。
