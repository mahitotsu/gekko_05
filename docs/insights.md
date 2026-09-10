# 実装で得た気づき・罠

実装を進める過程で見つかった、再発しそうな罠や実機検証で判明した仕様上の落とし穴を記録する。設計判断そのものは[architecture.md](architecture.md)、未着手の改善項目は[backlog.md](backlog.md)を参照。

## Keycloak / realm設計

### 縮小版realmで`clientScopes`を明示指定すると組み込みscopeがマージされない

realm importでは（単純な`POST /admin/realms`でのrealm作成と異なり）`clientScopes`を明示指定すると、Keycloak組み込みの`roles`/`profile`等は一切マージされない。これにより以下も自分で明示する必要があった。

- `sub`クレーム：組み込みでは自動的に付与されず、`oidc-sub-mapper`を`roles`スコープに追加する必要がある（実機で確認：追加前はaccess_tokenに`sub`が一切含まれずToken Exchange時の記録が取れなかった）
- 所属支店のような社員情報：`roles`スコープに`oidc-usermodel-property-mapper`を追加しないと`preferred_username`以外のクレームが載らない

### `KC_HOSTNAME`の固定が必要

内部（docker network経由、例: `http://keycloak:8080`）と外部（ホストマシン経由、例: `http://localhost:8080`）でKeycloakへの到達ホスト名が異なると、Keycloakは自分自身のissuerをリクエストごとに動的算出するため、外部で発行されたトークンをサービスが内部経路でToken Exchangeしようとすると`invalid_request: Invalid token`で拒否される。`KC_HOSTNAME`を固定することで解決した（実機で確認）。

### `--tracing-enabled`/`--health-enabled`はビルド時に焼き込んでも無意味

Keycloak公式ドキュメントは両オプションを「ビルド時オプション」と説明しており、当初`keycloak/Dockerfile`に`RUN kc.sh build --tracing-enabled=true --health-enabled=true`を追加したが、`--health-enabled`の効果が実機で全く確認できなかった（`/health`は404、managementポート`9000`もリッスンしない）。

- 実機検証で判明：`start-dev`（Keycloakのdevモード起動コマンド）は**コンテナ起動のたびに暗黙の再ビルド（augmentation）を行い**、その際に使われるビルドオプションはDockerfileで焼き込んだ値ではなく、その時点のCLI引数/環境変数から再計算される。つまりdevモードで動かす限り、Dockerfileでのビルド時焼き込みには何の意味もない
- 対応：`RUN kc.sh build ...`のステップを削除し、`KC_TRACING_ENABLED`/`KC_HEALTH_ENABLED`をcompose.ymlのランタイム環境変数として渡すだけにした（他サービスの`OTEL_SERVICE_NAME`と同じ扱いに統一）。プレーンな`quay.io/keycloak/keycloak:26.4`イメージ＋これらの環境変数だけで機能することを`docker run`単体でも確認済み

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

## Go実装（inventory-service）

JWT検証は`golang-jwt/jwt/v5` + JWKSを手動パースで自前実装した（`keyfunc/v3`はGo 1.25+要求で依存が重いため不採用）。
