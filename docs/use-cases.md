# ユースケース

具体的な業務シナリオごとに、どのサービスがどう連携して実現するかを示す。各サービスの役割は`services.md`、認可判定の詳細は`permission-matrix.md`を参照。

業務シナリオ単位でグルーピングし、それぞれ正常系・異常系を示す。異常系は「どのように拒否が観測されるか」も明記する（同じ「拒否」でも、リクエスト自体がエラーになる場合と、処理は完了しつつ業務結果として不成立になる場合があり、両者は区別される）。

## 受注登録

### UC1: 正常系（実際に在庫を引き当てるため3ホップ全てを通る）

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

### UC3: 異常系・権限不足（受注登録の拒否）

登場人物：suzuki-support（`order-writer`を持たない）

```
1. suzuki-support が frontend から受注登録を試みる
2. Order Service: order-writer ロールがない → 拒否（permission-matrix.md 表2）
3. Token Exchangeのチェーンは開始されない
```

**拒否の見え方**：Order Serviceの`@PreAuthorize`がリクエストの入口で拒否するため、HTTPエラー（403）がそのままfrontend（BFF）まで伝播する。受注は作成されず、注文一覧にも何も追加されない。

### UC4: 異常系・支店不一致（他拠点在庫への引当拒否）

登場人物：yamada-sales（所属支店=東京）が大阪支店の実在庫が必要な商品を注文する場合

```
1〜8. UC1と同様にOrder Service→Inventory Service→Warehouse Service→Employee Serviceの委任が進む
9. Warehouse Service: 照会対象支店（大阪）と所属支店（東京）が不一致 → 拒否（permission-matrix.md 表5）
   （Inventory Serviceが持つ「商品は東京・大阪にある」という集計情報自体は誰でも見られるが、
     大阪の実数値・引当はyamada-salesには開示されない）
```

**拒否の見え方**：UC3とは異なり、HTTPエラーにはならない。Inventory Serviceは意図的に、Warehouse Serviceからの権限拒否（403）と純粋な在庫不足（409）を区別せず同じ「引当できなかった」という結果として扱う（支店別アクセス制御はInventory Serviceの関心事ではないため、権限拒否の事実そのものを上流に漏らさない設計）。そのため受注自体は201 Createdで正常に作成され、`status=REJECTED`として注文一覧に載る。外形上は在庫不足による拒否と区別できない。

## 受注照会

### UC2: 正常系（集計在庫の確認のみでWarehouse Serviceへは到達しない）

登場人物：suzuki-support（`order-reader`, `inventory-reader`。`warehouse-viewer`は持たない）

```
1. suzuki-support が frontend からログイン
2. frontend → Order Service: 受注照会リクエスト
3. Order Service: order-reader ロールを確認 → 許可。保存済みの受注データ（ステータス含む）を返す
4. 必要に応じて Order Service → Inventory Service: Token Exchange（scope=inventory）で集計在庫を確認（read）
5. Inventory Service: inventory-reader ロールを確認 → 許可。Warehouse Serviceから非同期同期済みの集計値で回答し、Warehouse Serviceへは委任しない
```

suzuki-supportは`warehouse-viewer`を持たないが、UC2では支店別の実数値（Warehouse Serviceの管轄）そのものを必要としないため問題なく完結する。支店別の実引当が必要になるのはUC1（受注登録）のときだけ。

## 社員情報照会

### UC5: 正常系・自分の社員情報照会

登場人物：任意のユーザー（ロール不問）

```
1. ユーザーが frontend からログイン（scope=employee）
2. frontend → Employee Service: 自分の情報を照会（直接、委任チェーンなし）
3. Employee Service: トークンのsub == 照会対象ID → 許可（permission-matrix.md 表4）
```

### UC6: 正常系・HRによる他人の社員情報照会

登場人物：tanaka-hr（`hr-viewer`）

```
1. tanaka-hr が frontend からログイン（scope=employee）
2. frontend → Employee Service: 任意の社員IDを指定して照会（直接）
3. Employee Service: トークンのsub != 照会対象IDだが、hr-viewerロールを保持 → 許可
```

