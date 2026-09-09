# OAuth 2.0 Token Exchange サンプル実装 設計ドキュメント

本ドキュメントは決定事項（結論と根拠）を記録する生きた文書。検討過程や却下案の経緯は記載しない。決定が変わった場合は該当箇所を直接書き換える。

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
[Frontend: TypeScript (SPA)]
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

### サービスと言語の対応

| サービス | 言語 | 役割 |
|---|---|---|
| Frontend | TypeScript | ユーザーログイン(OIDC Authorization Code + PKCE)、Order Service 呼び出し |
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

各サービスの存在意義・提供機能・保有データは `docs/services.md`、具体的な業務シナリオと委任チェーンの流れは `docs/use-cases.md` に定義する。

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
- `docker compose up` 一発で Keycloak + 4サービス + 4種DB + frontend + grafana/otel-lgtm(トレース可視化, §10) が起動できる構成とする

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
| 委任チェーンの事後監査証跡（`act`相当） | 標準V2ではJWTに残らない。Keycloak内部の管理イベントログには残る | ログ突合で代替（§10） |

**結論**：実験的機能には依存せず、Standard Token Exchange V2 のみを使用する。

## 10. 委任チェーンの事後監査

独自のヘッダやログ形式は発明しない。**OpenTelemetry（W3C Trace Context）** に従う。

- `traceparent`ヘッダで trace_id を全ホップ（Frontend→Order→Inventory→Warehouse→Employee）に伝播する
- 各サービスは自分のspanとして親span_idのみを記録する。経路全体の再構築は収集基盤側の責務であり、各サービスが経路全体を保持・転送する必要はない
- 各言語のOTel SDKはHTTPクライアント/サーバーの自動計装を持つため、独自ログ項目を設計するより実装コストが低い
- 可視化用に **`grafana/otel-lgtm`**（Grafana+Tempo+Loki+Prometheus/Mimirが1コンテナに統合された公式イメージ）を docker-compose に追加する。OTLPエンドポイントが1つで完結し設定不要。今回使うのはトレース（Tempo経由）のみで、メトリクス計装やダッシュボード構築は行わない

**根拠**：
- 自己申告ヘッダ（例: `X-Delegation-Chain`）は署名も検証もされず認可判断の根拠にできない
- 認可トポロジーのリアルタイム制御は既にoptional client scopeの割当が担っている（クライアント認証と紐づいてKeycloakが強制する）
- 「誰が誰の代わりに交換を要求したか」という認可判断の事実はKeycloakの管理イベントログに既に記録されている。OTelトレースは「経路の可視化」を担い、Keycloakイベントログは「認可交換の事実の記録」を担う。役割が異なるため両方を残す
- 独自ログ形式は既存標準（OTel）の再発明であり、可視化ツール（Jaeger等）との連携も失われる

### 将来の学習ポイント：Keycloak監査ログとOTelトレースの突合

「認可交換の事実の記録（Keycloak）」と「経路の可視化（OTel）」という別々の情報源を、実際にどう突き合わせて確認できるかを示すことは、本サンプルの学びとして価値がある（今すぐの実装は不要、後日着手）。

- 単純にはタイムスタンプ・`sub`・`aud`でKeycloakの管理イベントとOTelトレースを手動突合する形になる
- より進めるなら、各サービスがToken Exchangeリクエストを送る際に`traceparent`ヘッダをKeycloakへのHTTPリクエストにも付与し、Keycloakの管理イベントログ（またはイベントリスナーSPI）がtrace_idを記録できるか調査する価値がある。実現できればtrace_idそのものでの機械的な突合が可能になる

## 11. トークン漏洩・再提示リスクへの対策

ベアラートークン一般の漏洩・再提示リスク（漏洩したトークンは提示者を選ばず受理される）への対策として以下を採用する。

### 採用: DPoP (RFC 9449)

- クライアント（各サービス）が自分の秘密鍵で署名した証明(DPoP Proof JWT)を`DPoP`ヘッダで毎回送信
- アクセストークンの`cnf`クレームに公開鍵のハッシュを埋め込み、リソースサーバーは「提示者が本当に鍵を持っているか」を検証する
- トークンだけが漏洩しても秘密鍵がなければ再利用できないため、送信者拘束(sender-constrained)を実現できる
- Keycloakは標準サポートあり（クライアントごとに有効化）。mTLS(RFC 8705)より導入コストが低く、docker-compose環境に適する

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

**結論**：追加のClient Policies（`reject-request`実行アクションやクライアントロールのマーカー）は不要。スコープ絞り込みという要件を満たすためのoptional client scope割り当てが、副産物として委任トポロジー制御も担う。当初検討したClient Policies案（audience条件が存在しないため代替していたスコープ＋クライアントロール方式）は、より単純なこの仕組みに置き換える。

DPoP（§11）はClient Policiesの`dpop-bind-enforcer`実行アクションを引き続き使用する（こちらはトポロジー制御とは別目的）。

## 13. Keycloak realmのコード化

`keycloak/Dockerfile`（`quay.io/keycloak/keycloak:26.4`を継承し`keycloak/realm-export.json`を`--import-realm`で読み込む）を`compose.yml`のビルド対象とする。`docker compose up`のたびに同じ状態が再現される。

realm-export.jsonは**Keycloakの完全な設定ダンプではなく、意図して追加・変更した項目だけ**を書く（realm本体、client scope 4種とaudienceマッパー、client 5種とその設定、テストユーザー1件）。理由：

