# ADR 0013: Token Exchange結果をsubject jti単位でキャッシュする

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

これまで各サービスは、下流呼び出しのたびに毎回Token Exchangeを実行していた（1リクエスト＝1回のKeycloak往復）。[ADR 0012](0012-jti-audience-correlation-for-token-exchange-audit.md)では「委任チェーンの中継トークンをキャッシュして複数リクエストに跨って再利用しても、監査の`(jti, audience)`相関は偽陽性を出さない」と設計上主張したが、これは理論上の議論に留まり、実際にキャッシュを実装して検証してはいなかった。説得力を持たせるため、実際にキャッシュ機構を導入し、監査ツールが正しく振る舞うことを実データで確認する。

## Decision

**frontend（TypeScript）とorder-service（Java）の2箇所にキャッシュを実装する。**

- キャッシュキー：`(subjectトークンのjti, audience)`
  - frontendはセッションオブジェクトに`Map<audience, CachedToken>`を持たせる（`session.exchangedTokens`）。セッションと寿命を共にするため、ログアウト・セッション破棄で自然に消える
  - order-serviceはプロセス共有の`ConcurrentHashMap<CacheKey, CachedToken>`（`CacheKey = (subjectJti, audience)`）を`TokenExchangeClient`に持たせる
- **有効期限判定**：Keycloakのトークンエンドポイントが返す`expires_in`をそのまま使う。JWTを自前でデコードする必要がない。実際の期限より`CACHE_SAFETY_MARGIN_SECONDS`（5秒）早めに再交換し、ネットワーク遅延やクロックずれによる「キャッシュから返した直後に下流で期限切れ」を避ける
- **対象外**：inventory-service（Go）・warehouse-service（Rust）には今回実装しない。同じパターンの横展開であり難易度は変わらないが、実装コスト対効果を優先した。特にwarehouse-serviceはOTel/axumまわりの依存関係がすでに脆く（`insights.md`参照）、新しい非同期キャッシュロジックを足すリスクが見合わないと判断した

## Consequences

- frontendの中継トークン（audience=order-service/employee-service）はrealmデフォルトのTTL（委任チェーン内の60秒短縮の対象外、architecture.md §8）で、order-serviceの中継トークン（audience=inventory-service）は60秒TTLでキャッシュされる。後者は「短命トークンでもキャッシュ有効期限を正しく守れば安全に使い回せる」という、監査にとって最も厳しい条件での検証になる
- frontendがorder-service向けトークンをキャッシュする結果、order-serviceが受け取る`jti`は同一セッション内で安定する。これによりorder-service自身のキャッシュ（audience=inventory-service）も、異なるエンドポイント（`/orders`のPOST、`/warehouse-stock/{id}`のGET）にまたがって同じキャッシュキーでヒットするようになり、当初想定していなかった副次的な集約効果が生まれた（実測：`docs/audit-demo.md`参照）
- **実データで検証済み**：同一エンドポイントを連続で呼ぶシナリオ（`audit/scenario.py`）で、2回のHTTPリクエスト（＝異なるtrace_id）が同一jtiを使い回すことをログで確認した。この状態で監査（`audit/audit.py`）を実行し、CHECK2が偽陽性を出さないこと（キャッシュ再利用は正当なアクセスとして扱われる）を確認した。旧`trace_id`相関のままだったら、2回目のリクエストは新しいtrace_idを持つのに対応するTOKEN_EXCHANGEイベントが存在せず「未記録」として誤検知していたはずのケース。詳細と実行結果は[audit-demo.md](../audit-demo.md)を参照
- inventory-service・warehouse-serviceの間（audience=warehouse-service/employee-service）は引き続きリクエストのたびにToken Exchangeを行う。将来これらもキャッシュする場合、同じ設計（`(subjectJti, audience)`キー＋`expires_in`ベースの期限管理）をそのまま横展開できる
