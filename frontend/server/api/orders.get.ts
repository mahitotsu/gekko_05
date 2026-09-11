import { requireSession } from "../utils/session";
import { exchangeForAudience } from "../utils/tokenExchange";
import { callDownstream } from "../utils/dpop";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const session = requireSession(event);

  const orderServiceToken = await exchangeForAudience(
    session,
    config.keycloakInternalUrl,
    config.frontendClientSecret,
    "order-service",
    "order",
  );

  const response = await callDownstream(
    session.dpopKeyPair,
    "GET",
    `${config.orderServiceBaseUrl}/orders`,
    orderServiceToken,
  );

  if (!response.ok) {
    throw createError({ statusCode: response.status, statusMessage: await response.text() });
  }

  return response.json();
});
