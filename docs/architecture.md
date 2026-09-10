# アーキテクチャ設計

本ドキュメントは決定事項（結論と根拠）を記録する生きた文書。検討過程や却下案の経緯は記載しない。決定が変わった場合は該当箇所を直接書き換える。個々の実装で見つかった罠・気づきは[insights.md](insights.md)、未着手の改善項目は[backlog.md](backlog.md)を参照。

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

**Keycloak**（26.2+, Standard Token Exchange V2）を使用する。

- RFC 8693 Token Exchange をネイティブサポートしている数少ない OSS IdP
- Ory Hydra は token-exchange grant type 未実装のため不採用

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

「誰が誰に委任できるか」というトポロジー制御（例: warehouse-service向け交換を要求できるのはinventory-serviceのみ）は、各クライアントに付与する optional client scope のみで実現する。Client Policiesは使わない（§12で実機検証済み）。

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

**各サービスのアプリケーション本体で実装する**（Envoy等のプロキシ/サイドカーには委譲しない）。

- 本リポジトリの目的は RFC 8693 の意味論を学べるサンプルを作ることであり、プロキシに隠すとロジックがコードから見えなくなる
- Envoy の `envoy.filters.http.oauth2` は Authorization Code フロー向けで RFC 8693 Token Exchange グラントには非対応。プロキシ側でやるにはカスタム ext_authz サービスの自作が必要になり、複雑さが移動するだけで可視性は下がる
- 各サービスは Keycloak に対して自身のクライアント認証情報（confidential client）で `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` を直接呼び出す

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

SQLiteは不採用（サービスごとに最適なDBを選ぶポリグロット永続化のリアリティを優先）。

## 8. ローカル実行環境のオーケストレーション

**Docker Compose** を採用する。

- Envoy等のプロキシを使わない方針（§5）と合わせ、オーケストレーション自体の複雑さも最小化する
- 目的はToken Exchangeの意味論を示すことであり、K8sのデプロイパターン学習は本リポジトリのスコープ外
- `docker compose up` 一発で Keycloak + 5サービス + 4種DB + edge-proxy + grafana/otel-lgtm(トレース可視化, §10) が起動できる構成とする

## 9. Keycloak Standard Token Exchange V2 の制約と対応

Keycloak 26.2+ の Standard Token Exchange V2 は以下の性質を持つ。

- **ダウンスコープのみ**：`audience`パラメータで対象クライアント／スコープを絞り込んだ新トークンを発行する。`sub`（元ユーザー）はそのまま維持される（偽装ではない）
- Fine-Grained Admin Permissions は**不要**（V1からの簡略化）
- `subject_token`の`aud`に要求元クライアントが含まれている必要がある（自分自身のトークンを交換する場合を除く）。Keycloakが交換**時点**でこれを検証するため、権限のないクライアントが他クライアント宛のトークンを流用して交換することはできない
- 委任トポロジーの制御は、**各クライアントに付与するoptional client scope**だけで実現する（詳細は§12）。追加のClient Policiesは不要
- **RFC 8693 の `act` クレーム（委任チェーンの表現）は標準では生成されない**。`token-exchange-delegation`等の実験的機能で`may_act`相当は使えるが、これは「管理者がユーザーとして振る舞う(admin-as-user)」ユースケース向けの設計であり、本サンプルの「サービス間多段委任」とは目的が異なるため使用しない

### リスク評価

| 情報 | 標準V2での状態 | 評価 |
|---|---|---|
| `sub`（誰の権利で処理しているか） | 維持される。Keycloak発行トークンで暗号学的に保証 | アクセス権の照会・制御はこれのみで実現可能 |
| 委任トポロジーのリアルタイム制御 | optional client scopeの割当で実現。不正なホップ飛ばしはKeycloak自身が拒否する | リスクなし |
| 委任チェーンの事後監査証跡（`act`相当） | 標準V2ではJWTに残らない。Keycloak内部の管理イベントログに残る（**要設定：`eventsEnabled=true`かつinfoレベルのログ出力。デフォルトは無効**。詳細は§10・[insights.md](insights.md)参照） | ログ突合で代替（§10） |

**結論**：実験的機能には依存せず、Standard Token Exchange V2 のみを使用する。

## 10. 委任チェーンの事後監査

独自のヘッダやログ形式は発明しない。**OpenTelemetry（W3C Trace Context）** に従う。

