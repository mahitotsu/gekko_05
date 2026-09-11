# ADR 0006: トークン送信者拘束にDPoPを採用（mTLSは不採用、内部チェーンは短TTLで代替）

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

ベアラートークン一般の漏洩・再提示リスク（漏洩したトークンは提示者を選ばず受理される）への対策手段を決める必要があった。候補は DPoP（RFC 9449）と mTLS（RFC 8705）。また、送信者拘束の適用範囲（frontend のみか内部サービス間チェーンも含むか）を決める必要があった。

## Decision

- **DPoP（RFC 9449）** を **frontend のみ** に適用する。
- 内部委任チェーン（Order→Inventory→Warehouse→Employee）のトークンには DPoP を適用せず、**TTL 60秒への短縮**で脅威を緩和する。
- **mTLS（RFC 8705）は不採用**（本サンプルのスコープ外）。

## Consequences

| 観点 | 内容 |
|---|---|
| mTLSとの比較 | サービスメッシュ前提でインフラコストが重く、docker-compose 環境に不適。本番導入時の選択肢として付記するに留める |
| 内部チェーンの脅威モデル | 内部チェーンのトークンは Docker private network 内にのみ存在し、ブラウザや外部ネットワークには出ない。frontend クライアントのトークンとは脅威モデルが異なるため DPoP の適用対象として優先度が低い |
| 内部トークン漏洩時の残存リスク | `aud` クレームで提示可能サービスが1つに限定される。`aud` 一致サービスへの直接再提示というリスクは、短 TTL（60秒）で緩和する |
| クライアント認証情報侵害時 | 内部トークンが盗まれてもそのクライアントの認証情報がなければ Token Exchange で先に進めない。認証情報まで侵害された時点でトークン再利用より大きな問題になっており、DPoP の追加効果は限定的 |
| DPoPの伝播ルール | `cnf.jkt`が交換後トークンに付与されるかは、Token Exchangeの呼び出し元クライアント自身に`dpop.bound.access.tokens: true`が設定されているかで決まる（グラント種別とは無関係）。Order/Inventory/Warehouse Serviceはこの属性を持たないため交換後トークンは非DPoPになるが、frontendが自ら行うToken Exchangeでは`cnf.jkt`が継承される。そのためBFFがOrder/Employee Serviceへ渡す交換後トークンはDPoPで送信する必要がある（`server/utils/dpop.ts`の`callDownstream()`）。実機検証済み：DPoP Proof無しのログイン試行は拒否、漏洩想定でのBearer再送は401で拒否 |
| TTLの決定要因 | Token Exchange V2で発行されるトークンのTTLは**交換を要求した側（`azp`）のクライアント属性**が効く（audience側クライアントの同属性は無関係、実機で確認）。委任チェーンでToken Exchangeを要求する3クライアント（order-service/inventory-service/warehouse-service）それぞれに`access.token.lifespan: "60"`を設定する必要がある |
