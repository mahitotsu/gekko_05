# 実装で得た気づき・罠

実装を進める過程で見つかった、再発しそうな罠や実機検証で判明した仕様上の落とし穴を記録する。設計判断そのものは[architecture.md](architecture.md)、未着手の改善項目は[backlog.md](backlog.md)を参照。

## Keycloak / realm設計

### 縮小版realmで`clientScopes`を明示指定すると組み込みscopeがマージされない

realm importでは（単純な`POST /admin/realms`でのrealm作成と異なり）`clientScopes`を明示指定すると、Keycloak組み込みの`roles`/`profile`等は一切マージされない。これにより以下も自分で明示する必要があった。

- `sub`クレーム：組み込みでは自動的に付与されず、`oidc-sub-mapper`を`roles`スコープに追加する必要がある（実機で確認：追加前はaccess_tokenに`sub`が一切含まれずToken Exchange時の記録が取れなかった）
- 所属支店のような社員情報：`roles`スコープに`oidc-usermodel-property-mapper`を追加しないと`preferred_username`以外のクレームが載らない

### Token ExchangeでのTTLは交換先(audience)ではなく交換元(azp)クライアントの`access.token.lifespan`が効く

`access.token.lifespan`はクライアント属性としてrealmデフォルトの`accessTokenLifespan`を上書きできるが、Token Exchange V2で発行されるトークンにどちらのクライアント（交換を要求した側／要求先のaudience）の属性が適用されるかはドキュメントに明記がなく、実機で確認した。

- 検証方法：`order-service`クライアントにのみ`access.token.lifespan: "45"`を設定し、`inventory-service`（audience側、属性なし）へのToken Exchangeを実行 → 発行トークンの`expires_in`は45（realmデフォルトの300ではない）
- 結論：**交換を要求したクライアント（`azp`となるクライアント、＝`client_id`/`client_secret`で認証した側）の`access.token.lifespan`がそのまま適用される**。audience側クライアントの同属性は無関係
- 実装：委任チェーンでToken Exchangeを要求する3クライアント（order-service/inventory-service/warehouse-service）それぞれに設定する必要がある。1箇所（例えば末端のemployee-service）に設定しても、そのクライアントが要求元にならないホップには効かない（[architecture.md](architecture.md) §11参照）

### `KC_HOSTNAME`の固定が必要

内部（docker network経由、例: `http://keycloak:8080`）と外部（ホストマシン経由、例: `http://localhost:8080`）でKeycloakへの到達ホスト名が異なると、Keycloakは自分自身のissuerをリクエストごとに動的算出するため、外部で発行されたトークンをサービスが内部経路でToken Exchangeしようとすると`invalid_request: Invalid token`で拒否される。`KC_HOSTNAME`を固定することで解決した（実機で確認）。

### `--tracing-enabled`/`--health-enabled`はビルド時に焼き込んでも無意味

Keycloak公式ドキュメントは両オプションを「ビルド時オプション」と説明しており、当初`keycloak/Dockerfile`に`RUN kc.sh build --tracing-enabled=true --health-enabled=true`を追加したが、`--health-enabled`の効果が実機で全く確認できなかった（`/health`は404、managementポート`9000`もリッスンしない）。

- 実機検証で判明：`start-dev`（Keycloakのdevモード起動コマンド）は**コンテナ起動のたびに暗黙の再ビルド（augmentation）を行い**、その際に使われるビルドオプションはDockerfileで焼き込んだ値ではなく、その時点のCLI引数/環境変数から再計算される。つまりdevモードで動かす限り、Dockerfileでのビルド時焼き込みには何の意味もない
- 対応：`RUN kc.sh build ...`のステップを削除し、`KC_TRACING_ENABLED`/`KC_HEALTH_ENABLED`をcompose.ymlのランタイム環境変数として渡すだけにした（他サービスの`OTEL_SERVICE_NAME`と同じ扱いに統一）。プレーンな`quay.io/keycloak/keycloak:26.4`イメージ＋これらの環境変数だけで機能することを`docker run`単体でも確認済み

### BFFパターンでのログアウトはKeycloakのend-sessionエンドポイントへのリダイレクトが必要

BFF（Backend For Frontend）実装でログアウト処理を「サーバー側セッション削除＋セッションクッキー削除→`/`へリダイレクト」だけで実装すると、**Keycloak側のSSOセッションは生き続ける**。

- 実症状：「ログアウト」クリック後にトップページへ戻り、再度「ログイン」をクリックすると、ユーザーにはログインフォームが一切表示されないまま元と同じユーザーとして認証が完了する。アプリ側から見ると「ログアウトできていない」
- 原因：OIDCのend-sessionは「このアプリのセッションを破棄する」ことと「Keycloakが管理するSSOセッション（ブラウザのKeycloakクッキー）を終了する」ことの2段階が必要。BFF側のセッション破棄は前者のみ
- 対応：ログアウト時にKeycloakのend-sessionエンドポイント（`/protocol/openid-connect/logout`）へ `id_token_hint` ＋ `post_logout_redirect_uri` を付けてリダイレクトする。end-sessionエンドポイントがSSOセッション（ブラウザのKeycloakクッキー）を無効化した上で `post_logout_redirect_uri` へ戻してくる

**id_tokenの保持が必要**：`id_token_hint`にはログイン時のIDトークンが必要だが、BFF実装ではダウンストリームAPIアクセスに`access_token`しか使わないため、`id_token`を「不要」として受け取ったまま捨てていた。ログアウト要件を意識しないと`id_token`をセッションに保存するモチベーションが生まれず、見落としやすい。

## DPoP / nginx

### Token Exchangeの呼び出し元がDPoP-boundな場合、交換後トークンもDPoP-boundになる

