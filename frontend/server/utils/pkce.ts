import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface PendingLogin {
  codeVerifier: string;
  createdAt: number;
}

/**
 * OAuthの`state`パラメータをキーにする。ログインフロー中のみ生存する短命な
 * データなので、素のインメモリMapで十分——./session.tsと同じ「コンテナ1台」
 * という前提に基づく。
 */
const pendingLogins = new Map<string, PendingLogin>();

const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function startPendingLogin(codeVerifier: string): string {
  const state = randomUUID();
  pendingLogins.set(state, { codeVerifier, createdAt: Date.now() });
  return state;
}

export function consumePendingLogin(state: string | undefined | null): PendingLogin | undefined {
  if (!state) return undefined;
  const entry = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > PENDING_LOGIN_TTL_MS) return undefined;
  return entry;
}
