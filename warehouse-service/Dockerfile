FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml ./
COPY src ./src
# registry/targetのcache mountは（通常のDockerレイヤーと異なり）個別の
# `docker build`実行をまたいで永続化するため、依存関係レイヤーを温めるための
# 定番の「まずダミーのmain.rsでビルドする」トリックは不要。それどころかこの
# トリックは実害があった：cargoのフィンガープリント判定が後続の実src/のCOPYを
# 変更として確実に検知せず、ダミーのバイナリが静かに使い回されてしまった。
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release && cp target/release/warehouse-service /build/warehouse-service

FROM alpine:3.20
RUN apk add --no-cache libgcc wget
WORKDIR /app
COPY --from=build /build/warehouse-service .
EXPOSE 8083
ENV RUST_LOG=info
ENTRYPOINT ["./warehouse-service"]
