import { clearSessionCookie, deleteSession, getSessionIdFromCookie } from "../utils/session";

export default defineEventHandler((event) => {
  const sessionId = getSessionIdFromCookie(event);
  deleteSession(sessionId);
  clearSessionCookie(event);
  return sendRedirect(event, "/");
});
