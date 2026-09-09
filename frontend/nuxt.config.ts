// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  ssr: true,
  nitro: {
    port: 3000,
  },
  runtimeConfig: {
    // Server-only (not prefixed with `public`, so never exposed to the browser bundle).
    // These are just local-dev fallback values -- Nitro overrides each one at server
    // startup (not build time) from the matching NUXT_<KEY> env var, e.g.
    // NUXT_KEYCLOAK_INTERNAL_URL (see compose.yml). Plain, unprefixed env vars are
    // NOT picked up here since nuxt.config.ts itself only runs at build time.
    keycloakInternalUrl: "http://localhost:8080/realms/kikan-system",
    keycloakPublicUrl: "http://localhost:3000/realms/kikan-system",
    frontendClientSecret: "frontend-secret",
    publicOrigin: "http://localhost:3000",
    orderServiceBaseUrl: "http://localhost:8081",
    employeeServiceBaseUrl: "http://localhost:8084",
    sessionSecret: "dev-only-insecure-secret-change-me",
  },
});