実際のToken Exchange呼び出しを実装して初めて判明した。以前は「Token Exchangeで得る内部トークンには`cnf`が付与されない」と誤って記載していたが、正しくは、`cnf.jkt`が付くかどうかは**Token Exchangeの呼び出し元クライアント自身に`dpop.bound.access.tokens: true`が設定されているか**で決まる（グラント種別に関係なく、そのクライアントへ発行される全トークンに適用される）。Order/Inventory/Warehouse Serviceの各クライアントはこの属性を持たないため交換後トークンは非DPoPになり、frontendクライアント（この属性を持つ）が自ら行うToken Exchangeでは交換後トークンにも`cnf.jkt`が継承される。BFFがOrder/Employee Serviceへ渡す交換後トークンはDPoPで送信する必要がある（`server/utils/dpop.ts`の`callDownstream()`）。Proofの`ath`は実際に送信する交換後トークン（元のセッショントークンではない）のSHA-256ハッシュにする必要がある点に注意。

実機検証済み：①DPoP Proof無しでのログイン試行は`DPoP proof is missing`で拒否 ②発行されたトークンを漏洩想定でDPoP Prop無しに素の`Bearer`として再送すると401で拒否（サーバー側の送信者拘束が機能している証拠）。

### nginxの`$host`変数はポート番号を落とす → DPoPの`htu`検証が全滅する

edge-proxy導入直後、DPoP必須の全リクエスト（ログイン含む）が`"DPoP HTTP URL mismatch"`で拒否される問題が発生した。原因はnginxの設定ミス：

- `proxy_set_header Host $host;`の`$host`はHostヘッダーからポート番号を取り除いた値になる（nginxの既知の挙動）。結果、Keycloakは`Host: localhost`（ポート番号なし）で受信し、DPoP Proof検証で使う内部的なリクエストURIの再構築がクライアントが送った`htu`（`http://localhost:3000/...`）と食い違っていた
- KC_HOSTNAMEベースの正規化（issuerやdiscovery文書に使われる）とDPoPの`htu`検証は**Keycloak内部で別の経路**を通っており、後者はプロキシを意識しない生のHostヘッダーに依存している。ドキュメントには明記されておらず、bytecodeを逆アセンブルして`org.keycloak.services.util.DPoPUtil`の実装を直接確認して特定した
- 修正：`proxy_set_header Host $host;`を`proxy_set_header Host $http_host;`に変更（`$http_host`はポート番号を保持する）。非DPoPのリクエストはこの問題の影響を受けなかった（`$host`のポート欠落が問題にならない別の検証ロジックを通るため）ため、発見が遅れた

### edge-proxyのヘルスチェックが`localhost`だと`::1`優先で失敗する

`wget http://localhost:3000/...`をedge-proxyコンテナ内で実行すると`Connection refused`になった。nginxの`listen 3000;`はIPv4のみでbindしており、コンテナの`/etc/hosts`は`localhost`を`::1`（IPv6）優先で解決するため、wgetがIPv4へフォールバックする前に拒否される。`127.0.0.1`を明示することで解決（他サービスの`GET /health`ヘルスチェックは各言語のHTTPサーバーがデュアルスタックでbindしているため同じ問題が起きていない）。

### 特定サービスだけ`docker compose up -d --build <service>`で再作成すると、edge-proxyが古いIPをキャッシュしたままになる（`resolver`ディレクティブで恒久対応済み）

`frontend`だけを再ビルド・再作成した際、`docker compose logs edge-proxy`に`connect() failed (111: Connection refused)`が出続け、ブラウザからは常に502になった。原因はDockerのユーザー定義ネットワーク特有の挙動：コンテナ名はDocker組み込みDNS（`127.0.0.11`）で解決されるが、`proxy_pass http://frontend:3000;`のように宛先を直書きすると、nginxはconfigパース時にstatic upstream扱いにしてワーカープロセス起動時に一度だけ名前解決・キャッシュしてしまう。再作成されたコンテナは新しいIPを持つが、nginx側は古いIPへ接続し続ける。`docker compose exec edge-proxy wget -qO- http://frontend:3000/`は（DNS解決からやり直すため）正常に返る一方、nginx経由のリクエストだけ失敗する、という食い違いが切り分けの決め手になった。

対応：`edge-proxy/nginx.conf`に`resolver 127.0.0.11 valid=10s;`を追加し、全`proxy_pass`の宛先を`set $xxx_upstream <service>; proxy_pass http://$xxx_upstream:<port>;`という変数経由の形に変更した。変数を介すとnginxは宛先をstaticではなくdynamicなupstreamとして扱い、`resolver`の`valid`（TTL）ごとに実際にDNSへ問い合わせ直すため、バックエンドコンテナが個別に再作成されてIPが変わっても、edge-proxy自身を再起動せずに追従する（実機で確認：`frontend`のみ`--force-recreate`した直後もedge-proxy無再起動でHTTP 200を維持）。

### Keycloakだけを再作成すると、JWKSをプロセス起動時に一度だけキャッシュしている他サービスの検証が全滅する（未知kidでの自動再取得で恒久対応済み）

`docker compose up -d --build <他のサービス>`を実行しただけのつもりが、依存関係の都合でKeycloakコンテナも`Recreate`されることがある（`start-dev`は起動のたびに署名鍵を含む状態を再構成するため、コンテナ再作成のたびに鍵が変わりうる）。Go（inventory-service）・Rust（warehouse-service）は元々起動時に一度だけJWKSを取得してプロセス生存期間中キャッシュする実装だったため、Keycloak側の鍵が変わった後もこれらのサービスが再起動していないと、Order Serviceからの下流呼び出しが`token is unverifiable: error while executing keyfunc: unknown kid`で失敗し続けていた。Java（order-service, Spring SecurityのNimbusJwtDecoder）・Python（employee-service, PyJWTの`PyJWKClient`）は元々未知kid時に自動で再取得するキャッシュ機構を内蔵しており、この問題自体が起きない。

