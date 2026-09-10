# バックログ

未着手の改善項目。優先度は明記していないもの以外は並列。着手時はこのファイルから該当項目を削除し、必要ならarchitecture.md/insights.mdへ結果を記録する。

## WebUIの見た目の改善

現状の`frontend/app/app.vue`は受注登録フォーム・受注一覧・社員情報照会のみの最小限の実装。スタイリング・レイアウトの改善。

## メトリクスのOTel連携

主要な業務メトリクス（受注件数、Token Exchange成功/失敗率など）をPrometheusへ送るなどの拡張。

## その他の細かい改善候補

- **サンプリング率を下げた状態でのtrace_id保持の実機確認**：サンプリング率を1.0未満に下げた状態でも`sampled=false`のリクエストのtrace_idがKeycloak/各サービスのログに残ることを実機で確認する（[insights.md](insights.md)「サンプリング率を下げた状態での動作は未検証」節）
- **order-serviceのDBノードの`connection_type`表記**：Service Graph上で`order-service -> order-postgres`のみ`connection_type=virtual_node`と表示され、他サービスの`database`表記と揃っていない（[insights.md](insights.md)のDBノード命名の節）。`datasource-micrometer-spring-boot`側のOTelマッピング設定を調べて揃えられないか
- **mTLS(RFC 8705) Certificate-Bound Access Tokensの検討**：現状DPoPのみ採用（[architecture.md](architecture.md) §11）。本番導入を想定する場合の比較検討として残す
- **issuerの「localhost」感の解消**：`/etc/hosts`への偽ホスト名追加とedge-proxyのポート80公開が必要で、「リポジトリ外の変更なしに動く」という前提を崩すため保留中（[architecture.md](architecture.md) §18）。もし許容できる代替案が見つかれば着手