- Keycloakは指定しなかったフィールドを自身のデフォルト値で補う（realm作成を`{"realm":"...","enabled":true}`だけのリクエストで行っても正しく動くことを確認済み）
- 完全dumpにはOTPポリシーやセッションタイムアウト等、一度も検討していない大量のデフォルト値が含まれ、どこが自分たちの決定かをレビューで判別できなくなる
- 実際にこの縮小版（フルエクスポート比で約1/6のサイズ）で`docker compose up --build`からHop1/Hop2成功・未許可経路の拒否まで再現できることを確認済み

### 縮小版realmで追加対応が必要だった項目

realm importでは（単純な`POST /admin/realms`でのrealm作成と異なり）`clientScopes`を明示指定すると、Keycloak組み込みの`roles`/`profile`等は一切マージされない（§9の委任トポロジー制御の発見と同種の罠）。これにより以下も自分で明示する必要があった。

- `sub`クレーム：組み込みでは自動的に付与されず、`oidc-sub-mapper`を`roles`スコープに追加する必要がある（実機で確認：追加前はaccess_tokenに`sub`が一切含まれずToken Exchange時の記録が取れなかった）
- **`KC_HOSTNAME`の固定**：内部（docker network経由、例: `http://keycloak:8080`）と外部（ホストマシン経由、例: `http://localhost:8080`）でKeycloakへの到達ホスト名が異なると、Keycloakは自分自身のissuerをリクエストごとに動的算出するため、外部で発行されたトークンをサービスが内部経路でToken Exchangeしようとすると`invalid_request: Invalid token`で拒否される。`KC_HOSTNAME=http://localhost:8080`で固定し解決した（実機で確認）

## 14. Order Service実装

`order-service/`にJava/Spring Bootで実装済み。

- エンティティ：`Order`（customerId, productId, quantity, status, createdAt）。PostgreSQL、スキーマは`order-service/db/init.sql`をpostgresコンテナに`/docker-entrypoint-initdb.d/`としてマウントして作成し、Hibernateの`ddl-auto`は`validate`のみに留める（ORM自動生成だと初期データ投入や意図的なスキーマ管理がしづらいため）
- `POST /orders`：`order-writer`ロール必須。Inventory Service向けにToken Exchange（audience=inventory-service, scope=inventory）を実行し、得たトークンで実際にInventory Serviceの`POST /inventory/{id}/reserve`を呼び出す。成功すればCONFIRMED、在庫不足（409）ならREJECTEDとして永続化する
- `GET /orders`, `GET /orders/{id}`：`order-writer`または`order-reader`ロールで許可
- 実機検証済み：yamada-sales（order-writer）で受注登録→Token Exchange→Inventory Serviceへの実引当まで成功しCONFIRMED、在庫不足の商品はREJECTED、suzuki-support（order-reader）は登録403・照会200、tanaka-hr（ロールなし）は照会403

## 15. Inventory Service実装

`inventory-service/`にGoで実装済み。

- テーブル：`products`（id, name, aggregate_stock, primary_branch）。MySQL、スキーマとseedデータは`inventory-service/db/init.sql`をmysqlコンテナに`/docker-entrypoint-initdb.d/`としてマウントして投入。`primary_branch`は「この商品の実引当をどの支店のWarehouse Serviceに委ねるか」を表す（実際には複数支店に分散可能だが、本サンプルでは1商品1支店に単純化）
- `GET /inventory/{id}`：`inventory-reader`または`inventory-writer`ロールで許可。**Warehouse Serviceを一切呼ばない**（services.md記載の通り、集計値はWarehouse Serviceから非同期同期される想定で、seedデータで代替している）
- `POST /inventory/{id}/reserve`：`inventory-writer`ロール必須。在庫不足なら409を返す。Warehouse Service向けにToken Exchange（audience=warehouse-service, scope=warehouse）を実行し、得たトークンで`primary_branch`のWarehouse Serviceへ実際に引当リクエストを送る
- JWT検証はGoで自前実装（`golang-jwt/jwt/v5` + JWKSを手動パース。`keyfunc/v3`はGo 1.25+要求で依存が重いため不採用）。Order Serviceと同様、JWKSは内部ホスト名から取得しつつissuerは外部向け値で検証する分離が必要
- 実機検証済み：Order Service経由で在庫十分→CONFIRMED、在庫不足→REJECTEDまで一気通貫で確認。Inventory Service単体でも`inventory-reader`はGETのみ許可・`reserve`は403で拒否されることを確認

## 16. Warehouse Service実装

`warehouse-service/`にRustで実装済み（axum + tokio + jsonwebtoken + redis）。

