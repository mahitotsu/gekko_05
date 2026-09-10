# 権限マップ（ディシジョンテーブル）

architecture.md §9-§13で決めた認可設計を、条件と結果が漏れなく列挙できる形（ディシジョンテーブル）で整理する。性質の異なる認可判断ごとに表を分ける。

## 表1: 委任トポロジー（Keycloak層・検証済み）

条件は「要求元」と「要求先audience」の2軸。登場する5エンティティ（frontend, order-service, inventory-service, warehouse-service, employee-service）を両軸に置いた5×5=25マス。`keycloak/tests/permission-matrix.sh`で25マス全て実行検証している。

| 要求元 \ 要求先 | frontend | order-service | inventory-service | warehouse-service | employee-service |
|---|---|---|---|---|---|
| frontend（直接ログイン） | DENY | ALLOW | DENY | DENY | ALLOW |
| order-service（交換） | DENY | DENY | ALLOW | DENY | DENY |
| inventory-service（交換） | DENY | DENY | DENY | ALLOW | DENY |
| warehouse-service（交換） | DENY | DENY | DENY | DENY | ALLOW |
| employee-service（交換） | DENY | DENY | DENY | DENY | DENY |

- ALLOWは5マスのみ（frontend→order-service, frontend→employee-service, order-service→inventory-service, inventory-service→warehouse-service, warehouse-service→employee-service）。残り20マスは全てDENY
- 対角線（自分自身を要求先にする）も含めて全てDENYであることを実機で確認済み。理由はマスごとに異なる：
  - frontend→frontend：`aud`クレーム自体が発行されない（frontendを対象にするaudienceマッパーが存在しない）
  - order/inventory/warehouse-service→自分自身：各クライアントは自分自身が発行するスコープ（例: order-serviceは`order`スコープ）を持っていないため`invalid_scope`
  - employee-service→どこでも：`standard.token.exchange.enabled=false`のため、対象を問わず`Standard token exchange is not enabled for the requested client`で拒否される（これは全5マスに共通する理由であり、employee-serviceの行は構造的に全DENY）
  - X-service→frontend：frontendを対象にするaudienceマッパーが存在しないため`Requested audience not available: frontend`
- ALLOWの5マスはすべて `optionalClientScopes` の割当のみで実現している（architecture.md §12）。Client Policiesは使っていない

## 表2: Order Serviceの操作可否（アプリ層・実装済み）

条件は「ユーザーのロール」と「操作種別」の2軸。

| ロール \ 操作 | 受注登録（write） | 受注照会（read） |
|---|---|---|
| order-writer | ALLOW | ALLOW |
| order-reader | DENY | ALLOW |
| その他 | DENY | DENY |

実装：[OrderController.java](../order-service/src/main/java/com/example/orderservice/OrderController.java)の`@PreAuthorize`。この4行×2列＝8ケースに対応する自動テストは未整備（拒否系はpermission-matrix.sh・e2eのいずれにも含まれない）。

## 表3: Inventory Serviceの操作可否（アプリ層・実装済み）

条件は「ユーザーのロール」と「操作種別」の2軸。Inventory Serviceはfrontendから直接呼ばれず、Order Service経由の委任チェーンでのみ到達する（表1）が、`sub`とロールクレームはそのチェーンを通じて維持される（検証済み）ため、Inventory Service自身がこの表で判定できる。

| ロール \ 操作 | 在庫更新（write） | 在庫照会（read） |
|---|---|---|
| inventory-writer | ALLOW | ALLOW |
| inventory-reader | DENY | ALLOW |
| その他 | DENY | DENY |

実装：[auth.go](../inventory-service/auth.go)の`hasAnyRole`。この3行×2列＝6ケースに対応する自動テストは未整備。

## 表4: Employee Serviceの照会可否（アプリ層・実装済み）

条件は「ユーザーのロール」と「操作種別」の2軸。

| ロール \ 操作 | 自分の情報の照会 | 他人の情報の照会 |
|---|---|---|
| hr-viewer | ALLOW | ALLOW |
| その他 | ALLOW | DENY |

実装：[main.py](../employee-service/main.py)の`is_self`/`hr-viewer`判定。委任チェーン経由（warehouse-service→employee-service）で渡されるトークンは常に`sub`=元ユーザーなので、経路上は必ず「照会対象=自分」の行に該当する。この2行×2列＝4ケースに対応する自動テストは未整備。

## 表5: Warehouse Serviceの支店別照会可否（アプリ層・実装済み、RBAC+ABACの組み合わせ）

Inventory Serviceとの違いを明確にするため、Warehouse Serviceは2段階の判定にする。

1. **RBAC**：ロールを持たない場合は無条件でDENY（Inventory Serviceと同様、まずロールでゲートする）
2. **ABAC**：`warehouse-viewer`は、Employee Serviceが保持する社員の所属支店データと照会対象支店が一致する場合のみ許可する（「どの支店か」は安定した権限区分ではなく変化しうる業務データなので、Keycloakロールにはしない）。`warehouse-viewer-all`はこの一致チェックを不要とし、全支店を照会できる（Employee Serviceの`hr-viewer`と同じ「ロールがABACの一致チェックを上書きする」パターン）

条件は「ユーザーのロール」と「所属支店と照会対象支店が一致するか」の2軸。

| ロール \ 支店一致 | 一致 | 不一致 |
|---|---|---|
| warehouse-viewer-all | ALLOW | ALLOW |
| warehouse-viewer | ALLOW | DENY |
| その他 | DENY | DENY |

実装：[handlers.rs](../warehouse-service/src/handlers.rs)。この表は2つのエンドポイントで使われ方が異なる。

- 引当（`POST /warehouse/:branch/stock/:product_id/reserve`、UC1/UC4）：`authorize_branch`が対象支店1つに対してこの表通りDENY/ALLOWを判定し、不一致はそのままリクエストの拒否になる
- 支店別在庫照会（`GET /warehouse/stock/:product_id`、UC8/UC9/UC10）：`get_stock_by_branches`はRBAC行（ロールを持たない＝その他行）はそのままDENY（403）として扱うが、ABAC列（一致/不一致）は個々のリクエストの拒否ではなく、**レスポンスに含まれる支店の集合**として表現される（一致する支店だけが結果に現れ、不一致の支店は最初から候補に上らない）。表の意味自体は変わらないが、「不一致→DENY」の現れ方がエンドポイントによって異なる点に注意

この3行×2列＝6ケースに対応する自動テストは未整備。

この表の判定権威はWarehouse Service一箇所にのみ存在する。UC8/UC9/UC10の経路上にあるOrder Service・Inventory Serviceは、本表のロールを判定せずToken Exchangeで中継するのみ（architecture.md §20）。かつてはOrder Serviceの`WarehouseStockController`とInventory Serviceの`/warehouse-stock`ルートの双方が本表と同じロールを重複判定しており、層の責務分離の課題として[backlog.md](backlog.md)に起票されていたが、architecture.md §20で解消済み。

## テストユーザー

| ユーザー | 付与ロール |
|---|---|
| yamada-sales | order-writer, inventory-writer, warehouse-viewer |
| suzuki-support | order-reader, inventory-reader |
| tanaka-hr | hr-viewer |
| sato-logistics | warehouse-viewer-all |
