# ユースケース

具体的な業務シナリオごとに、どのサービスがどう連携して実現するかを示す。各サービスの役割は`services.md`、認可判定の詳細は`permission-matrix.md`を参照。

## UC1: 受注登録（正常系、実際に在庫を引き当てるため3ホップ全てを通る）

登場人物：yamada-sales（`order-writer`, `inventory-writer`, `warehouse-viewer`, 所属支店=東京）

```
1. yamada-sales が frontend からログイン（scope=order）
2. frontend → Order Service: 受注登録リクエスト
3. Order Service: order-writer ロールを確認 → 許可
4. Order Service → Inventory Service: Token Exchange（audience=inventory-service, scope=inventory）で在庫の引当（write）を依頼
5. Inventory Service: inventory-writer ロールを確認 → 許可。商品-支店マッピングから対象支店（例: 東京支店）を特定
6. Inventory Service → Warehouse Service: Token Exchange（audience=warehouse-service, scope=warehouse）で東京支店への実引当を依頼
7. Warehouse Service → Employee Service: Token Exchange（audience=employee-service, scope=employee）でyamada-salesの所属支店を確認
8. Employee Service: sub=yamada-sales の所属支店（東京）を返す
9. Warehouse Service: 照会対象支店が東京（一致）かつwarehouse-viewerロールあり → 許可。東京支店の実在庫を引当・減算
10. Inventory Service が集計値を更新 → Order Service へ返却
11. Order Service: 引当成功 → 受注をCONFIRMEDで登録
```

## UC2: 受注照会（正常系、集計在庫の確認のみでWarehouse Serviceへは到達しない）

登場人物：suzuki-support（`order-reader`, `inventory-reader`。`warehouse-viewer`は持たない）

```
1. suzuki-support が frontend からログイン
2. frontend → Order Service: 受注照会リクエスト
3. Order Service: order-reader ロールを確認 → 許可。保存済みの受注データ（ステータス含む）を返す
4. 必要に応じて Order Service → Inventory Service: Token Exchange（scope=inventory）で集計在庫を確認（read）
5. Inventory Service: inventory-reader ロールを確認 → 許可。Warehouse Serviceから非同期同期済みの集計値で回答し、Warehouse Serviceへは委任しない
```

suzuki-supportは`warehouse-viewer`を持たないが、UC2では支店別の実数値（Warehouse Serviceの管轄）そのものを必要としないため問題なく完結する。支店別の実引当が必要になるのはUC1（受注登録）のときだけ。

## UC3: 受注登録の拒否（権限不足）

登場人物：suzuki-support（`order-writer`を持たない）

```
1. suzuki-support が frontend から受注登録を試みる
2. Order Service: order-writer ロールがない → 拒否（permission-matrix.md 表2）
3. Token Exchangeのチェーンは開始されない
```

## UC4: 他拠点在庫の照会拒否

登場人物：yamada-sales（所属支店=東京）が大阪支店の実在庫を照会しようとする場合

```
1〜8. UC1と同様にOrder Service→Inventory Service→Warehouse Service→Employee Serviceの委任が進む
9. Warehouse Service: 照会対象支店（大阪）と所属支店（東京）が不一致 → 拒否（permission-matrix.md 表5）
   （Inventory Serviceが持つ「商品Aは東京・大阪にある」という集計情報自体は誰でも見られるが、
     大阪の実数値・引当はyamada-salesには開示されない）
```

## UC5: 自分の社員情報照会

登場人物：任意のユーザー（ロール不問）

```
1. ユーザーが frontend からログイン（scope=employee）
2. frontend → Employee Service: 自分の情報を照会（直接、委任チェーンなし）
3. Employee Service: トークンのsub == 照会対象ID → 許可（permission-matrix.md 表4）
```

## UC6: 他人の社員情報照会（HR）

登場人物：tanaka-hr（`hr-viewer`）

```
1. tanaka-hr が frontend からログイン（scope=employee）
2. frontend → Employee Service: 任意の社員IDを指定して照会（直接）
3. Employee Service: トークンのsub != 照会対象IDだが、hr-viewerロールを保持 → 許可
```

## UC7: 他人の社員情報照会の拒否

登場人物：yamada-sales（`hr-viewer`を持たない）

```
1. yamada-sales が frontend から他人（例: suzuki-support）の社員情報を照会しようとする
2. Employee Service: トークンのsub != 照会対象ID かつ hr-viewerロールなし → 拒否
```

## UC8: 全支店の在庫照会（物流管理）

登場人物：sato-logistics（`warehouse-viewer-all`）

```
1. sato-logistics が frontend からログインし、Order Service経由の受注照会は行わず、
   物流管理向けの画面から特定支店（例: 大阪）の在庫を確認する
2. Warehouse Serviceへ到達するまでの経路はUC1と同様（Order Service→Inventory Service→Warehouse Service）
3. Warehouse Service: sato-logisticsの所属支店が大阪でなくても、warehouse-viewer-allロールを保持 → 一致チェックを省略して許可（permission-matrix.md 表5）
```