- データ：支店別在庫を`stock:{branch}:{productId}`のRedisキーで保持。**Redisには`docker-entrypoint-initdb.d`相当の仕組みがない**ため、`warehouse-service/db/Dockerfile`で公式`redis`イメージを継承し、`seed.sh`がredis-serverを起動→seed投入（`SETNX`で冪等）→foregroundで待機、という構成にした（アプリ本体がシードするのではなく、Postgres/MySQLと同じ「バックエンドイメージが自分の初期データを持つ」方式に統一）
- `GET /warehouse/{branch}/stock/{productId}`, `POST /warehouse/{branch}/stock/{productId}/reserve`：`warehouse-viewer`または`warehouse-viewer-all`ロールが必須（RBAC）。`warehouse-viewer-all`はここで判定終了、`warehouse-viewer`のみの場合はさらに所属支店と`{branch}`が一致するかを確認する（ABAC）
- 所属支店の判定はEmployee Serviceへの実問い合わせで行う。Token Exchange（audience=employee-service, scope=employee)で得たトークンを使い`GET /employees/{preferred_username}`を実際に呼び出す（`sub`はrealm再importごとに変わるため`preferred_username`をキーにした。`roles`スコープに`oidc-usermodel-property-mapper`を追加）
- 実機検証済み：東京支店担当のyamada-salesは東京在庫を照会・引当できるが大阪は403、`warehouse-viewer-all`のsato-logisticsはどちらも200、倉庫系ロールを持たないtanaka-hrは403
- Rust特有の落とし穴：①`reqwest`のデフォルトTLS(OpenSSL)はビルド環境にpkg-config/OpenSSLが必要で失敗したため`rustls-tls`に切替。②Dockerfileでの「ダミーmain.rsで依存だけ先にビルド」は、BuildKitのcache mountと組み合わさるとcargoが実ソースの変更を検知せず古いバイナリを使い続けるという実害のある罠だった（cache mountはビルド間で永続化するのでこのトリック自体が不要）。③axum 0.7のパスパラメータ記法は`{param}`ではなく`:param`（`{}`はaxum 0.8以降の記法で、0.7では静かに404になる——パニックしないため気づきにくい）

## 17. Employee Service実装

`employee-service/`にPython（FastAPI + PyJWT + pymongo）で実装済み。

- `GET /employees/{username}`：トークンの`preferred_username`が`{username}`と一致すれば誰でも許可（自分の情報）。不一致でも`hr-viewer`ロールがあれば許可。それ以外は403
- データ：MongoDBの`employees`コレクション（username, department, branch）。MongoDBの公式イメージは`docker-entrypoint-initdb.d/`相当の仕組み（`.js`ファイルの自動実行）を標準で持つため、RedisのようなカスタムDockerfileは不要で`employee-service/db/init-mongo.js`をそのままマウントするだけで済む
- 実機検証済み：Order Service→Inventory Service→Warehouse Service→Employee Serviceの4サービス・3ホップ委任チェーンが実際のHTTPで完結することを確認（`GET /employees/yamada-sales`がWarehouse Serviceから実際に呼ばれ200を返す）。東京担当が東京商品を受注→CONFIRMED、大阪担当商品（在庫0）を受注→REJECTEDまで一気通貫

## 18. docker-composeのヘルスチェック・起動順序

全11コンテナに`healthcheck`を設定し、`depends_on`を`condition: service_healthy`にした（frontend・edge-proxyは§22のBFF移行時に追加）。`docker compose up -d`一発で手動再起動なしに全サービスが`healthy`になることを実機で確認済み。

- **Keycloak**：イメージに`curl`/`wget`が無い（UBI Micro系ベース）が`bash`はあるため、`/dev/tcp`で直接HTTPリクエストを送り200を確認する方式にした。当初はrealmのwell-known endpointを使っていたが、§21のトレーシング導入時に専用のヘルスエンドポイント（`KC_HEALTH_ENABLED=true`で有効化されるmanagementポート9000の`/health/ready`）に切り替えた。理由は2つ：(1) ビジネス用エンドポイントを間借りするより「Keycloak自身が readyと申告しているか」を直接見るほうが本来の意味で正しい、(2) このエンドポイントはQuarkusの計装から自動除外されるため、5秒間隔のヘルスチェックがトレースのノイズにならない
- **postgres/mysql/redis/mongo**：各公式イメージの標準ツール（`pg_isready`, `mysqladmin ping`, `redis-cli ping`, `mongosh --eval`）をそのまま使用
- **4アプリサービス**：各サービスに認証不要の`GET /health`を追加し、`wget`（Java/Go/Rustの最終イメージはalpine系で軽量なため`curl`ではなく`wget`を追加）または`python3 -c "import urllib.request..."`（Pythonは標準機能だけで足りるため追加パッケージ不要）で確認
- **frontend（Nuxt）**：既存の`GET /api/me`（認証不要、未ログイン時は`{loggedIn:false}`を返す）をそのままヘルスチェックに使用。専用エンドポイントの追加は不要だった
- **edge-proxy（nginx）**：当初はKeycloakの`/realms/.../well-known/openid-configuration`（ビジネス用エンドポイント）へのプロキシ経由リクエストで確認していたが、§21での見直しで専用の内部ロケーション`/internal/keycloak-health`（Keycloakの`/health/ready`へプロキシするだけ）に切り替えた。nginx自身の生存とKeycloakへの実際のプロキシ経路の両方を検証できる点は変わらないが、ビジネス用エンドポイントを間借りしない分Keycloak側でも意味的に正しいヘルスチェックになった
- 依存関係は「各アプリサービス→Keycloak（healthy）＋自分のDB（healthy）」のみとした。アプリサービス間（order→inventory→warehouse→employee）は起動時に呼び合わないため、`depends_on`の対象に含める必要はない（起動失敗の実例はKeycloak未起動時のJWKS取得失敗によるクラッシュのみだった）。edge-proxyのみ例外的に`frontend`・`keycloak`両方の`service_healthy`を待つ（自身がプロキシする2つの宛先そのものだから）

## 19. Frontend実装（BFF、v1: SPA + oidc-client-tsは廃止）

