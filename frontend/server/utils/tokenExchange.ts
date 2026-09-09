import { createDPoPProof, type DPoPKeyPair } from "./dpop";

interface TokenResponse {
  access_token: string;
}

/**
 * Exchanges the user's frontend-facing access token (RFC 8693) for a narrower one
 * scoped to a single downstream service, acting as the `frontend` client itself.
 * The `frontend` client is DPoP-bound (see keycloak/realm-export.json), so Keycloak
 * requires a DPoP proof on this token-endpoint call too. The exchanged token comes
 * back DPoP-bound as well (cnf.jkt carried over from the subject token, same key as
 * the original session) -- callers must present it with DPoP, not a plain Bearer
 * header; see callDownstream() in ./dpop.
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