対応：Go・Rustそれぞれで「未知のkidに遭遇したら再取得する」ロジックを追加した。

- Go（`inventory-service/auth.go`）：鍵マップを`sync.RWMutex`で保護し、`keyfunc`が未知のkidを見たら（前回取得から`minInterval`＝10秒以上経過していれば）同期的に再フェッチしてリトライする`jwksCache`型に変更
- Rust（`warehouse-service/src/auth.rs`）：`AuthContext::verify`は意図的に同期関数のまま維持し（後述の理由）、未知のkidを見たら`tokio::spawn`でバックグラウンド再フェッチを起動する方式にした。そのリクエスト自体は「unknown kid」のまま失敗するが、次のリクエストからは再取得済みの鍵で成功する（実機で確認：Keycloakのみ`--force-recreate`した直後の1回目は失敗、3秒後の2回目でinventory-service/warehouse-serviceを手動再起動せずに成功）。再取得はrate-limit（10秒間隔）＋重複排除（`AtomicBool`で同時に1つまで）してあり、偽のkidを送りつけるだけでKeycloakへの再フェッチを乱発させられない設計
- Rust特有の罠：`verify`を`async fn`にしてbody内で素直に`.await`する実装を最初に試したところ、`main.rs`の`.layer(middleware::from_fn_with_state(auth_ctx, auth::auth_middleware))`がコンパイルエラーになった（`axum-tracing-opentelemetry`がaxum 0.8を、アプリ自身はaxum 0.7を要求しており、Cargo.lock上は元から両方共存している——エラーメッセージの"there are multiple different versions of crate axum"はこれを指す）。`auth_middleware`自体のシグネチャは変えていないのに、内部の`.await`が1段増えるだけでこの潜在的なバージョン混在がコンパイルエラーとして顕在化した。回避策として`verify`を同期関数のまま保ち、実際の再フェッチだけを`tokio::spawn`のバックグラウンドタスクに逃がすことで、`auth_middleware`のFuture形状を一切変えずに済ませた

### Nitroの`runtimeConfig`は`NUXT_<KEY>`以外の環境変数名を実行時に読まない

`nuxt.config.ts`の`runtimeConfig`に書いたデフォルト値は**ビルド時**に評価される。`docker compose`の`environment:`で渡した素の環境変数名（例: `KEYCLOAK_INTERNAL_URL`）はNitro起動時には反映されず、ビルド時のフォールバック値がそのまま使われてしまう。Nitroが実行時に上書きを認識するのは`NUXT_`プレフィックス＋大文字スネークケース（例: `NUXT_KEYCLOAK_INTERNAL_URL`）の環境変数のみ。`compose.yml`側の環境変数名を全て`NUXT_`プレフィックス付きに修正して解決した。

## OpenTelemetry

### frontendが実は一切トレースを出していなかった：Node の `--import` だけではESMは計装されない

サービスグラフを見ると、Keycloakの内部DBスパン以外ほぼ全てのノードが素性不明の「user」に直結して見える、という指摘から発覚。原因はfrontend（Nuxt/Nitro）が**受信リクエストのスパンを一切生成していなかった**ことで、edge-proxyから渡された`traceparent`を引き継げず、frontendから先の全呼び出しがそれぞれ新規のルートトレースとして始まっていた。

- `@opentelemetry/instrumentation-http`等のNode計装は`import-in-the-middle`（`require-in-the-middle`のESM版）でモジュールロードをフックする。Nitroのビルド成果物（`.output/server/index.mjs`）は純粋なESMで、Node起動時の`--import ./server/otel.mjs`フラグは**CommonJSの`require()`しかフックできない**。ネイティブの`import`文には一切効かず、`http.createServer.__wrapped`が`undefined`のまま＝計装ゼロという状態になっていた
- `@opentelemetry/instrumentation`パッケージ自身のREADMEに答えがある：「ESM計装用の専用フックは`--experimental-loader=@opentelemetry/instrumentation/hook.mjs`」。ただしこのCLIフラグはNode側で非推奨警告が出るため、`node:module`の`register()`（Node 20.6+/18.19+の非推奨ではない代替API）を`server/otel.mjs`の一番最初で呼ぶ形で実装した
- 実機検証：修正前は`/api/me`への実リクエストを送って70秒待ってもTempoに一切現れなかった（healthcheck由来のノイズではなく、本当にゼロ）。修正後、edge-proxy→frontendのスパンが正しく親子連結されることを確認した

### edge-proxyは意図的に計装しない：nginxの otel モジュールは受信側のスパンしか作れない

当初edge-proxy（nginx、`nginx:*-alpine-otel`イメージ + `ngx_otel_module`）にも計装を入れたが、最終的に撤去した（採否の理由はarchitecture.md §16）。

- `ngx_otel_module`が提供するディレクティブは`otel_exporter`・`otel_service_name`・`otel_trace`・`otel_trace_context`等のみで、`proxy_pass`で下流に転送する側に対応する`CLIENT`スパンを生成する機能が存在しない。生成されるのは常に受信リクエストの`SPAN_KIND_SERVER`スパン1本のみ
- Tempoのservice graph生成処理（`metrics_generator`の`service-graphs`プロセッサ、Grafanaの「Service Graph」パネルの実データ源）は、CLIENT側スパンとSERVER側スパンのペア（spanIdとparentSpanIdの一致）を根拠にエッジを描画する。生トレース（waterfall表示）ではparentSpanIdによる親子関係がそのまま可視化されるため正しく繋がって見えるが、この2つは別のパイプラインであり、edge-proxy側にCLIENTスパンが無い以上Service Graphは「呼び出し元不明」として下流（Keycloak・frontend）を`user`直結として描画する。Tempo公式ドキュメントにも明記されている既知の仕様（"Uninstrumented client (missing client span)"）であり、バグではない
- `otel_trace_context propagate`（受信traceparentの継承＋下流への注入）自体は正しく機能しており、これを外すと今度は**trace_id自体が下流で分断される**（実機で確認済み：Keycloak側が全く別のtraceIDでルートトレースを開始してしまう）。「service graphのエッジが直らない」問題と「trace_idが分断される」問題は別物なので混同しないこと