`frontend/`はNuxt 4（Nitro）による単一コンテナのBFF (Backend for Frontend) として実装済み。旧v1実装（Vite + vanilla TS + `oidc-client-ts`、ブラウザにトークンを保持するSPA）は完全に削除し、置き換えた。移行の背景・トポロジーは§22を参照。

- ログイン・トークン保有・DPoP鍵保有は全てサーバーサイド（Nitroの`server/api/*`）で行う。ブラウザにはJSでアクセス可能なアクセストークンを一切渡さない（`httpOnly`セッションクッキー1つのみ）
- Authorization Code + PKCEは`server/utils/pkce.ts`で自前実装（`code_verifier`/`code_challenge`をKeycloakへの実リダイレクト前にサーバー側で生成し、`state`をキーにインメモリで一時保持）。`jose`ライブラリはDPoP鍵生成・Proof署名にのみ使用
- セッションは`server/utils/session.ts`のインメモリ`Map`（コンテナ1台構成のため共有ストアは不要。コンテナ再起動で全ユーザーがログアウトされる制約は許容）
- 画面（`app/app.vue`）は受注登録フォーム・受注一覧・社員情報照会のみで、全て同一オリジンの`/api/*`へfetchする

### E2Eテスト

`frontend/e2e/login-and-order.mjs`（`npm run e2e`）としてPlaywright E2Eテストを常設。ログイン（edge-proxy経由でKeycloakのログイン画面へ遷移し、PKCE確認）→受注登録（実際にInventory/Warehouse Serviceを経由してCONFIRMED）→一覧反映→自分の社員情報照会、までを実ブラウザで検証する。`keycloak/tests/permission-matrix.sh`がKeycloak層の検証を担うのと対になる、UIからの検証。

v1時代に見つかった「CORS未設定」「ID Tokenにクレームが載っていない」の2バグはBFF化で構造的に解消済み（ブラウザがOrder/Employee Serviceを直接fetchしなくなったためCORS設定自体が不要になり、ID Tokenはブラウザに渡らずサーバー側でのみ検証されるため無関係になった）。BFF移行後もPlaywrightでの実ブラウザ検証を継続する方針は維持する（§22で新たに見つかった不具合も参照）。

## 20. DPoP実装

§11で採用を決めたDPoP (RFC 9449) を実装済み。frontend（ユーザーがブラウザで直接触る、最も漏洩経路の多い区間）のみに絞り、内部のサービス間委任チェーン（Order→Inventory→Warehouse→Employee）は対象外とした。

- **Keycloak**：`frontend`クライアントの属性に`dpop.bound.access.tokens: true`を設定。これだけでKeycloakは(a)トークン発行時にDPoP Proofを必須にし、(b)発行するアクセストークンに`cnf.jkt`（公開鍵のJWK拇印）を埋め込むようになる
- **Frontend（BFF）**：鍵ペア生成・Proof JWT署名は`server/utils/dpop.ts`（`jose`ライブラリ、ES256）でサーバーサイドに自前実装。鍵ペアはセッションと同じインメモリストアに保持し、ログイン時に生成した1つの鍵をそのセッション中は使い回す。APIコールは`Authorization: DPoP <token>` + `DPoP: <proof>`ヘッダーで送る
- **Order Service・Employee Service**（frontendから直接呼ばれる2サービス）：DPoP Proofの検証を実装。①`typ`ヘッダー確認 ②Proof自体の署名検証 ③Proofの`jwk`から計算したJWK拇印(RFC 7638)とアクセストークンの`cnf.jkt`の一致 ④`htm`/`htu`がリクエストと一致 ⑤`iat`が許容範囲内(±60秒) ⑥`ath`（アクセストークンのSHA-256ハッシュ）が一致。Javaは`Nimbus JOSE+JWT`（`spring-boot-starter-oauth2-resource-server`の既存推移依存、追加不要）、Pythonは`cryptography`+`PyJWT`で自前実装
- **訂正（§22で実機再検証）**：以前ここには「Token Exchangeで得る内部トークンには`cnf`が付与されない」と記載していたが誤り。正しくは、`cnf.jkt`が付くかどうかは**Token Exchangeの呼び出し元クライアント自身に`dpop.bound.access.tokens: true`が設定されているか**で決まる（グラント種別に関係なく、そのクライアントへ発行される全トークンに適用される）。Order/Inventory/Warehouse Serviceの各クライアントはこの属性を持たないため交換後トークンは非DPoPになり、frontendクライアント（この属性を持つ）が自ら行うToken Exchangeでは交換後トークンにも`cnf.jkt`が継承される。BFFがOrder/Employee Serviceへ渡す交換後トークンはDPoPで送信する必要がある（§22参照）
- 実機検証済み：①DPoP Proof無しでのログイン試行は`DPoP proof is missing`で拒否 ②発行されたトークンを漏洩想定でDPoP Prop無しに素の`Bearer`として再送すると401で拒否（サーバー側の送信者拘束が機能している証拠） ③実ブラウザE2Eテスト（Playwright）でログイン→受注→社員情報照会まで全て成功
- `keycloak/tests/permission-matrix.sh`もDPoP必須化に対応（`dpop_proof()`ヘルパーを追加し、フロントエンドログイン相当の全呼び出しにDPoP Proofを付与）。CORSの許可ヘッダーに`DPoP`を追加し忘れて一時的にブラウザから呼べなくなった点も修正済み

## 21. OpenTelemetry分散トレーシング実装

