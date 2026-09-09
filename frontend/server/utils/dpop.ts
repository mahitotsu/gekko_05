import * as jose from "jose";
import { createHash, randomUUID } from "node:crypto";

export type DPoPKeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };

export async function generateDPoPKeyPair(): Promise<DPoPKeyPair> {
  const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
  return { publicKey, privateKey };
}

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Builds an RFC 9449 DPoP proof for a request the BFF is about to make on the
 * user's behalf (to Keycloak's token endpoint, or to a resource server holding the
 * DPoP-bound access token). Mirrors what the browser-side oidc-client-ts used to do
 * before the BFF migration (DESIGN.md §19/§22) -- the key pair now lives server-side
 * instead, so it's never exposed to browser JS at all.
 */
export async function createDPoPProof(
  keyPair: DPoPKeyPair,
  httpMethod: string,
  url: string,
  accessToken?: string,
): Promise<string> {
  const publicJwk = await jose.exportJWK(keyPair.publicKey);

  const payload: Record<string, unknown> = {
    jti: randomUUID(),
    htm: httpMethod,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };
  if (accessToken) {
    payload.ath = base64UrlSha256(accessToken);
  }

  return new jose.SignJWT(payload)
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
    .sign(keyPair.privateKey);
}

/**
 * Calls a downstream resource server with a DPoP-bound access token. Token Exchange
 * carries the `cnf.jkt` binding forward from the subject token (same key as the
 * session's original login), so this must reuse that same key pair, not a fresh one.
 */
export async function callDownstream(
  keyPair: DPoPKeyPair,
  method: string,
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const dpopProof = await createDPoPProof(keyPair, method, url, accessToken);
  return fetch(url, {
    ...init,
    method,
    headers: {
      ...init.headers,
      Authorization: `DPoP ${accessToken}`,
      DPoP: dpopProof,
    },
  });
}
