import { randomUUID } from "node:crypto";
import type { H3Event } from "h3";
import type { DPoPKeyPair } from "./dpop";

export const SESSION_COOKIE_NAME = "gekko_session";

export interface Session {
  username: string;
  roles: string[];
  accessToken: string;
  refreshToken?: string;
  dpopKeyPair: DPoPKeyPair;
  createdAt: number;
}

/**
 * Sessions live only in this process's memory -- there is exactly one Nuxt
 * container in this sample, so no shared store (Redis etc.) is needed. This
 * also means restarting the frontend container logs everyone out, which is
 * acceptable for a local demo.
 */
const sessions = new Map<string, Session>();

export function createSession(data: Omit<Session, "createdAt">): string {
  const sessionId = randomUUID();
  sessions.set(sessionId, { ...data, createdAt: Date.now() });
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