§10で決めた方針（独自ヘッダは発明せずOpenTelemetry/W3C Trace Contextに従う）を実装。5サービス＋Keycloakに各言語のOTel SDK/自動計装を導入し、`grafana/otel-lgtm`（Tempoのみ使用、メトリクス・ダッシュボードは対象外）へOTLP/HTTP(protobuf)でエクスポートする。edge-proxyは意図的に計装しない（後述）。

- **各サービスの実装方式**：Order Service（Java）はSpring Boot標準のMicrometer OTelブリッジ（`spring-boot-starter-actuator` + `micrometer-tracing-bridge-otel` + `opentelemetry-exporter-otlp`、`RestClient.Builder`はSpring自動設定のもの経由でDIし直して自動計装を効かせる）。Inventory Service（Go）は`otelhttp.NewHandler`でmuxをラップし、`otelhttp.NewTransport`を使うHTTPクライアントで発信側も計装。Warehouse Service（Rust/axum）は`axum-tracing-opentelemetry`のミドルウェア（発信側は計装ライブラリが無く手動対応、後述）。Employee Service（Python/FastAPI）は`opentelemetry-instrument`によるゼロコード自動計装。Frontend（Nuxt/Nitro）はNode `--import`で`server/otel.mjs`を起動前に読み込み`NodeSDK`＋`HttpInstrumentation`/`UndiciInstrumentation`を登録。Keycloakは`KC_TRACING_ENABLED`/`KC_HEALTH_ENABLED`（Quarkus標準機能、コード変更不要）
- **DBレベルのスパンも追加**：Order Service（JDBC/PostgreSQL）は`net.ttddyy.observation:datasource-micrometer-spring-boot`（1.x系、Spring Boot 3.x向け。2.x系はSpring Boot 4.x向けなので注意）を依存追加するだけで、既存の`DataSource` Beanに自動でMicrometer Observationの計装が乗る。Inventory Service（MySQL）は`sql.Open`を`github.com/XSAM/otelsql`の`otelsql.Open`に置き換えるだけ。Warehouse Service（Redis）は計装ライブラリが存在せず手動スパン（後述）。Keycloak（H2）とEmployee Service（MongoDB）はそれぞれQuarkusのHibernate計装／Pythonのゼロコード自動計装が pymongo を自動検出するため、追加作業なしで最初から取れていた
- **env変数はサービス間で統一**：`OTEL_SERVICE_NAME` / `OTEL_EXPORTER_OTLP_ENDPOINT`（ベースURL、パスは各SDKが付与）の2本を共通で使う。JavaのみSpring側の設定キーが`management.otlp.tracing.endpoint`（フルURL必須）だが、`${OTEL_EXPORTER_OTLP_ENDPOINT:...}/v1/traces`という形でプレースホルダ+リテラル連結し、env変数名自体は統一を保った
- **Grafanaはedge-proxy経由でサブパス公開**：`otel-lgtm`のホストポートは公開せず（`GF_SERVER_ROOT_URL`/`GF_SERVER_SERVE_FROM_SUB_PATH`で`/grafana/`配下に設定）、edge-proxyの`/grafana/`から`otel-lgtm:3000`へプロキシ。ホストに公開するポートを3000番（edge-proxy）のみに保つため
- **ヘルスチェックはトレースから除外**：docker composeの各ヘルスチェック（5秒間隔）がそのままスパン化されるとTempoのservice graphが常時ノイズだらけになる。サービスごとに手段が異なる：Go(`otelhttp.WithFilter`)、Rust(axum-tracing-opentelemetryの層を通す**前**に`/health`ルートを追加。層は追加済みルートしかラップしないという仕様通りの挙動)、Python(`OTEL_PYTHON_FASTAPI_EXCLUDED_URLS`環境変数。ゼロコード計装のため他に手段が無い)、Java(`ObservationPredicate` Bean)、Nuxt(`HttpInstrumentation`の`ignoreIncomingRequestHook`。`/api/me`は実際のセッション確認にも使われる二重目的のエンドポイントのため、パスではなくヘルスチェック側が送る`X-Health-Check`ヘッダで判別)、Keycloak(`--health-enabled`でmanagementポート`9000`の`/health/ready`に切り替え。Quarkusの`quarkus.otel.traces.suppress-non-application-uris`が既定で有効なため計装から自動除外される)
- **実機検証済み**：ログイン→受注登録の実フローを流し、Tempoに対して`edge-proxy → frontend → order-service → inventory-service → warehouse-service/keycloak/employee-service`の各スパンが単一のtraceIDで連結されていること、およびPrometheus上の`traces_service_graph_request_total`が実態通りのエッジ（`user → frontend`/`user → keycloak`、各サービス間の呼び出し、各サービスのDB接続）を示していることを直接確認した

### frontendが実は一切トレースを出していなかった：Node の `--import` だけではESMは計装されない

サービスグラフを見ると、Keycloakの内部DBスパン以外ほぼ全てのノードが素性不明の「user」に直結して見える、という指摘から発覚。原因はfrontend（Nuxt/Nitro）が**受信リクエストのスパンを一切生成していなかった**ことで、edge-proxyから渡された`traceparent`を引き継げず、frontendから先の全呼び出しがそれぞれ新規のルートトレースとして始まっていた。

