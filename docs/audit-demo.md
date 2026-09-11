# 監査デモ：トークン発行・利用記録とアクセスログの突合

`audit/`（`audit.py`・`scenario.py`）は、Lokiに集まった各サービスのアクセスログとKeycloakのイベントログを突合し、「Token Exchangeが本当に経路通りに使われているか」を機械的に検証するツール。`docs/backlog.md`の「監査突合のデモ手順の確立」を実装したもの。設計判断の背景は[insights.md](insights.md)「監査ログ・トークン監査（audit/）」節、突合キーの設計変更の経緯は[ADR 0012](adr/0012-jti-audience-correlation-for-token-exchange-audit.md)を参照。

## 実行方法

```
make audit-scenario   # 3ユーザーでログイン+API呼び出し + バイパスデモ1件を実行
make audit-report     # 直近1時間のログを突合してレポート出力
make audit-demo        # 上記2つ + 後片付けを一括実行
```

`audit-report`は不整合を検知すると`exit 1`で終了する（CI等でgateできるようにする意図的な設計）。

## 3つのチェック

各チェックは「個々のリクエストの流れを追跡・再現する」のではなく、識別子（jti/sub）単位の集合として各ソースが独立に主張する事実を集め、突き合わせて矛盾がないかだけを見る。これによりトークンのキャッシュ再利用や並列処理といった実装上の変動に依存しない、決定論的な判定になる。

| CHECK | 検証内容 | 突合キー |
|---|---|---|
| 1 | user-facing層（frontend/order-service）とdownstream層（inventory/warehouse/employee-service）のjtiが重複していないか（隣接ホップ間でのトークン使い回し検出） | `jti` |
| 2 | Token Exchangeで受け取ったトークンを保持する全サービス（order/inventory/warehouse/employee-service）で使われた`(jti, audience)`の組が、KeycloakのTOKEN_EXCHANGE発行記録に存在するか。副次的に、発行記録の`userId`とアクセスログの`sub`が一致するかも確認する | `(jti, audience)` + `sub` |
| 3 | アクセスログに現れたsubについて、それより前にKeycloakのLOGINイベントが存在するか（先行しない場合のみ真の違反。ウィンドウ内にLOGIN記録が無いだけの場合は参考情報） | `sub` |

CHECK2は当初`trace_id`（同一リクエストの経路）で突合していたが、リクエスト単位の相関はトークンキャッシュや計装の途切れに弱いため、`(jti, audience)`という「発行された事実そのもの」による突合に変更した。経緯は[ADR 0012](adr/0012-jti-audience-correlation-for-token-exchange-audit.md)。

## デモシナリオの内容

`scenario.py`は3ユーザーの正規シナリオ（受注作成・在庫確認・社員情報照会、いずれもfrontend→BFF→Token Exchange経由の正規経路）に加えて、**Token Exchangeを経ないバイパスアクセスを1件、意図的に生成する**（`run_bypass_attempt`）。

- order-service自身のクライアント資格情報（`client_id`/`client_secret`）で、Keycloakの`client_credentials`グラントを直接呼び出し、Token Exchange専用に割り当てられているはずのoptional client scope`inventory`（[ADR 0007](adr/0007-topology-control-via-optional-client-scopes.md)のトポロジー制御対象）を要求する
- トポロジー制御（optional client scopeの割当）はこれを拒否しない——「このクライアントがinventory-service宛のトークンを持ちうるか」を制御しているだけで、「その入手経路がToken Exchangeか」までは見ていないため
- 結果、audience=inventory-serviceの正当な署名付きトークンがToken Exchangeを一切経由せずに手に入り、inventory-serviceの署名・issuer・audience検証は普通に通過する（ロール不足で最終的に403にはなるが、認証自体は成功しアクセスログにsub/jtiが記録される）
- Keycloak側にはこの発行に対応するTOKEN_EXCHANGEイベントが存在しない（`type="CLIENT_LOGIN"`として記録される）

## 実際に検知した例

