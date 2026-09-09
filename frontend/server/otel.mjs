// OpenTelemetry bootstrap for the Nuxt/Nitro server (the first hop in the chain).
//
// This file is loaded via Node's `--import` flag (see Dockerfile CMD) so it runs
// and patches the runtime BEFORE Nitro/Nuxt's own module graph loads. It is
// deliberately NOT a Nitro `server/plugins/` plugin: those run too late for
// `--import`-based module patching to reliably beat other modules' load order.
//
// It must stay plain `.mjs` (not `.ts`) because it lives outside Nitro's build
// scan dirs and is executed directly by Node, not transpiled by the Nitro build.
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
  instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
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