- `@opentelemetry/instrumentation-http`等のNode計装は`import-in-the-middle`（`require-in-the-middle`のESM版）でモジュールロードをフックする。Nitroのビルド成果物（`.output/server/index.mjs`）は純粋なESMで、Node起動時の`--import ./server/otel.mjs`フラグは**CommonJSの`require()`しかフックできない**。ネイティブの`import`文には一切効かず、`http.createServer.__wrapped`が`undefined`のまま＝計装ゼロという状態になっていた
- `@opentelemetry/instrumentation`パッケージ自身のREADMEに答えがある：「ESM計装用の専用フックは`--experimental-loader=@opentelemetry/instrumentation/hook.mjs`」。ただしこのCLIフラグはNode側で非推奨警告が出るため、`node:module`の`register()`（Node 20.6+/18.19+の非推奨ではない代替API）を`server/otel.mjs`の一番最初で呼ぶ形で実装した
- 実機検証：修正前は`/api/me`への実リクエストを送って70秒待ってもTempoに一切現れなかった（healthcheck由来のノイズではなく、本当にゼロ）。修正後、edge-proxy→frontendのスパンが正しく親子連結されることを確認した

### edge-proxyは意図的に計装しない：nginxの otel モジュールは受信側のスパンしか作れない

当初edge-proxy（nginx、`nginx:*-alpine-otel`イメージ + `ngx_otel_module`）にも計装を入れたが、最終的に撤去した。

- `ngx_otel_module`が提供するディレクティブは`otel_exporter`・`otel_service_name`・`otel_trace`・`otel_trace_context`等のみで、`proxy_pass`で下流に転送する側に対応する`CLIENT`スパンを生成する機能が存在しない。生成されるのは常に受信リクエストの`SPAN_KIND_SERVER`スパン1本のみ
- Tempoのservice graph生成処理（`metrics_generator`の`service-graphs`プロセッサ、Grafanaの「Service Graph」パネルの実データ源）は、CLIENT側スパンとSERVER側スパンのペア（spanIdとparentSpanIdの一致）を根拠にエッジを描画する。生トレース（waterfall表示）ではparentSpanIdによる親子関係がそのまま可視化されるため正しく繋がって見えるが、この2つは別のパイプラインであり、edge-proxy側にCLIENTスパンが無い以上Service Graphは「呼び出し元不明」として下流（Keycloak・frontend）を`user`直結として描画する。Tempo公式ドキュメントにも明記されている既知の仕様（"Uninstrumented client (missing client span)"）であり、バグではない
- `otel_trace_context propagate`（受信traceparentの継承＋下流への注入）自体は正しく機能しており、これを外すと今度は**trace_id自体が下流で分断される**（実機で確認済み：Keycloak側が全く別のtraceIDでルートトレースを開始してしまう）。「service graphのエッジが直らない」問題と「trace_idが分断される」問題は別物なので混同しないこと
- 解決策（Collectorでのスパン合成、`peer_attributes`によるピア名推定、Envoy等への置き換え）はいずれも検討したが、[services.md](services.md)がedge-proxyを「ドメインロジックを持たない純粋なインフラ層、認可上の主体ではない」と最初から位置づけていることを踏まえ、計装自体を撤去する方針にした。CDN/APIゲートウェイの背後にあるオリジンサーバーが直接`user`から呼ばれたように見えるのは、edge-proxyを透過的なインフラとして扱えば実態として正しい。結果、`nginx:*-alpine-otel`イメージや専用の`nginx-main.conf`（`otel_exporter`はhttpコンテキストにしか書けないため分離が必要だった）も不要になり構成がシンプルに戻った

### Rust: `reqwest-tracing`クレートは本リポジトリの依存バージョンと両立しない

Warehouse Serviceの発信HTTP呼び出し（Keycloakへのtoken exchange、employee-serviceへの照会）とRedis呼び出しにCLIENTスパンが無く、Service Graph上でエッジが欠落していた問題への対応中に判明。

- `reqwest-tracing`は`opentelemetry`のバージョンごとにフィーチャーフラグでpackageを切り替える方式だが、**このリポジトリが使う`opentelemetry 0.32`系に対応するバージョン（0.7.x）は`reqwest 0.13`を要求する**。本リポジトリは`opentelemetry-otlp`のreqwestクライアント機能がreqwest 0.13必須（rustls統合がaws-lc-rs必須＝cmakeが要る）であることを理由に、`hyper-client`機能へ切り替えてreqwestを0.12に留めた経緯がある（下記「既存の罠」参照）。一方、reqwest 0.12と両立する`reqwest-tracing`（0.5.x系）は`opentelemetry 0.26`までしか対応しておらず、`axum-tracing-opentelemetry 0.39`（本リポジトリの受信側計装）が`opentelemetry 0.32`/`tracing-opentelemetry 0.33`を厳密に要求するため、どちらを立てても他方が壊れる板挟みになる
- 対応：`reqwest-tracing`crateは使わず、`tracing::info_span!`で`"otel.kind" = "client"`フィールド（`tracing-opentelemetry`が特別扱いする予約フィールド名）を持つスパンを手動生成し、`.instrument()`で発信呼び出しを包む形にした。ヘッダへの`traceparent`注入はもともと`opentelemetry_http::HeaderInjector` + `global::get_text_map_propagator`で自前実装済みだったので、スパンで包むだけで済んだ
- Redis呼び出しも同様に対応（`redis`クレートにはこの種の計装ライブラリが存在しない）。`db.system`/`db.name`の semantic conventions属性を付けたスパンで手動計装
- **副産物として見つかった実バグ**：`token_exchange.rs`のKeycloakへの呼び出しは、CLIENTスパンが無いだけでなく`traceparent`ヘッダの注入自体を一切行っていなかった（employee-serviceへの呼び出しは注入していたのに、Keycloakへの呼び出しは漏れていた）。Service Graphのエッジ欠落を追っている過程で発見し、あわせて修正した