- `traceparent`ヘッダで trace_id を全ホップに伝播する
- 各サービスは自分のspanとして親span_idのみを記録する。経路全体の再構築は収集基盤側の責務であり、各サービスが経路全体を保持・転送する必要はない
- 各言語のOTel SDKはHTTPクライアント/サーバーの自動計装を持つため、独自ログ項目を設計するより実装コストが低い
- 可視化用に **`grafana/otel-lgtm`**（Grafana+Tempo+Loki+Prometheus/Mimirが1コンテナに統合された公式イメージ）を docker-compose に追加する。OTLPエンドポイントが1つで完結し設定不要。今回使うのはトレース（Tempo経由）のみで、メトリクス計装やダッシュボード構築は行わない（ログ・メトリクスの活用は[backlog.md](backlog.md)）
- 実装範囲・各言語の計装方式・見つかった罠は[insights.md](insights.md)を参照。edge-proxy（nginx）は意図的に計装しない（同ドキュメント参照）

**根拠**：
- 自己申告ヘッダ（例: `X-Delegation-Chain`）は署名も検証もされず認可判断の根拠にできない
- 認可トポロジーのリアルタイム制御は既にoptional client scopeの割当が担っている（クライアント認証と紐づいてKeycloakが強制する）
- 「誰が誰の代わりに交換を要求したか」という認可判断の事実はKeycloakの管理イベントログに記録される。ただしデフォルト（`eventsEnabled=false`）では一切記録されないため、`eventsEnabled=true`の明示設定が必要（[insights.md](insights.md)「監査ログ・トークン監査」節参照）。OTelトレースは「経路の可視化」を担い、Keycloakイベントログは「認可交換の事実の記録」を担う。役割が異なるため両方を残す
- 独自ログ形式は既存標準（OTel）の再発明であり、可視化ツール（Jaeger等）との連携も失われる

## 11. トークン漏洩・再提示リスクへの対策

ベアラートークン一般の漏洩・再提示リスク（漏洩したトークンは提示者を選ばず受理される）への対策として以下を採用する。

### 採用: DPoP (RFC 9449)

- クライアント（各サービス）が自分の秘密鍵で署名した証明(DPoP Proof JWT)を`DPoP`ヘッダで毎回送信
- アクセストークンの`cnf`クレームに公開鍵のハッシュを埋め込み、リソースサーバーは「提示者が本当に鍵を持っているか」を検証する
- トークンだけが漏洩しても秘密鍵がなければ再利用できないため、送信者拘束(sender-constrained)を実現できる
- Keycloakは標準サポートあり（クライアントごとに有効化）。mTLS(RFC 8705)より導入コストが低く、docker-compose環境に適する
- 適用範囲はfrontend（ユーザーがブラウザで直接触る、最も漏洩経路の多い区間）のみに絞り、内部のサービス間委任チェーン（Order→Inventory→Warehouse→Employee）は対象外とした。実装の詳細・伝播ルールの訂正は[insights.md](insights.md)を参照

### 採用: 交換後トークンの短寿命化

- サービス間の中継トークンはTTLを短く設定する（即座に消費される用途のため）

### 不採用: mTLS(RFC 8705) Certificate-Bound Access Tokens

サービスメッシュ前提でインフラコストが重く、本サンプルのスコープ外（本番導入時の選択肢として付記するに留める）。

## 12. 委任トポロジー制御（実機検証済み・Client Policies不要）

Keycloak 26.4.7を実際に起動し、realm・client・client scope・audienceマッパーを構築した上で、実際のToken Exchangeリクエストで検証した。

**設計（許可ベース）**：各保護対象スコープを、許可されたクライアントにだけ optional client scope として付与する。

| 保護するスコープ | 対象audience（そのスコープのaudienceマッパーが指す先） | 付与するクライアント（optional client scope） |
|---|---|---|
| `inventory` | inventory-service | order-service |
| `warehouse` | warehouse-service | inventory-service |
| `employee` | employee-service | warehouse-service |

**検証結果**：この設定のみで委任トポロジーが強制されることを確認した。

- order-service → inventory-service（`scope=inventory`）: 成功。`sub`維持・`aud=inventory-service`・`azp=order-service`
- inventory-service → warehouse-service（`scope=warehouse`）: 成功。`sub`維持・`aud=warehouse-service`・`azp=inventory-service`
- order-service → warehouse-service（未許可の飛び越し、`scope`省略）: `invalid_request: Requested audience not available`
- order-service → warehouse-service（`scope=inventory`を渡し`audience=warehouse-service`を偽装）: 同様に拒否。scopeとaudienceの不一致は個別に検証されており、抜け道はない
- inventory-service → employee-service（未許可）: `invalid_scope: Invalid scopes: employee`

**結論**：追加のClient Policies（`reject-request`実行アクションやクライアントロールのマーカー）は不要。スコープ絞り込みという要件を満たすためのoptional client scope割り当てが、副産物として委任トポロジー制御も担う。

