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

- mTLS はサービスメッシュ前提でインフラコストが重く、docker-compose 環境に不適。本番導入時の選択肢として付記するに留める。
- 内部チェーンのトークンは Docker private network 内にのみ存在し、ブラウザや外部ネットワークには出ない。frontend クライアントのトークンとは脅威モデルが異なるため DPoP の適用対象として優先度が低い。
- 内部トークンが漏洩した場合でも `aud` クレームで提示可能サービスが1つに限定される。`aud` 一致サービスへの直接再提示というリスクは、短 TTL（60秒）で緩和する。
- 仮に内部トークンが盗まれてもそのクライアントの認証情報がなければ Token Exchange で先に進めない。クライアント認証情報まで侵害された時点でトークン再利用より大きな問題になっており、DPoP の追加効果は限定的。
- **DPoPの送信者拘束はToken Exchangeを跨いで伝播する**：`cnf.jkt`が交換後トークンに付与されるかどうかは、Token Exchangeの呼び出し元クライアント自身に`dpop.bound.access.tokens: true`が設定されているかで決まる（グラント種別に関係なく、そのクライアントへ発行される全トークンに適用される。実際にToken Exchange呼び出しを実装して初めて判明した——以前は「Token Exchangeで得る内部トークンには`cnf`が付与されない」と誤って想定していた）。Order/Inventory/Warehouse Serviceの各クライアントはこの属性を持たないため交換後トークンは非DPoPになるが、frontendクライアント（この属性を持つ）が自ら行うToken Exchangeでは交換後トークンにも`cnf.jkt`が継承される。そのためBFFがOrder/Employee Serviceへ渡す交換後トークンはDPoPで送信する必要がある（`server/utils/dpop.ts`の`callDownstream()`。Proofの`ath`は実際に送信する交換後トークンのSHA-256ハッシュにする点に注意）。実機検証済み：①DPoP Proof無しでのログイン試行は`DPoP proof is missing`で拒否 ②発行されたトークンを漏洩想定でDPoP Proof無しに素の`Bearer`として再送すると401で拒否（サーバー側の送信者拘束が機能している証拠）。
- **交換後トークンのTTLは交換を要求した側（`azp`）のクライアント属性で決まる**：`access.token.lifespan`はクライアント属性としてrealmデフォルトの`accessTokenLifespan`を上書きできるが、Token Exchange V2で発行されるトークンにどちらのクライアント（要求側／audience側）の属性が適用されるかはドキュメントに明記が無く、実機で確認した。`order-service`クライアントにのみ`access.token.lifespan: "45"`を設定し、`inventory-service`（audience側、属性なし）へのToken Exchangeを実行すると、発行トークンの`expires_in`は45（realmデフォルトの300ではない）——**交換を要求したクライアント（`azp`となるクライアント、＝`client_id`/`client_secret`で認証した側）の属性がそのまま適用される**。audience側クライアントの同属性は無関係。上記の「TTL 60秒への短縮」を実現するには、委任チェーンでToken Exchangeを要求する3クライアント（order-service/inventory-service/warehouse-service）それぞれに`access.token.lifespan: "60"`を設定する必要がある。1箇所（例えば末端のemployee-service）に設定しても、そのクライアントが要求元にならないホップには効かない。
