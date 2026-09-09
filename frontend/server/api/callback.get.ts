import * as jose from "jose";
import { consumePendingLogin } from "../utils/pkce";
import { createSession, setSessionCookie } from "../utils/session";
import { createDPoPProof, generateDPoPKeyPair } from "../utils/dpop";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const query = getQuery(event);
  const code = query.code as string | undefined;
  const state = query.state as string | undefined;

  if (!code || !state) {
    throw createError({ statusCode: 400, statusMessage: "Missing code or state" });
  }

  const pending = consumePendingLogin(state);
  if (!pending) {
    throw createError({ statusCode: 400, statusMessage: "Unknown or expired login state" });
  }

  const dpopKeyPair = await generateDPoPKeyPair();
  const tokenEndpoint = `${config.keycloakInternalUrl}/protocol/openid-connect/token`;

  const dpopProof = await createDPoPProof(dpopKeyPair, "POST", tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: "frontend",
    client_secret: config.frontendClientSecret,
    code,
    redirect_uri: `${config.publicOrigin}/api/callback`,
    code_verifier: pending.codeVerifier,
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
      statusMessage: `Token endpoint rejected authorization code: ${errorBody}`,
    });
  }

  const tokens = (await response.json()) as TokenResponse;

  const jwks = jose.createRemoteJWKSet(
    new URL(`${config.keycloakInternalUrl}/protocol/openid-connect/certs`),
  );
  const { payload } = await jose.jwtVerify(tokens.access_token, jwks);

  const username = payload.preferred_username as string;
  const realmAccess = payload.realm_access as { roles?: string[] } | undefined;
  const roles = realmAccess?.roles ?? [];

  const sessionId = createSession({
    username,
    roles,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    dpopKeyPair,
  });

  setSessionCookie(event, sessionId);
  return sendRedirect(event, "/");
});
