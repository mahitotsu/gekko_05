FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /build/.output ./.output
# OTelブートストラップはNitroのバンドルより前にNodeの--importで読み込まれるため、
# .output/には含まれない。実行時に@opentelemetry/*パッケージが本物のインストール
# 済みnode_modulesとして必要なため、ビルドステージのnode_modulesを丸ごとコピー
# して同梱する（このローカル学習用サンプルでは、全体をコピーするのが最も壊れに
# くい選択。OTelの推移的依存を手動で列挙するのは脆い）。
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/server/otel.mjs ./server/otel.mjs
EXPOSE 3000
CMD ["node", "--import", "./server/otel.mjs", ".output/server/index.mjs"]