以下は、Lokiのデータを空の状態（`docker compose down`後の再起動）から`make audit-scenario`→`make audit-report`を1回ずつ実行した際の全出力（`docker compose --profile audit run --rm audit`）。手順に書いた通り「正規シナリオ3件＋バイパスアクセス1件」しか流していないウィンドウでの結果であり、CHECK2が検知した不整合もちょうど1件になる。

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Token Exchange 監査レポート
  Loki : http://otel-lgtm:3100
  期間 : 2026-09-11 02:02:23 UTC ～ 2026-09-11 03:02:23 UTC (60 分間)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CHECK: Token Exchange バイパス検出（隣接ホップ間のjti使い回し）
  user-facing層とdownstream層のjtiが重複していないことを確認する（重複 = 同一トークンがExchangeを経ずに複数ホップで使い回されている。1回のExchangeが要求スコープ次第で複数audienceを持つトークンを生成しうるケースの防御であり、CHECK2の(jti,audience)照合とは独立した観点）。
    [query] {service=~"frontend|order-service"} | json | type = "access_log"
    [result] 27 件取得
    [query] {service=~"inventory-service|warehouse-service|employee-service"} | json | type = "access_log"
    [result] 11 件取得
  user-facing jti 数 : 7
  downstream  jti 数 : 11
  ✓ jti の重複なし

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CHECK: downstreamで使われたjtiの正当性確認
  各バックエンドサービス（frontend以外の全て）で使われた(jti, audience)の組が、KeycloakのTOKEN_EXCHANGE発行記録に存在するかを確認する。trace_idではなくjti自体で突合するため、同一トークンが複数リクエストに跨ってキャッシュ・再利用されても偽陽性にならない（trace_id相関だとリクエスト単位でしか見えないため、正当なキャッシュ再利用が「対応する交換なし」と誤検知されうる）。
    [query] {service=~"order-service|inventory-service|warehouse-service|employee-service"} | json | type = "access_log" | status != 401
    [result] 15 件取得
    [query] {service="keycloak"} |= "TOKEN_EXCHANGE"
    [result] 14 件取得
  downstream (jti,audience) 数 : 15
  TOKEN_EXCHANGE 記録確認済み  : 14
  ✗ TOKEN_EXCHANGE 記録なし 1 件（Exchangeを経ずに発行された、または全く別経路のトークン）:
    jti=trrtcc:0f1f5a1c-8006-0f3a-5ebc-6f067b59d410  audience=inventory-service  GET /inventory/product-A  sub=0dd5aee9-fbdd-4b5d-9a50-e5202a871248  status=403  at 03:02:18

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CHECK: LOGIN 前アクセスの有無
  アクセスログに現れた各subについて、それより前にKeycloak LOGINイベントが存在するかを確認する。ウィンドウ内にLOGINが見つからない場合は「ウィンドウより前にログインしてセッションを継続している」可能性と区別できないため、違反とは扱わず参考情報としてのみ報告する。真の違反はLOGINがアクセスより後（＝認証前アクセス）になっているケースのみ。
    [query] {service=~"frontend|order-service|inventory-service|warehouse-service|employee-service"} | json | type = "access_log"
    [result] 38 件取得
    [query] {service="keycloak"} |= "type=\"LOGIN\""
    [result] 3 件取得
  ユニーク sub 数       : 4
  LOGIN 先行確認済み     : 3
  ・ウィンドウ内にLOGIN記録なし（参考情報。違反とは断定しない） 1 件:
    sub=0dd5aee9-fbdd-4b5d-9a50-e5202a871248  初回アクセス=03:02:18(inventory-service)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  総合判定:  CHECK1=✓  CHECK2=✗  CHECK3=✓
  結論    :  ✗ 要確認の項目がある（上記の ✗ 行を参照）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

（内部整合性の参考：CHECK1の2クエリの合計27+11=38はCHECK3の取得件数と一致する。同一時間帯の同一ログ集合を異なるサービス範囲で分割して取得しているだけなので、これは当然の一致。）

CHECK1・CHECK3は問題なし（`✓`）。CHECK2だけが1件の不整合を検知し、末尾の「結論」に`✗`として反映されると同時に`exit 1`でプロセスを終了させている。

### この検知が示すもの

検知されたjti（`trrtcc:0f1f5a1c...`）は`run_bypass_attempt`によるもの。order-service自身の資格情報でaudience=inventory-serviceのトークンを直接取得し、Token Exchangeを一切経由せずにinventory-serviceへ提示した。トークン自体は正当な署名・issuer・audienceを持ち、inventory-serviceの認証は正常に通過する（最終的に403（ロール不足）で拒否されているが、これは認可の話であり認証は成功している）。

