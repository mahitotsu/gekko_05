FROM quay.io/keycloak/keycloak:26.4

# tracing-enabled and health-enabled are both documented as build-time options, but
# `start-dev` re-augments (rebuilds) on every single container start regardless of
# what's baked into the image beforehand -- verified empirically: a `kc.sh build
# --tracing-enabled=true --health-enabled=true` step here had no effect at all, while
# passing the equivalent KC_TRACING_ENABLED/KC_HEALTH_ENABLED env vars at runtime
# (compose.yml) does. So there's no separate build step: these just become two more
# entries alongside every other service's OTEL_SERVICE_NAME / OTEL_EXPORTER_OTLP_ENDPOINT
# runtime config.

COPY realm-export.json /opt/keycloak/data/import/realm-export.json

ENTRYPOINT ["/opt/keycloak/bin/kc.sh", "start-dev", "--import-realm"]