### UC7: 異常系・一般ユーザーによる他人の社員情報照会拒否

登場人物：yamada-sales（`hr-viewer`を持たない）

```
1. yamada-sales が frontend から他人（例: suzuki-support）の社員情報を照会しようとする
2. Employee Service: トークンのsub != 照会対象ID かつ hr-viewerロールなし → 拒否
```

**拒否の見え方**：Employee ServiceがHTTPエラー（403）を返し、frontend（BFF）までそのまま伝播する。UC3と同じ「入口でのRBAC拒否」の形。

## 支店別在庫照会（物流管理）

この画面のリクエストは商品IDのみを指定し、支店を指定しない。「支店Xの在庫は？」ではなく「**自分が見える範囲**の在庫は？」という質問として設計されている（architecture.md §20）。そのためABAC（所属支店との一致・不一致）は個別のエラーではなく、レスポンスに含まれる支店の数として現れる。RBAC（`warehouse-viewer`/`warehouse-viewer-all`をどちらも持たない）だけは、この画面自体の利用資格の有無を問う別種の判定として、従来通り明示的な拒否のまま残す。

### UC8: 正常系（`warehouse-viewer-all`は全支店が見える）

登場人物：sato-logistics（`warehouse-viewer-all`、所属支店=大阪）

```
1. sato-logistics が frontend からログインし、Order Service経由の受注照会は行わず、
   物流管理向けの画面から商品（例: product-A、東京・大阪の両方に実在庫がある）の在庫を確認する
2. Warehouse Serviceへ到達するまでの経路はUC1と同様（Order Service→Inventory Service→Warehouse Service）
   だが、Order Service・Inventory Serviceはいずれも支店に関する判断を持たず中継するのみ（architecture.md §20）
3. Warehouse Service: warehouse-viewer-allロールを保持 → 所属支店（大阪）に関わらず、
   この商品の実在庫を持つ全支店（東京・大阪）を列挙して返す（permission-matrix.md 表5）
```

### UC10: 正常系（`warehouse-viewer`は自分の支店だけが見える）

登場人物：yamada-sales（`warehouse-viewer`、所属支店=東京）

```
1. yamada-salesが同じ画面で商品（例: product-A）の在庫を確認する
2. 経路はUC8と同様
3. Warehouse Service: warehouse-viewer-allは持たないため、所属支店（東京）確認のためEmployee Serviceへ委任し、
   確認できた自分の支店（東京）の実在庫のみを返す。大阪の実在庫はレスポンスに一切現れない
   （UC4と同じABAC境界だが、ここではエラーではなく結果セットの範囲として表現される）
```

### UC9: 異常系・権限不足

登場人物：suzuki-support（`warehouse-viewer`・`warehouse-viewer-all`のいずれも持たない）

```
1. suzuki-support が物流管理向けの在庫照会画面の利用を試みる
2. Order Service・Inventory Serviceは支店アクセスについて権限判断の権威を持たない
   （architecture.md §20）ため、いずれもロールチェックをせずToken Exchangeで中継するのみ
3. Warehouse Service: warehouse-viewerもwarehouse-viewer-allも持たない → 拒否（permission-matrix.md 表5「その他」行）
```

**拒否の見え方**：UC3の「入口（Order Service）でのRBAC拒否」とは異なり、拒否はチェーンの奥（Warehouse Service）で発生する。ただしUC8/UC9はUC4のような隠すべき業務結果を持たない読み取り専用操作のため、Warehouse Serviceからの403はOrder Serviceまで（値を書き換えられることなく）透過的なHTTPエラーとして伝播し、frontend（BFF）まで届く。外形上（HTTPステータスがfrontendまで403として伝わる点）はUC3と区別が付かないが、拒否が発生する層が異なる。UC9はこの画面を利用する資格自体が無いケースであり、UC10（資格はあるが見える範囲が自分の支店に絞られるケース）とは異なる種類の制限である。