### Rust: `reqwest-tracing`クレートは本リポジトリの依存バージョンと両立しない

Warehouse Serviceの発信HTTP呼び出し（Keycloakへのtoken exchange、employee-serviceへの照会）とRedis呼び出しにCLIENTスパンが無く、Service Graph上でエッジが欠落していた問題への対応中に判明。

- `reqwest-tracing`は`opentelemetry`のバージョンごとにフィーチャーフラグでpackageを切り替える方式だが、**このリポジトリが使う`opentelemetry 0.32`系に対応するバージョン（0.7.x）は`reqwest 0.13`を要求する**。本リポジトリは`opentelemetry-otlp`のreqwestクライアント機能がreqwest 0.13必須（rustls統合がaws-lc-rs必須＝cmakeが要る）であることを理由に、`hyper-client`機能へ切り替えてreqwestを0.12に留めた経緯がある（下記「Goの`otlptracehttp`」節の直前を参照）。一方、reqwest 0.12と両立する`reqwest-tracing`（0.5.x系）は`opentelemetry 0.26`までしか対応しておらず、`axum-tracing-opentelemetry 0.39`（本リポジトリの受信側計装）が`opentelemetry 0.32`/`tracing-opentelemetry 0.33`を厳密に要求するため、どちらを立てても他方が壊れる板挟みになる
- 対応：`reqwest-tracing`crateは使わず、`tracing::info_span!`で`"otel.kind" = "client"`フィールド（`tracing-opentelemetry`が特別扱いする予約フィールド名）を持つスパンを手動生成し、`.instrument()`で発信呼び出しを包む形にした。ヘッダへの`traceparent`注入はもともと`opentelemetry_http::HeaderInjector` + `global::get_text_map_propagator`で自前実装済みだったので、スパンで包むだけで済んだ
- Redis呼び出しも同様に対応（`redis`クレートにはこの種の計装ライブラリが存在しない）。`db.system`/`db.name`の semantic conventions属性を付けたスパンで手動計装
- **副産物として見つかった実バグ**：`token_exchange.rs`のKeycloakへの呼び出しは、CLIENTスパンが無いだけでなく`traceparent`ヘッダの注入自体を一切行っていなかった（employee-serviceへの呼び出しは注入していたのに、Keycloakへの呼び出しは漏れていた）。Service Graphのエッジ欠落を追っている過程で発見し、あわせて修正した
- Rustのトレーシングエコシステムがreqwest/opentelemetryのバージョン整合で詰まりやすい点は、他言語（Go/Java/Python）の「ライブラリ追加だけで済む」自動計装との対比として実演価値がある罠

### ヘルスチェックをトレースから除外する（サービスごとに手段が異なる）

docker composeの各ヘルスチェック（5秒間隔）がそのままスパン化されるとTempoのservice graphが常時ノイズだらけになる。

| サービス | 除外手段 |
|---|---|
| Go (inventory-service) | `otelhttp.WithFilter` |
| Rust (warehouse-service) | axum-tracing-opentelemetryの層を通す**前**に`/health`ルートを追加。層は追加済みルートしかラップしないという仕様通りの挙動 |
| Python (employee-service) | `OTEL_PYTHON_FASTAPI_EXCLUDED_URLS`環境変数。ゼロコード計装のため他に手段が無い |
| Java (order-service) | `ObservationPredicate` Bean |
| Nuxt (frontend) | `HttpInstrumentation`の`ignoreIncomingRequestHook`。`/api/me`は実際のセッション確認にも使われる二重目的のエンドポイントのため、パスではなくヘルスチェック側が送る`X-Health-Check`ヘッダで判別 |
| Keycloak | `--health-enabled`でmanagementポート`9000`の`/health/ready`に切り替え。Quarkusの`quarkus.otel.traces.suppress-non-application-uris`が既定で有効なため計装から自動除外される |
| edge-proxy | 計装自体をしていないため対象外。ヘルスチェック先もKeycloakの`/health/ready`へ切り替え済み（ビジネス用エンドポイントの間借りをやめた） |

### DBノードの表示名はDBの実名ではなく、compose上のサービス名に統一

当初はPostgreSQL/MySQL/MongoDBの実際のDB名（`order_service`/`inventory_service`/`employee_service`）をそのまま使っていたが、ハイフンの`order-service`とアンダースコアの`order_service`のようにアプリ自身のサービスノードと紛らわしく、Service Graph上で見分けにくかった。

- Inventory Service（Go/otelsql）はレポート用の属性値を自由に選べるため、実DB名は変えずに`semconv.DBNamespace("inventory-mysql")`と表示ラベルだけ変更した
- Order Service（Java/datasource-micrometer）とEmployee Service（Python/pymongo自動計装）は、実際に接続しているDB名をそのままspan属性として報告する仕様のため、PostgreSQLの実DB名（`POSTGRES_DB`及びJDBC URL）とMongoDBの実DB名（`main.py`のMongoClient呼び出し・`init-mongo.js`）自体をcomposeサービス名（`order-postgres`/`employee-mongo`）に合わせて変更した（認証情報のユーザー名/パスワードは変更対象外）
- KeycloakのH2 DBだけはQuarkus内部のパス文字列で制御できないため対象外（元々曖昧さが無いので実害なし）
- 実DB名を変更する場合、Postgres/MongoDBともコンテナの匿名ボリュームにデータが残っていると`POSTGRES_DB`変更が反映されない（`docker-entrypoint-initdb.d`は空のデータディレクトリでしか走らない）。`docker compose down -v`での完全なやり直しが必要だった

