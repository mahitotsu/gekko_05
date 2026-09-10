# バックログ

未着手の改善項目。優先度は明記していないもの以外は並列。着手時はこのファイルから該当項目を削除し、必要ならarchitecture.md/insights.mdへ結果を記録する。

## Keycloak監査ログとOTelトレースの突合

「認可交換の事実の記録（Keycloakの管理イベントログ）」と「経路の可視化（OTelトレース）」という別々の情報源を、実際にどう突き合わせて確認できるかを示す（[architecture.md](architecture.md) §10）。

- 単純にはタイムスタンプ・`sub`・`aud`でKeycloakの管理イベントとOTelトレースを手動突合する形になる
- より進めるなら、各サービスがToken Exchangeリクエストを送る際に`traceparent`ヘッダをKeycloakへのHTTPリクエストにも付与し、Keycloakの管理イベントログ（またはイベントリスナーSPI）がtrace_idを記録できるか調査する価値がある。実現できればtrace_idそのものでの機械的な突合が可能になる

## トークン発行と利用の監査方法の検討と試行

上記のトレース突合とは別に、「誰が・いつ・どのスコープのトークンを発行され・実際にどのエンドポイントで使ったか」を追跡する監査手法そのものの検討。Keycloakのイベントログ機能だけで十分か、専用の監査ログ基盤（SIEM等）との連携が要るか、本サンプルの規模でどこまで実演する価値があるかを含めて要検討。

## WebUIの見た目の改善

現状の`frontend/app/app.vue`は受注登録フォーム・受注一覧・社員情報照会のみの最小限の実装。スタイリング・レイアウトの改善。

## ログ・メトリクスのOTel連携

現状は`grafana/otel-lgtm`のうちTempo（トレース）のみを使用しており、Loki（ログ）・Prometheus/Mimir（メトリクス）は未活用（[architecture.md](architecture.md) §10）。各サービスのアプリケーションログをOTLP経由でLokiへ送る、主要な業務メトリクス（受注件数、Token Exchange成功/失敗率など）をPrometheusへ送るなどの拡張。

## その他の細かい改善候補

- **order-serviceのDBノードの`connection_type`表記**：Service Graph上で`order-service -> order-postgres`のみ`connection_type=virtual_node`と表示され、他サービスの`database`表記と揃っていない（[insights.md](insights.md)のDBノード命名の節）。`datasource-micrometer-spring-boot`側のOTelマッピング設定を調べて揃えられないか
- **mTLS(RFC 8705) Certificate-Bound Access Tokensの検討**：現状DPoPのみ採用（[architecture.md](architecture.md) §11）。本番導入を想定する場合の比較検討として残す
- **issuerの「localhost」感の解消**：`/etc/hosts`への偽ホスト名追加とedge-proxyのポート80公開が必要で、「リポジトリ外の変更なしに動く」という前提を崩すため保留中（[architecture.md](architecture.md) §18）。もし許容できる代替案が見つかれば着手
