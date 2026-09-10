// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  ssr: true,
  nitro: {
    port: 3000,
  },
  runtimeConfig: {
    // サーバー専用（`public`プレフィックスが無いためブラウザバンドルには一切
    // 露出しない）。ここにあるのはローカル開発用のフォールバック値に過ぎない
    // ——Nitroはサーバー起動時（ビルド時ではない）に、対応するNUXT_<KEY>形式の
    // 環境変数（例: NUXT_KEYCLOAK_INTERNAL_URL、compose.yml参照）で各値を上書き
    // する。nuxt.config.ts自体はビルド時にしか実行されないため、プレフィックスの
    // 無い素の環境変数はここでは反映されない。
    keycloakInternalUrl: "http://localhost:8080/realms/kikan-system",
    keycloakPublicUrl: "http://localhost:3000/realms/kikan-system",
    frontendClientSecret: "frontend-secret",
    publicOrigin: "http://localhost:3000",
    orderServiceBaseUrl: "http://localhost:8081",
    employeeServiceBaseUrl: "http://localhost:8084",
    sessionSecret: "dev-only-insecure-secret-change-me",
  },
});
