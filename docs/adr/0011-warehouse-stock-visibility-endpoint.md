# ADR 0011: 在庫照会を「支店指定」から「見える範囲を返す」設計に変更（UC8/UC9/UC10）

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

UC8/UC9 実装時、Order Service の `WarehouseStockController` と Inventory Service の `/warehouse-stock` ルートの両方が Warehouse Service 固有のロール（`warehouse-viewer`/`warehouse-viewer-all`）を直接チェックしていた。「Warehouse Service 側のロール体系が変われば Order Service/Inventory Service も追随変更が必要」という結合が生じており、[services.md](../services.md) が定める層の責務と矛盾していた。

エンドポイントを「支店 X の在庫は？（→ 権限がなければ 403）」という形のままにした場合、2つの代替案を検討した:
1. **Inventory Service が Warehouse Service の 403 を正常応答（在庫 0 件等）にすり替える** — 本当は在庫があるのに 0 件と返すことになり虚偽になるため不採用。
2. **Inventory Service にアクセス権のある倉庫から在庫を選ぶルーティング知能を持たせる** — アクセス権制御という本サンプルの核（§1）を迂回し、かつ実際に複数支店を選べるテストユーザーが存在しないため不採用。

## Decision

在庫照会エンドポイントの問いの形を変える。

- **旧**: `GET /warehouse/:branch/stock/:product_id`（支店を呼び出し元が指定）→ 権限がなければ 403
- **新**: `GET /warehouse/stock/:product_id`（支店をパスに含めない）→ 常に 200。**自分が見える支店の在庫のみを返す**

Warehouse Service が認可判断の唯一の権威であり、Order Service・Inventory Service はロールチェックを一切行わず中継に徹する。

## Consequences

- ABAC 不一致（UC10）が 403 ではなく空集合として返るようになり、すり替え問題自体が消滅。
- 残る UC9 の 403（ロールが全く無い）は UC3/UC7 と同種の「対象外のユーザー」エラーとして、Order Service まで透過的に伝播する。
- Order Service・Inventory Service がこの機能について中継に徹することは、frontend の Keycloak クライアントに `inventory`・`warehouse` スコープのトークンを取得する手段がそもそも存在しない（委任トポロジーの制約）という構造と一致しており、矛盾しない。
