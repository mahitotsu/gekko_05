FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /build/.output ./.output
# The OTel bootstrap is loaded via Node's --import BEFORE Nitro's bundle, so it is
# NOT part of .output/. It needs the @opentelemetry/* packages as real installed
# node_modules at runtime, so copy the whole build-stage node_modules alongside it.
# (Copying the full tree is the least-fragile choice for this local teaching sample;
# hand-enumerating the OTel transitive deps would be brittle.)
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/server/otel.mjs ./server/otel.mjs
EXPOSE 3000
CMD ["node", "--import", "./server/otel.mjs", ".output/server/index.mjs"]
