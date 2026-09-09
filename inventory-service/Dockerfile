FROM golang:1.25-alpine AS build
WORKDIR /build
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/root/go/pkg/mod go mod download
COPY *.go ./
RUN --mount=type=cache,target=/root/go/pkg/mod CGO_ENABLED=0 go build -o inventory-service .

FROM alpine:3.20
RUN apk add --no-cache wget
WORKDIR /app
COPY --from=build /build/inventory-service .
EXPOSE 8082
ENTRYPOINT ["./inventory-service"]
