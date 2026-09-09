FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml ./
COPY src ./src
# The registry/target cache mounts persist across separate `docker build` invocations
# (unlike a plain Docker layer), so there's no need for the classic "build a dummy
# main.rs first" trick to warm a dependency layer -- and that trick actively broke
# things here: cargo's fingerprinting didn't reliably detect the later COPY of the
# real src/ as a change, so the dummy binary got reused silently.
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
