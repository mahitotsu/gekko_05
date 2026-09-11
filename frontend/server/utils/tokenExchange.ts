import { createDPoPProof } from "./dpop";
import type { Session } from "./session";

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

// トークンの実際の有効期限より少し早めに再交換する。ネットワーク遅延やクロック
// ずれがあっても、キャッシュから返した直後に下流サービス側で期限切れとして
// 拒否される事態を避けるための安全マージン。
const CACHE_SAFETY_MARGIN_SECONDS = 5;

async function requestTokenExchange(
  keycloakInternalUrl: string,
  clientSecret: string,
  session: Session,
  audience: string,
  scope: string,
): Promise<TokenResponse> {
  const tokenEndpoint = `${keycloakInternalUrl}/protocol/openid-connect/token`;
  const dpopProof = await createDPoPProof(session.dpopKeyPair, "POST", tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: session.accessToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    audience,
    scope,
    client_id: "frontend",
    client_secret: clientSecret,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      DPoP: dpopProof,
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw createError({
      statusCode: 502,
      statusMessage: `Token exchange for audience=${audience} failed: ${errorBody}`,
    });
  }

  return (await response.json()) as TokenResponse;
}

/**
 * ユーザーのfrontend向けアクセストークン（RFC 8693）を、単一の下流サービス向けに
 * 絞り込んだトークンへ交換する。`frontend`クライアント自身として振る舞う。
 * `frontend`クライアントはDPoP-boundなため（keycloak/realm-export.json参照）、
 * Keycloakはこのtokenエンドポイント呼び出しにもDPoP Proofを要求する。交換後の
 * トークンもDPoP-boundのまま返ってくる（subject tokenからcnf.jktが引き継がれ、
 * 元のセッションと同じ鍵になる）——呼び出し元は素のBearerヘッダーではなくDPoPで
 * 提示する必要がある。./dpopのcallDownstream()を参照。
 *
 * 交換結果はセッションごと・audienceごとにキャッシュし、有効期限内は同じ
 * トークンを使い回す。これによりリクエストのたびにKeycloakへ交換を要求せずに
 * 済む一方、監査（audit/audit.py CHECK2）から見ても「Keycloakが発行した記録の
 * あるトークンが再利用されているだけ」であり、正当なアクセスとして扱われる
 * （docs/adr/0012参照）。
 */
export async function exchangeForAudience(
  session: Session,
  keycloakInternalUrl: string,
  clientSecret: string,
  audience: string,
  scope: string,
): Promise<string> {
  const cached = session.exchangedTokens.get(audience);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const tokens = await requestTokenExchange(keycloakInternalUrl, clientSecret, session, audience, scope);
  session.exchangedTokens.set(audience, {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in - CACHE_SAFETY_MARGIN_SECONDS) * 1000,
  });
  return tokens.access_token;
}
