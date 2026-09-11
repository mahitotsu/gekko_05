# ADR 0007: 委任トポロジー制御をoptional client scopeのみで実現（Client Policies不要）

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

「誰が誰に委任できるか」というホップのトポロジー（例: warehouse-service向け交換を要求できるのは inventory-service のみ）をKeycloak側でどう強制するかを決める必要があった。候補は optional client scope の割当と、Client Policies（`reject-request` 実行アクション、クライアントロールのマーカー等）。

## Decision

各保護対象スコープを、許可されたクライアントにのみ **optional client scope** として付与する。**Client Policies は使わない**。

| 保護するスコープ | 付与するクライアント |
|---|---|
| `inventory` | order-service |
| `warehouse` | inventory-service |
| `employee` | warehouse-service |

## Consequences

- Keycloak 26.4.7 で実機検証済み。許可されていないホップ飛び越し・スコープ偽装の双方が拒否されることを確認した。
- スコープ絞り込みという要件を満たすための optional client scope 割当が、副産物として委任トポロジー制御も担う。追加の Client Policies は不要と判明。
- DPoP（ADR 0006）で使用する `dpop-bind-enforcer` 実行アクションは Client Policies の機能を引き続き使用するが、これはトポロジー制御とは別目的。
