import { requireSession } from "../utils/session";
import { exchangeForAudience } from "../utils/tokenExchange";
import { callDownstream } from "../utils/dpop";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const session = requireSession(event);
  const body = await readBody(event);

  const orderServiceToken = await exchangeForAudience(
    config.keycloakInternalUrl,
    config.frontendClientSecret,
    session.dpopKeyPair,
    session.accessToken,
    "order-service",
    "order",
  );

  const response = await callDownstream(
    session.dpopKeyPair,
    "POST",
    `${config.orderServiceBaseUrl}/orders`,
    orderServiceToken,
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );

  if (!response.ok) {
    throw createError({ statusCode: response.status, statusMessage: await response.text() });
  }

  setResponseStatus(event, response.status);
  return response.json();
});
