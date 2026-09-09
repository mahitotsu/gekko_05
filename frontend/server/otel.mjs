// OpenTelemetry bootstrap for the Nuxt/Nitro server (the first hop in the chain).
//
// This file is loaded via Node's `--import` flag (see Dockerfile CMD) so it runs
// and patches the runtime BEFORE Nitro/Nuxt's own module graph loads. It is
// deliberately NOT a Nitro `server/plugins/` plugin: those run too late for
// `--import`-based module patching to reliably beat other modules' load order.
//
// It must stay plain `.mjs` (not `.ts`) because it lives outside Nitro's build
// scan dirs and is executed directly by Node, not transpiled by the Nitro build.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Nitro's build output (.output/server/index.mjs) is pure ESM. HttpInstrumentation/
// UndiciInstrumentation patch `node:http`/undici by hooking module loads via
// `import-in-the-middle`, but that hook only intercepts CommonJS require() unless
// it's also registered as an ESM loader -- without this, `--import` alone silently
// leaves every core-module `import` in Nitro's own graph unpatched: no incoming-request
// span is ever created (confirmed empirically -- ["http.createServer.__wrapped"] stayed
// undefined and zero spans reached Tempo, even for real, non-healthcheck traffic), which
// in turn meant frontend never extracted/forwarded edge-proxy's traceparent, so every
// downstream call from it started as a *new* trace instead of continuing the real one.
// See @opentelemetry/instrumentation's README ("The custom hook for ESM instrumentation
// is --experimental-loader=@opentelemetry/instrumentation/hook.mjs") -- module.register()
// is the modern, non-deprecated equivalent (Node 20.6+/18.19+) of that CLI flag, and
// must run before anything else in this file imports the modules being instrumented.
register("@opentelemetry/instrumentation/hook.mjs", pathToFileURL("./"));

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Read OTel config from process.env directly, NOT via Nitro runtimeConfig:
// Nitro only overrides runtimeConfig from NUXT_<KEY> env vars, and these plain
// OTEL_* names would not be picked up at runtime.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
const serviceName = process.env.OTEL_SERVICE_NAME || "frontend";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  // http/protobuf exporter against otel-lgtm's 4318 OTLP/HTTP port. The OTLP
  // signal path (/v1/traces) is appended to the base endpoint.
  traceExporter: new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
  }),
  // HttpInstrumentation: root spans for incoming requests to the Nitro/Node HTTP
  // server. UndiciInstrumentation: spans + W3C `traceparent` injection for the
  // outgoing native `fetch()` calls in callDownstream() to order/employee services.
  // ignoreIncomingRequestHook skips the compose healthcheck's request to /api/me
  // (hit every 5s). It can't be a blanket path exclusion: app.vue's own session
  // check (`useFetch("/api/me")` on every page load) hits the same route for real,
  // so the healthcheck is marked with an X-Health-Check header (compose.yml) instead.
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => req.headers["x-health-check"] === "1",
    }),
    new UndiciInstrumentation(),
  ],
  // NodeSDK's default propagator is W3C TraceContext + Baggage (verified against
  // @opentelemetry/sdk-node 0.205.0), which is exactly the traceparent format the
  // downstream Java/Go/Rust/Python services expect. No override needed.
});

sdk.start();

// Flush spans on shutdown so in-flight traces aren't lost when the container stops.
const shutdown = () => {
  sdk.shutdown().finally(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