### Keycloakの`--tracing-enabled`/`--health-enabled`はビルド時に焼き込んでも無意味

Keycloak公式ドキュメントは両オプションを「ビルド時オプション」と説明しており、当初`keycloak/Dockerfile`に`RUN kc.sh build --tracing-enabled=true --health-enabled=true`を追加したが、`--health-enabled`の効果が実機で全く確認できなかった（`/health`は404、managementポート`9000`もリッスンしない）。

- 実機検証で判明：`start-dev`（Keycloakのdevモード起動コマンド）は**コンテナ起動のたびに暗黙の再ビルド（augmentation）を行い**、その際に使われるビルドオプションはDockerfileで焼き込んだ値ではなく、その時点のCLI引数/環境変数から再計算される。つまりdevモードで動かす限り、Dockerfileでのビルド時焼き込みには何の意味もない
- 対応：`RUN kc.sh build ...`のステップを削除し、`KC_TRACING_ENABLED`/`KC_HEALTH_ENABLED`をcompose.ymlのランタイム環境変数として渡すだけにした（他サービスの`OTEL_SERVICE_NAME`と同じ扱いに統一）。プレーンな`quay.io/keycloak/keycloak:26.4`イメージ＋これらの環境変数だけで機能することを`docker run`単体でも確認済み

### 既存の罠（Goのエンドポイント付与漏れ、Rustのランタイム/ログレベル問題など）

- **Goの`otlptracehttp.WithEndpointURL`は`/v1/traces`を自動付与しない**：`WithEndpoint`（ホスト:ポートのみ渡す版）は補完するが、`WithEndpointURL`はURLをそのまま使うため、ベースURLを渡すと`http://otel-lgtm:4318/`宛に送られ404になる。パスは呼び出し側で明示的に付与する必要がある
- **Rust: `opentelemetry-otlp`のreqwestクライアント機能はreqwest 0.13を要求し、0.13のrustls統合はaws-lc-rs必須（cmakeが要る）**：本リポジトリはmusl/alpineビルドでcmakeを避けたい（reqwestのTLSバックエンドを以前OpenSSL不在の理由でrustls-tlsへ切替済み、§既出）。`opentelemetry-otlp`の`hyper-client`機能（`opentelemetry-http`のhyperベースクライアント、reqwest非依存）を使うことで、アプリ自身のreqwestは0.12+rustls-tls（ring、cmake不要）のまま維持できる。この「reqwestを0.12に留める」制約が、上記の`reqwest-tracing`crateを使えない直接の原因になっている
- **Rust: `axum-tracing-opentelemetry`はデフォルトでTRACEレベルのスパンを生成する**（target `otel::tracing`）。Dockerfileの`RUST_LOG=info`と噛み合わず全リクエストのスパンが実際には作られず`SpanDisabled`警告が出続ける。`axum-tracing-opentelemetry`の`tracing_level_info`フィーチャーでINFOレベルに変更して解決
- **Rust: hyperベースのOTLPエクスポーターは非同期ランタイム上で動く必要がある**が、`SdkTracerProvider::builder().with_batch_exporter(...)`のデフォルトはTokioに紐付かない別OSスレッドでエクスポートするため`no reactor running`でパニックする。`opentelemetry_sdk`の`rt-tokio` + `experimental_trace_batch_span_processor_with_async_runtime`フィーチャーで`span_processor_with_async_runtime::BatchSpanProcessor::builder(exporter, runtime::Tokio)`を使うことで解決
- **`grafana/otel-lgtm`イメージには`wget`が無く`curl`のみ**：他サービスのヘルスチェックをコピーした`wget`ベースの定義をそのまま使うと常に失敗する

## 22. BFF化とedge-proxyの導入

v1のSPA構成は、アクセストークンをブラウザ側（`oidc-client-ts`経由でIndexedDB等）に保持していた。OAuth 2.0 Security BCP（Browser-Based Apps向けガイダンス）はこれをXSSによる漏洩リスクとして非推奨としており、この点を修正するため以下の構成へ移行した。

- **Frontendのサーバー化**：`frontend/`をNuxt（Nitro）の単一コンテナに置き換え、ログイン処理・トークン保有をサーバーサイド（`server/api/*`）に完全移動（§19）
- **edge-proxyの新設**：`edge-proxy/`（nginx）をfrontendの前段に配置し、ホストに公開する唯一の入口とした。`/realms/*`・`/resources/*`はKeycloakへ、それ以外はfrontendへ振り分ける。CDN/APIゲートウェイ的な構成を模しつつ、ブラウザから見えるオリジンを単一化する目的
  - frontend自身がリバースプロキシを兼ねる案は採らなかった。実運用でこの位置に来るのはCDN/ゲートウェイであり、アプリケーションプロセスとは別のコンポーネントであるほうが実態に近いため