### Goの`otlptracehttp.WithEndpointURL`は`/v1/traces`を自動付与しない

`WithEndpoint`（ホスト:ポートのみ渡す版）は補完するが、`WithEndpointURL`はURLをそのまま使うため、ベースURLを渡すと`http://otel-lgtm:4318/`宛に送られ404になる。パスは呼び出し側で明示的に付与する必要がある。

### Rust: `opentelemetry-otlp`のreqwestクライアント機能はreqwest 0.13を要求する

0.13のrustls統合はaws-lc-rs必須（cmakeが要る）。本リポジトリはmusl/alpineビルドでcmakeを避けたい（reqwestのTLSバックエンドを以前OpenSSL不在の理由でrustls-tlsへ切替済み、後述）。`opentelemetry-otlp`の`hyper-client`機能（`opentelemetry-http`のhyperベースクライアント、reqwest非依存）を使うことで、アプリ自身のreqwestは0.12+rustls-tls（ring、cmake不要）のまま維持できる。この「reqwestを0.12に留める」制約が、上記の`reqwest-tracing`crateを使えない直接の原因になっている。

### Rust: `axum-tracing-opentelemetry`はデフォルトでTRACEレベルのスパンを生成する

targetは`otel::tracing`。Dockerfileの`RUST_LOG=info`と噛み合わず全リクエストのスパンが実際には作られず`SpanDisabled`警告が出続ける。`axum-tracing-opentelemetry`の`tracing_level_info`フィーチャーでINFOレベルに変更して解決。

### Rust: hyperベースのOTLPエクスポーターは非同期ランタイム上で動く必要がある

`SdkTracerProvider::builder().with_batch_exporter(...)`のデフォルトはTokioに紐付かない別OSスレッドでエクスポートするため`no reactor running`でパニックする。`opentelemetry_sdk`の`rt-tokio` + `experimental_trace_batch_span_processor_with_async_runtime`フィーチャーで`span_processor_with_async_runtime::BatchSpanProcessor::builder(exporter, runtime::Tokio)`を使うことで解決。

### `grafana/otel-lgtm`イメージには`wget`が無く`curl`のみ

他サービスのヘルスチェックをコピーした`wget`ベースの定義をそのまま使うと常に失敗する。

## Rust実装全般（warehouse-service）

- `reqwest`のデフォルトTLS(OpenSSL)はビルド環境にpkg-config/OpenSSLが必要で失敗したため`rustls-tls`に切替
- Dockerfileでの「ダミーmain.rsで依存だけ先にビルド」は、BuildKitのcache mountと組み合わさるとcargoが実ソースの変更を検知せず古いバイナリを使い続けるという実害のある罠だった（cache mountはビルド間で永続化するのでこのトリック自体が不要）
- axum 0.7のパスパラメータ記法は`{param}`ではなく`:param`（`{}`はaxum 0.8以降の記法で、0.7では静かに404になる——パニックしないため気づきにくい）

## ログ収集・構造化（Alloy + Loki）

### Spring Securityのフィルタチェーンで拒否された401はHandlerInterceptorに届かない（既知の限界）

`AccessLogInterceptor`はSpring MVCの`HandlerInterceptor`として実装した。これは`DispatcherServlet`の内側で呼ばれるため、`BearerTokenAuthenticationFilter`（Spring Securityのフィルタチェーン、DispatcherServletより前段）がトークン欠如・無効を理由に401を返すケースでは`afterCompletion`自体が呼ばれず、アクセスログに記録されない。

- 検討した代替案：`OncePerRequestFilter`でチェーン全体をtry/finallyで包む方式。しかしSpring Securityの`SecurityContextHolderFilter`はチェーン完了後の**自分自身のfinallyブロックでSecurityContextをクリアする**ため、それより外側に置いた自作フィルタのfinallyブロックが実行される時点では既にコンテキストが失われている可能性がある。`HandlerInterceptor`はDispatcherServletの内側（Spring Securityのフィルタ実行が完了した後）で動くため、`afterCompletion`時点でも`SecurityContextHolder`が読める
- 結果として、order-serviceの401（未認証）はアプリ側アクセスログでは追えず、**Keycloak側のイベントログ（`LOGIN_ERROR`等）でのみ捕捉される**。監査用途でこの2つのログソースを併用する設計はこのギャップを前提にしている。`@PreAuthorize`起因の403（メソッドレベル認可、DispatcherServlet内側で評価）はHandlerInterceptorが捕捉できるため、この限界は「認証切れ／トークン無効」の401にのみ当てはまる

### サンプリング率を下げた状態での動作は未検証

「トレースはサンプリングされるため監査の裏付けには使えない、ログを裏付けにする」という設計判断は、trace_idがサンプリング判定（sampled=true/false）に関わらずログへ伝播することを前提にしている。Keycloakのイベントログで`sampled=true`のケースは確認したが、**実際にサンプリング率を1.0未満に下げて`sampled=false`のリクエストでもtrace_idがKeycloak/各サービスのログに残ることは検証していない**。order-serviceは`management.tracing.sampling.probability: 1.0`を明示しているが、Go/Rust/Node/PythonはOTel SDKのデフォルト（実質常時サンプリング）のままで、他の値を試したことがない。この前提の実証はバックログ「監査突合のデモ手順の確立」に含めるべき検証項目。

### KeycloakのイベントログにはデフォルトでtraceIdが付与される

