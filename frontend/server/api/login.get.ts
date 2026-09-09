import { generatePkcePair, startPendingLogin } from "../utils/pkce";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig();

  const { codeVerifier, codeChallenge } = generatePkcePair();
  const state = startPendingLogin(codeVerifier);

  const authorizeUrl = new URL(`${config.keycloakPublicUrl}/protocol/openid-connect/auth`);
  authorizeUrl.searchParams.set("client_id", "frontend");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid roles");
  authorizeUrl.searchParams.set("redirect_uri", `${config.publicOrigin}/api/callback`);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return sendRedirect(event, authorizeUrl.toString());
});
