# バックログ

未着手の改善項目。優先度は明記していないもの以外は並列。着手時はこのファイルから該当項目を削除し、必要ならarchitecture.md/insights.mdへ結果を記録する。

## アプリ層の認可決定ログ設計

現状の監査設計（§9/§10）はKeycloak層（サービス間のToken Exchange成功/失敗）のみを対象としており、アプリ層の認可決定が記録されていない。具体的にはUC4のような支店不一致による引当拒否（Warehouse Serviceがstatus=REJECTEDを返す判断）が、どのサービスのどのログにも残らない。

- **設計が必要な内容**：`sub`・`jti`・`trace_id`・判定結果（PERMIT/DENY）・判定根拠（例: `branch_mismatch`）を構造化ログとして記録する形式と記録箇所（Warehouse Service、Inventory Serviceそれぞれ）
- **参照**：[use-cases.md](use-cases.md) UC4、[architecture.md](architecture.md) §9（Keycloak層のログ設計）、[insights.md](insights.md)「監査ログ・トークン監査」節
- **前提**：アプリ層ABAC（permission-matrix.md 表2〜5）の実装が先行する

## WebUIの見た目の改善

現状の`frontend/app/app.vue`は受注登録フォーム・受注一覧・社員情報照会のみの最小限の実装。スタイリング・レイアウトの改善。

## メトリクスのOTel連携

主要な業務メトリクス（受注件数、Token Exchange成功/失敗率など）をPrometheusへ送るなどの拡張。

## その他の細かい改善候補

- **サンプリング率を下げた状態でのtrace_id保持の実機確認**：サンプリング率を1.0未満に下げた状態でも`sampled=false`のリクエストのtrace_idがKeycloak/各サービスのログに残ることを実機で確認する（[insights.md](insights.md)「サンプリング率を下げた状態での動作は未検証」節）
- **order-serviceのDBノードの`connection_type`表記**：Service Graph上で`order-service -> order-postgres`のみ`connection_type=virtual_node`と表示され、他サービスの`database`表記と揃っていない（[insights.md](insights.md)のDBノード命名の節）。`datasource-micrometer-spring-boot`側のOTelマッピング設定を調べて揃えられないか
- **mTLS(RFC 8705) Certificate-Bound Access Tokensの検討**：現状DPoPのみ採用（[architecture.md](architecture.md) §11）。本番導入を想定する場合の比較検討として残す
- **issuerの「localhost」感の解消**：`/etc/hosts`への偽ホスト名追加とedge-proxyのポート80公開が必要で、「リポジトリ外の変更なしに動く」という前提を崩すため保留中（[architecture.md](architecture.md) §18）。もし許容できる代替案が見つかれば着手
