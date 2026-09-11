import { requireSession } from "../../utils/session";
import { exchangeForAudience } from "../../utils/tokenExchange";
import { callDownstream } from "../../utils/dpop";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const session = requireSession(event);
  const username = getRouterParam(event, "username");

  const employeeServiceToken = await exchangeForAudience(
    session,
    config.keycloakInternalUrl,
    config.frontendClientSecret,
    "employee-service",
    "employee",
  );

  const response = await callDownstream(
    session.dpopKeyPair,
    "GET",
    `${config.employeeServiceBaseUrl}/employees/${username}`,
    employeeServiceToken,
  );

  if (!response.ok) {
    throw createError({ statusCode: response.status, statusMessage: await response.text() });
  }

  return response.json();
});