Keycloakはjboss-loggingイベントリスナーをデフォルト有効にしており、`KC_TRACING_ENABLED=true`の環境下では`org.keycloak.events`ロガーが出力する各イベントログ行に`traceId=…`フィールドが自動付与される（出力例：`type="LOGIN_ERROR", realmName=…, traceId=50c1168a…`）。つまり、各サービスのToken Exchangeリクエストに`traceparent`ヘッダが付与されていれば、**KeycloakのイベントログとOTelトレースをtrace_idで機械的に突合できる**。バックログに「より進んだアプローチ」として記載していた内容が、追加実装なしに既に実現していた。

### tracing-subscriberのJSONフォーマットはフィールドを"fields"の下にネストする

Rustの`tracing_subscriber::fmt::layer().json()`は構造化フィールドを以下のようにネストする：

```json
{"timestamp":"…","level":"INFO","fields":{"message":"","type":"access_log","method":"GET",…}}
```

これはLokiの`| json | type = "access_log"`（トップレベルフィールドのフィルタ）で引っかからないため、他サービス（フラットJSONを出力するJava/Go/Node）との横断LogQLクエリが壊れる。アクセスログのように「他サービスと突合する目的」のJSON行は、`tracing::info!`を経由せず`serde_json::json!(…)`を直接`println!`で出力してフラットな構造を維持すること。

### GoのaccessLogMiddlewareはotelhttp.NewHandlerの内側に置く

`otelhttp.NewHandler`は受信リクエストの`traceparent`を抽出してスパンを開始し、**新しいcontextを持つ`*http.Request`**（`r.WithContext(newCtx)`）を内側のハンドラに渡す。外側でラップする実装（`accessLogMiddleware(otelhttp.NewHandler(mux, …))`）だと、`r.Context()`にはまだスパンが入っておらず`trace.SpanFromContext(r.Context())`が無効スパンを返す。

正しい順序は`otelhttp.NewHandler(accessLogMiddleware(mux), …)`。この形にすることでaccessLogMiddlewareが受け取る`r`はotelhttp製の新しいcontextを持ち、`trace.SpanFromContext(r.Context())`で有効なtrace_idが取れる。

### Spring BootのLogstash形式はtraceIdをcamelCaseで出力する

micrometer-tracing-bridge-otelはMDCに`traceId`（camelCase）という名前でtrace IDを保存し、Spring BootのLogstash構造化ログ形式はMDCキーをそのままJSON上のフィールド名として使う。他サービス（Go/Rust/Node）はすべて`trace_id`（snake_case）を使っているため、`addKeyValue("trace_id", MDC.get("traceId"))`を明示的に追加して命名を揃えること。

### AxumのアクセスログミドルウェアはJWT検証ミドルウェアの内側（後）に置く

`axum::Router`の`.layer()`は**最後に呼ばれたものが最外層**（リクエストを最初に処理）になる。アクセスログが`Extensions`に格納された`Claims`（`sub`）を読むには、JWT検証ミドルウェアより内側（後）に配置する必要がある：

```rust
.layer(middleware::from_fn(access_log_middleware))          // 内側：auth後にClaimsが読める
.layer(middleware::from_fn_with_state(ctx, auth_middleware)) // 外側：最後のlayer = 最外層
```

### Rust: `opentelemetry::Context::span()`の戻り値を1行で`.span_context()`すると一時値ドロップでコンパイルエラー

```rust
let span_ctx = ctx.span().span_context();  // error[E0716]: temporary value dropped while borrowed
```

`ctx.span()`は所有権を持つ値（内部的には`Box<dyn Span>`相当）を返すため、その場で`.span_context()`を呼ぶと戻り値の参照より先に一時値が破棄される。変数に束縛して寿命を延ばす必要がある：

```rust
let span = ctx.span();
let span_ctx = span.span_context();
```

### Rust: `tracing-subscriber`の`.json()`は`Cargo.toml`で`json`フィーチャーを明示しないと存在しない

`tracing_subscriber = { version = "0.3", features = ["env-filter"] }`のままだと`tracing_subscriber::fmt::layer().json()`が「そのようなメソッドは無い」でコンパイルエラーになる。`features = ["env-filter", "json"]`が必要。

### Node: OTelの`trace.getActiveSpan()`はイベントコールバックの境界を越えると失われうる

`http.IncomingMessage`の`res.on('finish', …)`コールバック内で`trace.getActiveSpan()`を呼んでも、その時点でOTelのcontext（AsyncLocalStorage経由）が元のリクエスト処理と同じスコープにあるとは限らない。ミドルウェア本体（同期実行中、OTelのcontextがまだ有効な区間）でtrace_idを取得し、クロージャで`finish`コールバックに持ち込む必要がある：

```typescript
const traceId = trace.getActiveSpan()?.spanContext().traceId ?? "-"; // 同期区間で取得
event.node.res.on("finish", () => { /* traceIdはクロージャ経由で使う、ここで取得し直さない */ });
```

## Go実装（inventory-service）

JWT検証は`golang-jwt/jwt/v5` + JWKSを手動パースで自前実装した（`keyfunc/v3`はGo 1.25+要求で依存が重いため不採用）。

## 監査ログ・トークン監査（audit/）

トークン発行と利用の突合監査（`audit/audit.py`、`audit/scenario.py`）を実装する過程で、実機検証なしには気づけなかった罠が複数見つかった。いずれも「コードは正しく見えるが実際には動かない/前提が崩れている」パターン。

### Keycloakの`eventsEnabled`はデフォルト`false`：LOGIN/TOKEN_EXCHANGEの成功イベントは最初から一切記録されない

