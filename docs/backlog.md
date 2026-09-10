# バックログ

未着手の改善項目。優先度は明記していないもの以外は並列。着手時はこのファイルから該当項目を削除し、必要ならarchitecture.md/insights.mdへ結果を記録する。

## アプリ層の認可決定ログ設計

現状の監査設計（§9/§10）はKeycloak層（サービス間のToken Exchange成功/失敗）のみを対象としており、アプリ層の認可決定が記録されていない。具体的にはUC4のような支店不一致による引当拒否（Warehouse Serviceがstatus=REJECTEDを返す判断）が、どのサービスのどのログにも残らない。

- **設計が必要な内容**：`sub`・`jti`・`trace_id`・判定結果（PERMIT/DENY）・判定根拠（例: `branch_mismatch`）を構造化ログとして記録する形式と記録箇所（Warehouse Service、Inventory Serviceそれぞれ）
- **参照**：[use-cases.md](use-cases.md) UC4、[architecture.md](architecture.md) §9（Keycloak層のログ設計）、[insights.md](insights.md)「監査ログ・トークン監査」節
- **前提**：アプリ層ABAC（permission-matrix.md 表2〜5）の実装が先行する

## UC8/UC9における層の責務逆転

Order Serviceの`WarehouseStockController`（[order-service/src/main/java/com/example/orderservice/WarehouseStockController.java](../order-service/src/main/java/com/example/orderservice/WarehouseStockController.java)）が`warehouse-viewer`/`warehouse-viewer-all`ロールを直接チェックしている。これはWarehouse Service（[warehouse-service/src/handlers.rs](../warehouse-service/src/handlers.rs)の`authorize_branch`）が本来担うRBAC判定（permission-matrix.md 表5）の複製であり、UC4で確立した「支店別アクセス制御は上流の関心事ではない」という層分離の原則と矛盾する。

- **問題**：Warehouse Serviceのロール名・判定ロジックをOrder Serviceが知っている必要があり、Warehouse Service側の権限体系が変わるとOrder Serviceも追随して変更しなければならない
- **検討すべき代替案**：Order Serviceでの事前チェックをやめてチェーンの奥（Warehouse Service）でのみ判定する（ただし委任チェーンを最後まで走らせてから拒否するコストとのトレードオフ）、またはOrder Serviceの事前チェックを「フェイルファストの最適化」として明示し本来の権威はWarehouse Service側にあることをコメント等で明記する
- **参照**：[use-cases.md](use-cases.md) UC8/UC9、[permission-matrix.md](permission-matrix.md) 表5

## TTL設定の実機検証

architecture.md §11「サービス間の中継トークンはTTLを短く設定する」・§18「短TTLで緩和する」という記述に反し、`keycloak/realm-export.json`にはrealmレベル・クライアントレベルとも`accessTokenLifespan`の明示設定が存在しない。実際に効いているのはKeycloakデフォルト（5分）であり、「短く設定した」という主張は未検証。

- **対応が必要な内容**：委任チェーン用のトークンに短いTTL（例: 数十秒〜1分程度）を明示設定するか、現状のデフォルト値のままで許容するかを決定し、§11・§18の記述を実態に合わせる
- **参照**：[architecture.md](architecture.md) §11・§18

## WebUIの見た目の改善

現状の`frontend/app/app.vue`は受注登録フォーム・受注一覧・社員情報照会のみの最小限の実装。スタイリング・レイアウトの改善。

## メトリクスのOTel連携

主要な業務メトリクス（受注件数、Token Exchange成功/失敗率など）をPrometheusへ送るなどの拡張。

## その他の細かい改善候補

- **サンプリング率を下げた状態でのtrace_id保持の実機確認**：サンプリング率を1.0未満に下げた状態でも`sampled=false`のリクエストのtrace_idがKeycloak/各サービスのログに残ることを実機で確認する（[insights.md](insights.md)「サンプリング率を下げた状態での動作は未検証」節）
- **order-serviceのDBノードの`connection_type`表記**：Service Graph上で`order-service -> order-postgres`のみ`connection_type=virtual_node`と表示され、他サービスの`database`表記と揃っていない（[insights.md](insights.md)のDBノード命名の節）。`datasource-micrometer-spring-boot`側のOTelマッピング設定を調べて揃えられないか
- **mTLS(RFC 8705) Certificate-Bound Access Tokensの検討**：現状DPoPのみ採用（[architecture.md](architecture.md) §11）。本番導入を想定する場合の比較検討として残す
- **issuerの「localhost」感の解消**：`/etc/hosts`への偽ホスト名追加とedge-proxyのポート80公開が必要で、「リポジトリ外の変更なしに動く」という前提を崩すため保留中（[architecture.md](architecture.md) §18）。もし許容できる代替案が見つかれば着手
