# ADR 0008: realm-export.jsonを意図的変更項目のみの縮小版で記述

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

Keycloak 設定をコードとして管理する際、`realm-export.json` に何を書くかを決める必要があった。Keycloak の完全設定ダンプを書くか、意図して追加・変更した項目のみを書くかの選択。

## Decision

`realm-export.json` には **意図して追加・変更した項目のみ**を記述する（realm 本体、client scope 4種とaudienceマッパー、client 5種とその設定、テストユーザー4件）。

## Consequences

- Keycloak は指定しなかったフィールドを自身のデフォルト値で補う（`{"realm":"...","enabled":true}` だけのリクエストで realm が正しく作成されることを確認済み）。
- 完全ダンプには OTP ポリシーやセッションタイムアウト等、一度も検討していない大量のデフォルト値が含まれ、どこが自分たちの決定かをレビューで判別できなくなる。
- フルエクスポート比で約 1/6 のサイズで `docker compose up --build` から Hop1/Hop2 成功・未許可経路の拒否まで再現できることを確認済み。
- **`clientScopes`を明示指定すると組み込みscopeが一切マージされない**：realm importでは（単純な`POST /admin/realms`でのrealm作成と異なり）`clientScopes`を明示指定すると、Keycloak組み込みの`roles`/`profile`等は一切マージされない。これにより以下を自分で明示する必要があった。
  - `sub`クレーム：組み込みでは自動的に付与されず、`oidc-sub-mapper`を`roles`スコープに追加する必要がある（実機で確認：追加前はaccess_tokenに`sub`が一切含まれずToken Exchange時の記録が取れなかった）
  - 所属支店のような社員情報：`roles`スコープに`oidc-usermodel-property-mapper`を追加しないと`preferred_username`以外のクレームが載らない
