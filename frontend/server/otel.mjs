// Nuxt/Nitroサーバー（委任チェーンの最初のホップ）向けのOpenTelemetryブートストラップ。
//
// このファイルはNodeの`--import`フラグ経由で読み込まれる（Dockerfile CMD参照）。
// これによりNitro/Nuxt自身のモジュールグラフが読み込まれる前にランタイムへ
// パッチを当てられる。意図的にNitroの`server/plugins/`プラグインにはしていない：
// そちらは`--import`ベースのモジュールパッチが他モジュールの読み込み順に
// 確実に先行するには実行が遅すぎる。
//
// `.ts`ではなくプレーンな`.mjs`のままにする必要がある：Nitroのビルドスキャン
// 対象ディレクトリの外にあり、Nitroのビルドでトランスパイルされず、Nodeから
// 直接実行されるため。
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Nitroのビルド成果物（.output/server/index.mjs）は純粋なESM。HttpInstrumentation/
// UndiciInstrumentationは`import-in-the-middle`経由のモジュールロードフックで
// `node:http`/undiciにパッチを当てるが、このフックはESMローダーとしても登録
// しない限りCommonJSの`require()`しか捕まえない。これを省くと`--import`だけでは
// Nitro自身のグラフ内の`import`が一切パッチされず、受信リクエストのスパンが
// 生成されなくなる（実機で確認済み。詳細はdocs/insights.md）。`module.register()`
// は@opentelemetry/instrumentationのREADMEが案内する非推奨版CLIフラグ
// （--experimental-loader）の、非推奨ではない現代的な代替(Node 20.6+/18.19+)で
// あり、このファイルが計装対象モジュールをimportするより前に実行する必要がある。
register("@opentelemetry/instrumentation/hook.mjs", pathToFileURL("./"));

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// OTelの設定はNitroのruntimeConfig経由ではなく、process.envから直接読む：
// NitroはNUXT_<KEY>形式の環境変数でしかruntimeConfigを上書きしないため、素の
// OTEL_*という名前は実行時に反映されない。
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
const serviceName = process.env.OTEL_SERVICE_NAME || "frontend";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  // otel-lgtmの4318番（OTLP/HTTP）ポート向けのhttp/protobufエクスポーター。
  // OTLPのシグナルパス(/v1/traces)をベースエンドポイントに付与する。
  traceExporter: new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
  }),
  // HttpInstrumentation：Nitro/Node HTTPサーバーへの受信リクエストのルートスパンを
  // 生成する。UndiciInstrumentation：callDownstream()がorder/employeeサービスへ
  // 発行するネイティブ`fetch()`呼び出しにスパンとW3C `traceparent`注入を行う。
  // ignoreIncomingRequestHookはcomposeのヘルスチェックが叩く/api/me（5秒ごと）を
  // 除外する。パス一律の除外にはできない：app.vue自身のセッション確認
  // （ページ読み込みごとの`useFetch("/api/me")`）が同じルートを実際に叩くため、
  // ヘルスチェック側にX-Health-Checkヘッダー（compose.yml）を付けて区別している。
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => req.headers["x-health-check"] === "1",
    }),
    new UndiciInstrumentation(),
  ],
  // NodeSDKの既定のpropagatorはW3C TraceContext + Baggage
  // （@opentelemetry/sdk-node 0.205.0で確認済み）で、下流のJava/Go/Rust/Python
  // 各サービスが期待するtraceparent形式そのもの。上書きは不要。
});

sdk.start();

// シャットダウン時にスパンをflushし、コンテナ停止時に処理中のトレースが
// 失われないようにする。
const shutdown = () => {
  sdk.shutdown().finally(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
