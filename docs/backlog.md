# バックログ

未着手の改善項目。優先度は明記していないもの以外は並列。着手時はこのファイルから該当項目を削除し、必要ならarchitecture.md/insights.mdへ結果を記録する。

## その他の細かい改善候補

- **サンプリング率を下げた状態でのtrace_id保持の実機確認**：サンプリング率を1.0未満に下げた状態でも`sampled=false`のリクエストのtrace_idがKeycloak/各サービスのログに残ることを実機で確認する（[insights.md](insights.md)「サンプリング率を下げた状態での動作は未検証」節）
- **order-serviceのDBノードの`connection_type`表記**：Service Graph上で`order-service -> order-postgres`のみ`connection_type=virtual_node`と表示され、他サービスの`database`表記と揃っていない（[insights.md](insights.md)のDBノード命名の節）。`datasource-micrometer-spring-boot`側のOTelマッピング設定を調べて揃えられないか
- **mTLS(RFC 8705) Certificate-Bound Access Tokensの検討**：現状DPoPのみ採用（[architecture.md](architecture.md) §11）。本番導入を想定する場合の比較検討として残す
- **issuerの「localhost」感の解消**：`/etc/hosts`への偽ホスト名追加とedge-proxyのポート80公開が必要で、「リポジトリ外の変更なしに動く」という前提を崩すため保留中（[architecture.md](architecture.md) §18）。もし許容できる代替案が見つかれば着手
- **支店マスタの参照データ共有問題**：Warehouse Serviceの在庫キー（`stock:{branch}:{product_id}`）とEmployee Serviceの社員の所属支店フィールドは、同じ文字列（`tokyo`/`osaka`）を各サービスが独立に採用しているだけで、どちらかが正典（マスタ）というわけではない。現状は`get_stock_by_branches`がWarehouse Service自身の保有データ（Redisキー）だけをスキャンすることでこの問題を回避している（[architecture.md](architecture.md) §20）。将来「支店マスタそのものを参照する要件」が生じた場合、マイクロサービスにおける参照データ共有の設計課題が顕在化する