DPoP（§11）はClient Policiesの`dpop-bind-enforcer`実行アクションを引き続き使用する（こちらはトポロジー制御とは別目的）。

## 13. Keycloak realmのコード化

`keycloak/Dockerfile`（`quay.io/keycloak/keycloak:26.4`を継承し`keycloak/realm-export.json`を`--import-realm`で読み込む）を`compose.yml`のビルド対象とする。`docker compose up`のたびに同じ状態が再現される。

realm-export.jsonは**Keycloakの完全な設定ダンプではなく、意図して追加・変更した項目だけ**を書く（realm本体、client scope 4種とaudienceマッパー、client 5種とその設定、テストユーザー4件）。理由：

- Keycloakは指定しなかったフィールドを自身のデフォルト値で補う（realm作成を`{"realm":"...","enabled":true}`だけのリクエストで行っても正しく動くことを確認済み）
- 完全dumpにはOTPポリシーやセッションタイムアウト等、一度も検討していない大量のデフォルト値が含まれ、どこが自分たちの決定かをレビューで判別できなくなる
- 実際にこの縮小版（フルエクスポート比で約1/6のサイズ）で`docker compose up --build`からHop1/Hop2成功・未許可経路の拒否まで再現できることを確認済み

縮小版realmを使う上で追加対応が必要だった項目（`sub`クレームマッパーの明示、`KC_HOSTNAME`固定）は[insights.md](insights.md)を参照。

## 14. Frontend実装（BFF）の設計

`frontend/`はNuxt 4（Nitro）による単一コンテナのBFF (Backend for Frontend) として実装する。

- ログイン・トークン保有・DPoP鍵保有は全てサーバーサイド（Nitroの`server/api/*`）で行う。ブラウザにはJSでアクセス可能なアクセストークンを一切渡さない（`httpOnly`セッションクッキー1つのみ）
- Authorization Code + PKCEは自前実装（`server/utils/pkce.ts`）
- セッションは`server/utils/session.ts`のインメモリ`Map`（コンテナ1台構成のため共有ストアは不要。コンテナ再起動で全ユーザーがログアウトされる制約は許容）
- 画面（`app/app.vue`）は受注登録フォーム・受注一覧・社員情報照会のみで、全て同一オリジンの`/api/*`へfetchする
- `frontend/e2e/login-and-order.mjs`（`npm run e2e`）としてPlaywright E2Eテストを常設。ログイン→受注登録→一覧反映→自分の社員情報照会までを実ブラウザで検証する。`keycloak/tests/permission-matrix.sh`がKeycloak層の検証を担うのと対になる、UIからの検証

## 15. DPoPの設計

§11で採用したDPoP (RFC 9449) の適用範囲はfrontendのみ。

- **Keycloak**：`frontend`クライアントの属性に`dpop.bound.access.tokens: true`を設定。これだけでKeycloakは(a)トークン発行時にDPoP Proofを必須にし、(b)発行するアクセストークンに`cnf.jkt`（公開鍵のJWK拇印）を埋め込むようになる
- **Frontend（BFF）**：鍵ペア生成・Proof JWT署名は`server/utils/dpop.ts`（`jose`ライブラリ、ES256）でサーバーサイドに自前実装。鍵ペアはセッションと同じインメモリストアに保持し、ログイン時に生成した1つの鍵をそのセッション中は使い回す
- **Order Service・Employee Service**（frontendから直接呼ばれる2サービス）：DPoP Proofの検証を実装。①`typ`ヘッダー確認 ②Proof自体の署名検証 ③Proofの`jwk`から計算したJWK拇印(RFC 7638)とアクセストークンの`cnf.jkt`の一致 ④`htm`/`htu`がリクエストと一致 ⑤`iat`が許容範囲内(±60秒) ⑥`ath`（アクセストークンのSHA-256ハッシュ）が一致

Token Exchangeの呼び出し元がDPoP-boundな場合の交換後トークンへの伝播ルール、および実装中に踏んだ罠は[insights.md](insights.md)を参照。

## 16. OpenTelemetry分散トレーシングの採用範囲

§10で決めた方針を、5アプリサービス＋Keycloakに実装する（edge-proxyは対象外、後述）。

