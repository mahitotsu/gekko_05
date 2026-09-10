# 監査デモ：トークン発行・利用記録とアクセスログの突合

`audit/`（`audit.py`・`scenario.py`）は、Lokiに集まった各サービスのアクセスログとKeycloakのイベントログを突合し、「Token Exchangeが本当に経路通りに使われているか」を機械的に検証するツール。`docs/backlog.md`の「監査突合のデモ手順の確立」を実装したもの。設計判断の背景は[insights.md](insights.md)「監査ログ・トークン監査（audit/）」節を参照。

## 実行方法

```
make audit-scenario   # 3ユーザーでログイン+API呼び出し（Token Exchangeチェーンを実際に発生させる）
make audit-report     # 直近1時間のログを突合してレポート出力
make audit-demo        # 上記2つ + 後片付けを一括実行
```

`audit-report`は不整合を検知すると`exit 1`で終了する（CI等でgateできるようにする意図的な設計）。

## 3つのチェック

| CHECK | 検証内容 | 突合キー |
|---|---|---|
| 1 | user-facing層（frontend/order-service）とdownstream層（inventory/warehouse/employee-service）のjtiが重複していないか | `jti` |
| 2 | downstreamへのアクセスがあったtrace_idに、対応するKeycloakのTOKEN_EXCHANGEイベントが存在するか | `trace_id` |
| 3 | アクセスログに現れたsubについて、それより前にKeycloakのLOGINイベントが存在するか | `sub` |

## 実際に検知した例

以下は`make audit-report`を本リポジトリで実行した際の全出力（`docker compose --profile audit run --rm audit`）。CHECK2が実際に不整合を検知している。

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Token Exchange 監査レポート
  Loki : http://otel-lgtm:3100
  期間 : 2026-09-10 08:21:35 UTC ～ 2026-09-10 09:21:35 UTC (60 分間)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CHECK: Token Exchange バイパス検出
  user-facing 層と downstream 層の jti が重複していないことを確認する（重複 = Exchangeを経ずに上位層のトークンを下位層に持ち込んでいる）。
    [query] {service=~"frontend|order-service"} | json | type = "access_log"
    [result] 170 件取得
    [query] {service=~"inventory-service|warehouse-service|employee-service"} | json | type = "access_log"
    [result] 59 件取得
  user-facing jti 数 : 44
  downstream  jti 数 : 59
  ✓ jti の重複なし

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CHECK: TOKEN_EXCHANGE ↔ downstream アクセス対応確認
  downstream サービスへアクセスがあった trace_id ごとに、同一traceのKeycloak TOKEN_EXCHANGEイベントの存在を確認する。
    [query] {service=~"inventory-service|warehouse-service|employee-service"} | json | type = "access_log" | status != 401
    [result] 59 件取得
    [query] {service="keycloak"} |= "TOKEN_EXCHANGE"
    [result] 88 件取得
  downstream trace 数        : 37
  TOKEN_EXCHANGE 対応確認済み : 36
  ✗ TOKEN_EXCHANGE 未記録 1 件:
    trace_id=c9bc1c362c53b84deeb88bcd13b4657e  inventory-service POST /inventory/product-A/reserve  sub=09ed33ad-ad8d-43da-beee-12685e443011  at 08:46:59

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CHECK: LOGIN 前アクセスの有無
  アクセスログに現れた各subについて、同一ウィンドウ内にそれ以前のKeycloak LOGINイベントが存在するかを確認する（LOGINがウィンドウ外の場合は「ウィンドウ内未記録」と報告されるが違反とは限らない）。
    [query] {service=~"order-service|inventory-service|warehouse-service|employee-service|frontend"} | json | type = "access_log"
    [result] 229 件取得
    [query] {service="keycloak"} |= "type=\"LOGIN\""
    [result] 24 件取得
  ユニーク sub 数       : 3
  LOGIN 先行確認済み     : 3
  ✓ 全 sub に LOGIN の先行を確認

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  総合判定:  CHECK1=✓  CHECK2=✗  CHECK3=✓
  結論    :  ✗ 要確認の項目がある（上記の ✗ 行を参照）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

CHECK1・CHECK3は問題なし（`✓`）。CHECK2だけが1件の不整合を検知し、末尾の「結論」に`✗`として反映されると同時に`exit 1`でプロセスを終了させている。

### この検知が示すもの

この`trace_id`は、`scenario.py`の3ユーザーシナリオではなく、実装検証中に手動で送った生HTTPリクエスト（Pythonの`requests`でKeycloakのtoken endpointを直接叩き、Token Exchangeを2段実施した上でinventory-serviceに直接POSTしたもの）に対応する。使われたトークン自体は正当にToken Exchangeされたものだったが、そのExchangeリクエスト自体にW3C `traceparent`を伝播させていなかったため、Keycloak側のTOKEN_EXCHANGEイベントとinventory-serviceのアクセスログが**別々のtrace_idを持つ独立したトレース**になった。

これは実際のバイパス（Exchangeを経ずにトークンを流用する攻撃）ではないが、監査ツールとしては区別できない——**というのがこの検知の価値そのもの**である。通常のシステム利用（frontend→order-service→inventory-service…の各ホップがOTel計装されたHTTPクライアントで呼び合う経路）では、trace_idは自動的に一貫して伝播する。逆に、この一貫性が崩れる状況とは：

- 何らかのツール・スクリプトが正規の呼び出し経路をバイパスして下流サービスに直接アクセスした
- トレース伝播が壊れている（バグ、あるいは計装されていない中間コンポーネントの存在）
- 盗まれたトークンが、元のリクエストとは無関係な別のクライアントから使われた

のいずれかであり、どの場合も監査上「要確認」に値する。今回のケースは1番目（意図した手動検証）だったが、CHECK2は原理的に3番目（トークン盗用）も同じ形で検知する。**「無害な理由で光った」こと自体が、このチェックが実際に機能している証拠**になっている。

## 既知の限界

- **order-serviceの401は記録されない**：`BearerTokenAuthenticationFilter`起因の401（トークン自体が無効/期限切れ）はDispatcherServlet前段で拒否されるため、アプリ側のアクセスログ（`AccessLogInterceptor`）に記録が残らない（[insights.md](insights.md)参照）。CHECK2は`status != 401`で除外しているため、この既知の欠落自体が誤検知を生むことはないが、「401そのものの監査証跡が無い」という別の限界として認識しておく必要がある。
- **trace_idが分断されると偽陽性になる**：上記の実例の通り、OTelのトレース伝播が及ばない経路（計装されていないツール・手動リクエスト・サンプリングの境界等）を通ったアクセスは、実際は正当でもCHECK2で「未記録」として検出される。運用する場合はこの偽陽性の可能性を前提に、検知された`trace_id`が実在の呼び出し経路上のものかを人間が確認する一手間が必要。
- **ウィンドウ内にLOGINが無いケースは違反と断定できない**：CHECK3は「ウィンドウより前にログインしてセッションを継続している」ケースを区別できない。あくまで「同一ウィンドウ内での先行確認」であり、それ自体は`audit.py`の出力にも明記している。