- **Keycloakのホスト直接公開を廃止**：`KC_HOSTNAME`をedge-proxyの公開アドレス（`http://localhost:3000`）に固定し、Keycloakコンテナ自体のホストポート公開（旧`8080:8080`）を削除。ブラウザ・バックエンドサービスのどちらも最終的に単一の`iss`値に到達する構成は維持（旧: サービスは`keycloak:8080`、ブラウザは`localhost:8080`という二経路構成だった）
- **frontendクライアントの機密クライアント化**：`publicClient: true`から`false`＋`secret`に変更し、`standard.token.exchange.enabled: true`を追加（BFFが自分自身のクライアントとしてToken Exchangeを行うため）。`directAccessGrantsEnabled`はテストハーネス（`permission-matrix.sh`のパスワードグラントによるユーザートークン取得、DPoP検証込み）のためにあえて`true`のまま残した。BFF自体はAuthorization Code + PKCEしか使わない
- **不要になったホストポート公開の削除**：ブラウザ・テストスクリプトのいずれも各マイクロサービス（8081-8084）やDB（5432/3306/6379/27017）にホスト経由で直接アクセスする必要がなくなったため、`ports:`定義を全て削除（edge-proxyの3000のみ公開）
- **CORS設定の削除**：Order Service・Employee Serviceはブラウザから直接呼ばれなくなったため、両サービスのCORS設定を削除
- ファイル名を`docker-compose.yml`から`compose.yml`へ変更（Compose Specification準拠。`docker-compose.yml`は後方互換のために残るサポート対象だが、現在の推奨名は`compose.yaml`/`compose.yml`）

### issuerの「localhost」感・ポート番号残存は既知の制約として受容

edge-proxy化後もissuer（`http://localhost:3000/realms/kikan-system`）には`localhost`という文字列とポート番号が残っている。実運用のIdP（例: `https://accounts.google.com`）はどちらも持たないため、違和感自体は正当な指摘。

- どちらも解消するには、ホストマシンの`/etc/hosts`に偽のホスト名（例: `kikan-system.local`）を追加し、edge-proxyをポート80で公開する必要がある。これはリポジトリ外（クローンした各人の環境）への変更を要求するため、「ローカルでdocker compose一発で動く」というこのリポジトリの前提を損なう
- 検討の結果、現状（`http://localhost:3000`）を維持し、既知の制約として本節に明記するのみとした

### Token Exchangeの呼び出し元がDPoP-boundな場合、交換後トークンもDPoP-boundになる（§20の訂正）

frontendクライアントを経由する実際のToken Exchange呼び出しを実装して初めて判明した。詳細は§20の訂正記載を参照。BFFがOrder/Employee Serviceへ渡す交換後アクセストークンは`cnf.jkt`を持つため、`Authorization: DPoP <token>` + `DPoP: <proof>`で送る必要がある（`server/utils/dpop.ts`の`callDownstream()`）。Proofの`ath`は実際に送信する交換後トークン（元のセッショントークンではない）のSHA-256ハッシュにする必要がある点に注意。

### nginxの`$host`変数はポート番号を落とす → DPoPの`htu`検証が全滅する

edge-proxy導入直後、DPoP必須の全リクエスト（ログイン含む）が`"DPoP HTTP URL mismatch"`で拒否される問題が発生した。原因はnginxの設定ミス：

- `proxy_set_header Host $host;`の`$host`はHostヘッダーからポート番号を取り除いた値になる（nginxの既知の挙動）。結果、Keycloakは`Host: localhost`（ポート番号なし）で受信し、DPoP Proof検証で使う内部的なリクエストURIの再構築がクライアントが送った`htu`（`http://localhost:3000/...`）と食い違っていた
- KC_HOSTNAMEベースの正規化（issuerやdiscovery文書に使われる）とDPoPの`htu`検証は**Keycloak内部で別の経路**を通っており、後者はプロキシを意識しない生のHostヘッダーに依存している。ドキュメントには明記されておらず、bytecodeを逆アセンブルして`org.keycloak.services.util.DPoPUtil`の実装を直接確認して特定した
- 修正：`proxy_set_header Host $host;`を`proxy_set_header Host $http_host;`に変更（`$http_host`はポート番号を保持する）。非DPoPのリクエストはこの問題の影響を受けなかった（`$host`のポート欠落が問題にならない別の検証ロジックを通るため）ため、発見が遅れた

### edge-proxyのヘルスチェックが`localhost`だと`::1`優先で失敗する

`wget http://localhost:3000/...`をedge-proxyコンテナ内で実行すると`Connection refused`になった。nginxの`listen 3000;`はIPv4のみでbindしており、コンテナの`/etc/hosts`は`localhost`を`::1`（IPv6）優先で解決するため、wgetがIPv4へフォールバックする前に拒否される。`127.0.0.1`を明示することで解決（他サービスの`GET /health`ヘルスチェックは各言語のHTTPサーバーがデュアルスタックでbindしているため同じ問題が起きていない）。

### Nitroの`runtimeConfig`は`NUXT_<KEY>`以外の環境変数名を実行時に読まない

`nuxt.config.ts`の`runtimeConfig`に書いたデフォルト値は**ビルド時**に評価される。`docker compose`の`environment:`で渡した素の環境変数名（例: `KEYCLOAK_INTERNAL_URL`）はNitro起動時には反映されず、ビルド時のフォールバック値がそのまま使われてしまう。Nitroが実行時に上書きを認識するのは`NUXT_`プレフィックス＋大文字スネークケース（例: `NUXT_KEYCLOAK_INTERNAL_URL`）の環境変数のみ。`compose.yml`側の環境変数名を全て`NUXT_`プレフィックス付きに修正して解決した。

## 23. 未決事項

- Keycloak監査ログとOTelトレースの突合方法（§10、優先度低）
