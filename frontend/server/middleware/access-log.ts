import { defineEventHandler, getRequestURL } from "h3";
import { trace } from "@opentelemetry/api";
import { getSessionIdFromCookie, getBffSession } from "../utils/session";

function jwtPayload(token: string): Record<string, unknown> {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return {};
  }
}

export default defineEventHandler((event) => {
  // Skip compose healthcheck probes (same header filter as otel.mjs).
  if (event.node.req.headers["x-health-check"] === "1") return;

  const start = Date.now();
  const method = event.method;
  const path = getRequestURL(event).pathname;
  // Capture trace_id while the OTel context is still active (before async hand-off).
  const traceId = trace.getActiveSpan()?.spanContext().traceId ?? "-";

  const session = getBffSession(getSessionIdFromCookie(event));
  const claims = session ? jwtPayload(session.accessToken) : {};
  const sub = (claims["sub"] as string | undefined) ?? "-";
  const jti = (claims["jti"] as string | undefined) ?? "-";

  event.node.res.on("finish", () => {
    process.stdout.write(
      JSON.stringify({
        type: "access_log",
        method,
        path,
        status: event.node.res.statusCode,
        duration_ms: Date.now() - start,
        sub,
        jti,
        trace_id: traceId,
      }) + "\n"
    );
  });
});
