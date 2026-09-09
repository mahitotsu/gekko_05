import { getBffSession, getSessionIdFromCookie } from "../utils/session";

export default defineEventHandler((event) => {
  const session = getBffSession(getSessionIdFromCookie(event));
  if (!session) {
    return { loggedIn: false as const };
  }
  return { loggedIn: true as const, username: session.username, roles: session.roles };
});