- 各サービスとも自動計装を優先し、独自スパンを最小限に留める（Java: Micrometer OTelブリッジ、Go: `otelhttp`、Rust: `axum-tracing-opentelemetry`、Python: `opentelemetry-instrument`ゼロコード計装、Node/Nuxt: `NodeSDK`、Keycloak: `KC_TRACING_ENABLED`）
- DBレベルのスパンも追加（PostgreSQL/MySQL/MongoDB/H2）。Redis（Warehouse Service）のみ定番の計装ライブラリが無く手動対応
- **edge-proxy（nginx）は意図的に計装しない**：nginxのOTelモジュールは受信側のスパンしか作れず、Tempoのservice graphが要求するCLIENT側スパンを生成できない。[services.md](services.md)がedge-proxyを「ドメインロジックを持たない純粋なインフラ層」と位置づけていることを踏まえ、CDN/APIゲートウェイ相当の透過的インフラとして扱い、計装自体を撤去した
- 各言語の実装方式の詳細、ヘルスチェックをトレースから除外する方法、DBノードの命名規則、実装中に見つかった罠は[insights.md](insights.md)を参照

## 17. BFF化とedge-proxyの導入

OAuth 2.0 Security BCP（Browser-Based Apps向けガイダンス）に従い、アクセストークンをブラウザに渡さないBFF構成を採用する。

- **Frontendのサーバー化**：`frontend/`をNuxt（Nitro）の単一コンテナとし、ログイン処理・トークン保有をサーバーサイド（`server/api/*`）に完全に閉じる（§14）
- **edge-proxyの新設**：`edge-proxy/`（nginx）をfrontendの前段に配置し、ホストに公開する唯一の入口とする。`/realms/*`・`/resources/*`はKeycloakへ、それ以外はfrontendへ振り分ける。ブラウザから見えるオリジンを単一化し、CDN/APIゲートウェイ的な構成を模す。実運用でこの位置に来るのはアプリケーションプロセスとは別のコンポーネント（CDN/ゲートウェイ）であるため、frontendがリバースプロキシを兼ねる構成は採らない
- **Keycloakのホスト直接公開を廃止**：`KC_HOSTNAME`をedge-proxyの公開アドレス（`http://localhost:3000`）に固定し、Keycloakコンテナ自体のホストポート公開を削除。ブラウザ・バックエンドサービスのどちらも最終的に単一の`iss`値に到達する
- **frontendクライアントを機密クライアント化**：`publicClient: false`＋`secret`、`standard.token.exchange.enabled: true`（BFFが自分自身のクライアントとしてToken Exchangeを行うため）。`directAccessGrantsEnabled`はテストハーネス（`permission-matrix.sh`のパスワードグラントによるユーザートークン取得）のためにあえて`true`のまま残す。BFF自体はAuthorization Code + PKCEのみ使用する
- **各サービスのホストポート公開を削除**：各マイクロサービス・DBのホスト経由直接アクセスが不要になったため、`ports:`定義を全て削除（edge-proxyの3000のみ公開）
- **CORS設定の削除**：Order Service・Employee Serviceはブラウザから直接呼ばれないため、両サービスのCORS設定を削除

## 18. 既知の制約として受容した事項

### 内部サービス間チェーンへのDPoP非適用

Order→Inventory→Warehouse→Employee の委任チェーンでやり取りされるトークンには送信者拘束（DPoP）を適用しない。根拠は以下の通り。

- DPoP が防ぐのは「トークンだけが盗まれた場合の再利用」である。内部チェーンのトークンはすべて Docker private network 内にのみ存在し、ブラウザや外部ネットワークには出ない。frontendクライアントのトークンと脅威モデルが異なる
- 仮に内部トークンが盗まれても、`aud` クレームによって提示できるサービスが一つに限定される。他サービスへ横展開するには Token Exchange が必要で、それにはそのサービスのクライアント認証情報も要る。クライアント認証情報まで盗まれた時点でサービス自体が侵害されており、トークン再利用より大きな問題になっている
- 残るリスク（TTL内の `aud` 一致サービスへの直接再提示）は短TTLで緩和する
- 内部サービス間の送信者拘束が本番要件になる場合は mTLS（RFC 8705）が適切な対策であり、§11に選択肢として付記している

### issuerの「localhost」感・ポート番号残存

edge-proxy化後もissuer（`http://localhost:3000/realms/kikan-system`）には`localhost`という文字列とポート番号が残っている。実運用のIdP（例: `https://accounts.google.com`）はどちらも持たないため、違和感自体は正当な指摘。

- どちらも解消するには、ホストマシンの`/etc/hosts`に偽のホスト名（例: `kikan-system.local`）を追加し、edge-proxyをポート80で公開する必要がある。これはリポジトリ外（クローンした各人の環境）への変更を要求するため、「ローカルでdocker compose一発で動く」というこのリポジトリの前提を損なう
- 検討の結果、現状（`http://localhost:3000`）を維持し、既知の制約として本節に明記するのみとした