`backlog.md`には以前から「Keycloakのイベントログには`traceId`が自動付与され突合できる」という記載があったが、これは未検証の思い込みだった。実際に`GET /admin/realms/{realm}/events/config`で確認すると`eventsEnabled: false`で、`eventsListeners: ["jboss-logging"]`は登録されているものの無効化されていた。この状態では成功系イベント（LOGIN, TOKEN_EXCHANGE等）は`eventsListeners`へ一切ディスパッチされない。

紛らわしいのは、DPoP proof欠落等の認証エラー（`LOGIN_ERROR`）は`eventsEnabled`に関係なく別経路でWARNログに出ていたため、「イベントログ自体は機能している」という誤った確信を持ちやすかった点（実際に本セッションもこれで一度誤判定した）。

対応：`keycloak/realm-export.json`のトップレベルに`"eventsEnabled": true, "eventsListeners": ["jboss-logging"]`を追加。**この変更はDockerfileの`COPY realm-export.json ...`でイメージに焼き込まれるため、`docker compose build keycloak`でイメージを再ビルドしないと反映されない**（`docker compose up -d keycloak`だけではコンテナは再作成されるが古いイメージのまま）。

### jboss-logging event listenerの成功イベントはデフォルトでDEBUGレベル：`eventsEnabled: true`だけでは足りない

`eventsEnabled`を有効化してもなお、LOGIN/TOKEN_EXCHANGEの成功イベントがログに出ない状態が続いた。原因は`JBossLoggingEventListenerProvider`の成功イベントのデフォルトログレベルがDEBUGであること（エラーイベントはWARNがデフォルトで、これは最初から見えていた）。ルートのログレベルがINFOのため、DEBUG出力は素通りしていた。

対応：`compose.yml`のkeycloakサービスに`KC_SPI_EVENTS_LISTENER_JBOSS_LOGGING_SUCCESS_LEVEL: "info"`を追加（他のKC_*ランタイム設定と同じ扱い）。実機で確認：追加前は`docker logs`に成功イベントが1行も出ず、追加後は`type="LOGIN"`/`type="TOKEN_EXCHANGE"`が確認できた。

### Python: `logging.getLogger(name).info(...)`はハンドラ未設定だと無音で何も出力しない

employee-serviceのアクセスログ実装で`logging.getLogger("access")`にハンドラ・レベルを一切設定せず`.info()`を呼んでいたところ、実機で`docker exec`から直接検証するまで気づかなかったが、**何も出力されない**（例外も出ない）。ルートロガーのデフォルトレベルはWARNINGで、ハンドラも無い状態だと`.info()`呼び出しは完全に無音になる。uvicornは自分の`uvicorn`/`uvicorn.access`ロガーは設定するが、アプリが独自に作った名前のロガーまでは設定しない。

対応：他サービス（Go/Rust/TypeScript）と同じく`print(..., flush=True)`で標準出力に直接書く方式に統一した。Dockerがstdoutをパイプとして扱うため`flush=True`が無いとブロックバッファリングで出力が遅延する点にも注意。

### 認可ミドルウェアは「クレーム抽出・記録」を「許可/拒否判定」より前に置く：エラーハンドリングの分岐が監査証跡を消しうる

Go実装（inventory-service）の`authMiddleware`で、`hasAnyRole`チェックが403を返す`return`分岐が`r.Header.Set("X-Subject", ...)` / `r.Header.Set("X-Jti", ...)`より**前**にあった。トークン自体は正当にToken Exchangeされたものでも、ロール不足で拒否される経路を通ると、アクセスログに`sub="-"`/`jti="-"`が記録される（＝「誰が」「どのトークンで」拒否されたかの証跡が消える）。Java/Rust/Pythonの3サービスは実装の都合で偶然この順序になっていなかっただけで、意図して設計されていたわけではない。

一般化すると：**認可判定（許可/拒否のロジック）で早期returnするコードパスを書くときは、「誰が・どのトークンで」を記録する処理が、その早期returnより先に実行されているかを必ず確認する。** 「許可された場合だけ記録すればよい」という発想でクレーム抽出とログ記録を許可判定の後ろに置くと、拒否された（＝監査上最も見たいはずの）リクエストの証跡が丸ごと欠落する。これは認可ロジックを持つ全サービス・全エンドポイントで再発しうるクラスの罠であり、今回はGoの1箇所だけ実害があったが、他言語・他サービスへの機能追加時にも同じ順序を意識する必要がある。

対応：ヘッダー設定（クレーム記録）をロールチェックより前に移動。実機で確認：修正前は403時に`sub`/`jti`とも`"-"`、修正後は正しい値が記録される。

### `docker compose down`はサービス名を指定しても全体を止める：ワンショットコンテナの掃除には`docker rm`を使う

`audit`/`scenario`のような`docker compose run --rm`のワンショットコンテナはオーファンを残さない（`--rm`で自動削除される）はずだが、途中終了などで残った場合に`docker compose --profile audit down --remove-orphans`を実行すると、**プロファイル配下だけでなくスタック全体（keycloak, otel-lgtm等含む）が停止・削除される**。個別コンテナの掃除には`docker ps -aq --filter "name=..."  | xargs -r docker rm -f`のような対象を絞った削除を使うべき（`Makefile`の`audit-clean`ターゲットもこの方式）。

### 監査ツールの「証跡を省く」表示ロジックは、まさに異常検知時にその証跡自体を隠しうる

`audit.py`のCHECK2で、trace_idごとの対応状況を`show_evidence(..., max_rows=30)`で表示していたが、これは時系列順に先頭30行を表示するだけの実装だった。件数が多い状況で実際に不整合（`✗`）が発生すると、その`✗`行が30行の外側（省略対象）に落ちてしまい、**「異常あり」という判定は出るのに、その根拠行が画面に出ない**という状態になっていた。実機で「該当データが31件以上ある状態でCHECK2が✗になる」ケースを作って初めて発覚した（静的レビューでは`max_rows=30`という値の妥当性まで疑わなかった）。

