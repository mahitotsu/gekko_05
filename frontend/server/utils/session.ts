import { randomUUID } from "node:crypto";
import type { H3Event } from "h3";
import type { DPoPKeyPair } from "./dpop";

export const SESSION_COOKIE_NAME = "gekko_session";

export interface CachedExchangedToken {
  accessToken: string;
  /** epoch ms。この時刻を過ぎたら再度Token Exchangeを行う。 */
  expiresAt: number;
}

export interface Session {
  username: string;
  roles: string[];
  accessToken: string;
  refreshToken?: string;
  dpopKeyPair: DPoPKeyPair;
  createdAt: number;
  /**
   * audience文字列をキーに、Token Exchange済みトークンをキャッシュする
   * （`utils/tokenExchange.ts`の`exchangeForAudience`が読み書きする）。
   * セッションと同じ寿命を持たせることで、ログアウト・セッション破棄と同時に
   * キャッシュも自然に消える。
   */
  exchangedTokens: Map<string, CachedExchangedToken>;
}

/**
 * セッションはこのプロセスのメモリ内にのみ存在する——本サンプルではNuxtコンテナが
 * 常に1台だけなので、共有ストア（Redis等）は不要。これは裏を返せばfrontend
 * コンテナを再起動すると全ユーザーがログアウトすることを意味するが、ローカル
 * デモとしては許容範囲。
 */
const sessions = new Map<string, Session>();

export function createSession(data: Omit<Session, "createdAt" | "exchangedTokens">): string {
  const sessionId = randomUUID();
  sessions.set(sessionId, { ...data, createdAt: Date.now(), exchangedTokens: new Map() });
  return sessionId;
}

export function getBffSession(sessionId: string | undefined | null): Session | undefined {
  if (!sessionId) return undefined;
  return sessions.get(sessionId);
}

export function deleteSession(sessionId: string | undefined | null): void {
  if (!sessionId) return;
  sessions.delete(sessionId);
}

export function setSessionCookie(event: H3Event, sessionId: string): void {
  setCookie(event, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
  });
}

export function getSessionIdFromCookie(event: H3Event): string | undefined {
  return getCookie(event, SESSION_COOKIE_NAME);
}

export function clearSessionCookie(event: H3Event): void {
  deleteCookie(event, SESSION_COOKIE_NAME, { path: "/" });
}

export function requireSession(event: H3Event): Session {
  const sessionId = getSessionIdFromCookie(event);
  const session = getBffSession(sessionId);
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Not logged in" });
  }
  return session;
}
