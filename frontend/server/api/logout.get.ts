import { clearSessionCookie, deleteSession, getBffSession, getSessionIdFromCookie } from "../utils/session";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const sessionId = getSessionIdFromCookie(event);
  const session = getBffSession(sessionId);
  deleteSession(sessionId);
  clearSessionCookie(event);

  // BFFセッションの破棄だけではKeycloakのSSOセッションが残り、次回ログイン時に
  // 同じユーザーとして自動的に再認証されてしまう。Keycloakのend-sessionエンド
  // ポイントへリダイレクトしてSSOセッションも終了させる。
  const logoutUrl = new URL(`${config.keycloakPublicUrl}/protocol/openid-connect/logout`);
  logoutUrl.searchParams.set("client_id", "frontend");
  logoutUrl.searchParams.set("post_logout_redirect_uri", `${config.publicOrigin}/`);
  if (session?.idToken) {
    logoutUrl.searchParams.set("id_token_hint", session.idToken);
  }
  return sendRedirect(event, logoutUrl.toString());
});
