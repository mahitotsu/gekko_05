FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
# Auto-detect imported libraries (fastapi, pymongo, requests) and install the
# matching opentelemetry-instrumentation-* plugins so opentelemetry-instrument
# can patch them at runtime with zero code changes.
RUN --mount=type=cache,target=/root/.cache/pip opentelemetry-bootstrap -a install
COPY *.py ./
# OTEL_SERVICE_NAME and OTEL_EXPORTER_OTLP_ENDPOINT come from compose.yml.
# Force the OTLP HTTP/protobuf exporter: the SDK can otherwise default to gRPC
# and fail silently against the 4318 (HTTP) endpoint.
ENV OTEL_TRACES_EXPORTER=otlp \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
EXPOSE 8084
CMD ["opentelemetry-instrument", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8084"]
