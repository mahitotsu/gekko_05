import { createDPoPProof, type DPoPKeyPair } from "./dpop";

interface TokenResponse {
  access_token: string;
}

/**
 * ユーザーのfrontend向けアクセストークン（RFC 8693）を、単一の下流サービス向けに
 * 絞り込んだトークンへ交換する。`frontend`クライアント自身として振る舞う。
 * `frontend`クライアントはDPoP-boundなため（keycloak/realm-export.json参照）、
 * Keycloakはこのtokenエンドポイント呼び出しにもDPoP Proofを要求する。交換後の
 * トークンもDPoP-boundのまま返ってくる（subject tokenからcnf.jktが引き継がれ、
 * 元のセッションと同じ鍵になる）——呼び出し元は素のBearerヘッダーではなくDPoPで
 * 提示する必要がある。./dpopのcallDownstream()を参照。
 */
export async function exchangeForAudience(
  keycloakInternalUrl: string,
  clientSecret: string,
  dpopKeyPair: DPoPKeyPair,
  subjectAccessToken: string,
  audience: string,
  scope: string,
): Promise<string> {
  const tokenEndpoint = `${keycloakInternalUrl}/protocol/openid-connect/token`;
  const dpopProof = await createDPoPProof(dpopKeyPair, "POST", tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: subjectAccessToken,
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

  const tokens = (await response.json()) as TokenResponse;
  return tokens.access_token;
}