対応：`✗`（未対応）の行は件数に関わらず必ず全件表示し、省略の対象は`✓`（対応確認済み）側のみに限定した。一般化すると、**監査・異常検知系の出力で「表示件数を制限する」実装をする場合、正常系と異常系を区別せず先頭N件で切ると、まさに見せたい異常系の証跡が省略される事故が起きる**。表示制限は常に「正常系のみ」に適用し、異常系は無条件に全件出すべき。

**さらに設計を見直した**：そもそも生ログの全件（または一部）をレポート本文に埋め込む発想自体が誤りだった。クエリの実行内容・取得件数は`docker compose run`の標準出力（実行ログ）に流れるので十分に追跡可能であり、レポートの「判定」部分に生ログの一覧を埋め込む必要はない。埋め込んでも上記のように省略されて結局使い物にならない。最終的に、レポートは各CHECKについて「判定サマリ（件数）」＋「違反時のみ、識別子（trace_id/jti/sub）と最小限の文脈」に絞り、実行ログ（クエリ・件数）とレポート（判定結果）を明確に分離した。監査ツールの出力は「何を確認したか（実行ログ）」と「結果どうだったか（レポート）」を混ぜないほうが、どちらも本来の役目を果たせる。

### KeycloakのTOKEN_EXCHANGEイベントログには発行トークンのjti・audience・userIdがそのまま記録される

`audit.py`のCHECK2を`trace_id`相関から`(jti, audience)`相関へ作り直す過程で確認した（設計変更の経緯は[ADR 0012](adr/0012-jti-audience-correlation-for-token-exchange-audit.md)参照）。KeycloakのTOKEN_EXCHANGEイベントには`token_id`（発行したトークンのjti）・`audience`（要求されたaudience）・`userId`（対象ユーザーのsub）フィールドがそのまま出力されている。

```
type="TOKEN_EXCHANGE", ..., audience="inventory-service", ...,
token_id="ntrtte:6ff32546-3349-41c9-2977-ff73fcf879ca", ..., userId="c98454aa-..."
```

この`token_id`の値は、当該トークンを受け取ったdownstreamサービスのアクセスログに記録される`jti`と（プレフィックス`ntrtte:`/`onrtte:`等を含めて）完全に一致することを実データで確認済み。このプレフィックスはKeycloakのToken Exchange V2が内部的に付与するもの（要求元クライアントごとに異なる値になる）で、ロジック側がこの形式に依存する必要はない——単なる文字列としてtrace_idと同様に扱えばよい。

副産物として、`grant_type=client_credentials`でトークンを取得した場合はKeycloakが`type="CLIENT_LOGIN"`イベントを出すことも確認した（`type="TOKEN_EXCHANGE"`ではない）。あるクライアントが自分の資格情報で、本来Token Exchange専用のoptional client scope（[ADR 0007](adr/0007-topology-control-via-optional-client-scopes.md)）を直接要求してaudience付きトークンを取得することは、トポロジー制御そのものでは防げない（scopeの付与は「audienceを持ちうるか」の制御であって「その入手経路がToken Exchangeか」までは見ていない）——これは実際にCHECK2が検知すべき対象として`docs/audit-demo.md`のデモシナリオに組み込んだ。

### Lokiだけを再作成してもAlloyを再起動すると過去ログが再流入し、監査ウィンドウの「クリーンな捕捉」が壊れる

`docs/audit-demo.md`の実行例を「バイパス1件だけを含む状態」でクリーンに再現しようとして、Lokiのデータだけを消す（`otel-lgtm`コンテナを`stop`→`rm`→`up`で作り直す）方法を最初に試した。Loki自体は空になったが、そのままだと`alloy`コンテナ側が古いLokiインスタンス相手の内部状態を引きずっている可能性を疑い、念のため`alloy`も`restart`したところ、**それまでの1時間分のテストトラフィック（LOGIN・TOKEN_EXCHANGE・過去のバイパス試行など）がまるごと新しいLokiへ再送された**。結果、直前に1回だけ実行したはずのシナリオに対して監査を回すと、無関係な古い違反が複数混入したレポートになった。

- `loki.source.docker`はDockerの各コンテナログをコンテナ起動時点から追跡する。Alloy自身は自分がどこまで送信済みかの位置情報を（本リポジトリの構成では）永続化していないため、再起動すると「そのコンテナがこれまでに出力した全ログ」を最初から読み直して送り直す。Docker側のログ自体（`json-file`ドライバ）はコンテナが生きている限り蓄積され続けるため、キャッシュクリアには使えない
- Lokiに刻まれるタイムスタンプはAlloyへの到達時刻ではなく、元のログ行が持つ時刻がそのまま使われる（Docker jsonログのタイムスタンプに由来）。そのため再送された古いログも、監査ウィンドウ（直近1時間）の範囲内であれば普通に対象に入ってきてしまう——「最近再送されたから新しく見える」という判別方法は使えない
- 恒久対応（クリーンな監査キャプチャが必要な場合）：Lokiだけでなく**スタック全体を`docker compose down`→`up -d`で作り直す**。コンテナ自体が新しくなればDockerのログファイルも空から始まるため、Alloyが再起動しても再送するものが無い

一般化すると、**可観測性バックエンド（Loki等）だけをリセットしても、ログ収集エージェント（Alloy等）側に「送信済み位置」の状態が残っていれば、意図しない過去データの再流入が起きうる**。監査ツールの実行結果を「クリーンな1回分」として記録・比較したい場合は、バックエンドだけでなく収集エージェントの状態、あるいはログの発生源（コンテナ）自体をリセット対象に含める必要がある。
