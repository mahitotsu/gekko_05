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
 * BFFがユーザーに代わってこれから行うリクエスト（Keycloakのtokenエンドポイント
 * 宛、あるいはDPoP-boundなアクセストークンを受け取るリソースサーバー宛）向けに
 * RFC 9449のDPoP Proofを組み立てる。BFF化（architecture.md §17）以前はブラウザ側の
 * oidc-client-tsが行っていたのと同じ処理だが、鍵ペアは今やサーバーサイドにのみ
 * 存在し、ブラウザのJSに公開されることは一切ない。
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
 * DPoP-boundなアクセストークンで下流のリソースサーバーを呼び出す。Token Exchangeは
 * subject tokenから`cnf.jkt`の紐付けをそのまま引き継ぐ（セッションの元のログイン
 * 時と同じ鍵）ため、ここでも新しい鍵ペアではなく同じ鍵ペアを再利用する必要がある。
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