CHECK2は`trace_id`を一切見ていない。Keycloakの`TOKEN_EXCHANGE`イベント集合に、使われたjti（`trrtcc:0f1f5a1c...`）とaudience（`inventory-service`）の組が存在しないことだけを根拠に検知している。実際、Keycloakはこの発行を`type="CLIENT_LOGIN"`として記録しており、`TOKEN_EXCHANGE`イベントは生成されない——「正当な経路で発行されたトークンではない」という事実が、突合対象のログにそのまま現れている。

なお、このjtiはCHECK1の「downstream jti 数」11件にも含まれているが、CHECK1自体は`✓`のままである。これは見落としではない——CHECK1が検知するのは「同一jtiがuser-facing層とdownstream層の両方に現れる」ケース（隣接ホップ間の使い回し）であり、このバイパストークンはinventory-serviceにしか提示していないため、user-facing側のjti集合との重複は最初から発生しない。CHECK1とCHECK2は互いに独立した不変条件であり、片方が`✓`でも他方の違反を否定する材料にはならない。

CHECK3で同じsub（`0dd5aee9...`、order-serviceのサービスアカウント）が「ウィンドウ内にLOGIN記録なし」として参考情報に上がっているのも一貫している。サービスアカウントはそもそもLOGINフローを通らない（`client_credentials`グラントは`type="CLIENT_LOGIN"`であって`type="LOGIN"`ではない）。CHECK3はこれを「違反」と断定せず参考情報に留めており、意図した設計通りに動いている。

### 旧設計（trace_id相関）で検知していた偽陽性について

この監査ツールは元々CHECK2を`trace_id`で相関する設計だった。当時、OTelのtrace伝播が及ばない経路（計装されていない手動リクエスト）を通した正当なToken Exchangeが「TOKEN_EXCHANGE未記録」として誤検知される事例が実際に発生した——trace_id相関は「経路の一貫性」を見ているだけで、「トークンが正当に発行されたか」という監査したい事実そのものを見ていなかったため、両者を区別できなかった。

`(jti, audience)`相関への変更後は、この種の偽陽性は原理的に発生しない。Keycloakが発行した記録さえあれば、計装の有無・trace伝播の成否に関わらず正しく「正当」と判定される。設計変更の詳細は[ADR 0012](adr/0012-jti-audience-correlation-for-token-exchange-audit.md)を参照。

## 既知の限界

- **order-serviceの401は記録されない**：`BearerTokenAuthenticationFilter`起因の401（トークン自体が無効/期限切れ）はDispatcherServlet前段で拒否されるため、アプリ側のアクセスログ（`AccessLogInterceptor`）に記録が残らない（[insights.md](insights.md)参照）。CHECK2は`status != 401`で除外しているため、この既知の欠落自体が誤検知を生むことはないが、「401そのものの監査証跡が無い」という別の限界として認識しておく必要がある。
- **ウィンドウ内にLOGINが無いケースは違反と断定できない**：CHECK3は「ウィンドウより前にログインしてセッションを継続している」ケースや「サービスアカウントなどLOGINフローを経ないsub」を区別できない。あくまで「同一ウィンドウ内での先行確認」であり、それ自体は`audit.py`の出力にも明記している（真の違反として扱うのはLOGINがアクセスより後になっているケースのみ）。
- **Keycloak TOKEN_EXCHANGEイベントの取得ウィンドウは`AUDIT_EXCHANGE_LOOKBACK_SECONDS`（既定300秒）分だけレポート対象ウィンドウより広い**：中継トークンのTTL（60秒）内でキャッシュ再利用された場合、発行時刻がレポート対象ウィンドウの開始前になりうるため。TTLを大きく超えて延長する設計変更を行う場合はこの値も合わせて見直す必要がある。
- **Loki側の`limit`（既定5000件）に到達した場合、集合突合が不完全になりうる**：`query_loki`はこの場合に警告を標準出力（実行ログ）へ出すが、レポート自体は取得できた範囲でしか判定できない。長時間ウィンドウや高トラフィック環境では、ページネーションでの全件取得に変更する必要がある（現状は未実装）。
