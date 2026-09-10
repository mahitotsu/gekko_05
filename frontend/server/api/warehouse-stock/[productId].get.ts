import { requireSession } from "../../utils/session";
import { exchangeForAudience } from "../../utils/tokenExchange";
import { callDownstream } from "../../utils/dpop";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const session = requireSession(event);
  const productId = getRouterParam(event, "productId");

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
    "GET",
    `${config.orderServiceBaseUrl}/warehouse-stock/${productId}`,
    orderServiceToken,
  );

  if (!response.ok) {
    throw createError({ statusCode: response.status, statusMessage: await response.text() });
  }

  return response.json();
});
