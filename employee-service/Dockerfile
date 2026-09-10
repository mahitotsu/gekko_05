FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
# importしているライブラリ（fastapi, pymongo, requests）を自動検出し、対応する
# opentelemetry-instrumentation-*プラグインをインストールする。これにより
# opentelemetry-instrumentがコード変更ゼロで実行時にパッチを当てられる。
RUN --mount=type=cache,target=/root/.cache/pip opentelemetry-bootstrap -a install
COPY *.py ./
# OTEL_SERVICE_NAMEとOTEL_EXPORTER_OTLP_ENDPOINTはcompose.ymlから渡される。
# OTLPのHTTP/protobufエクスポーターを明示的に強制する：指定しないとSDKが既定で
# gRPCを使い、4318番（HTTP）のエンドポイントに対して無音で失敗しうる。
# OTEL_PYTHON_FASTAPI_EXCLUDED_URLS：これはゼロコード計装のため
# （excluded_urlsを直接渡すFastAPIInstrumentor.instrument_app()呼び出しが無い）、
# この環境変数だけが唯一の手段になる。GET /health（composeのヘルスチェック対象で
# 5秒ごとに叩かれる）のスパン生成をスキップする。無指定だとservice graphが
# 呼び出し元不明のノードで埋め尽くされる。値はre.searchでマッチする正規表現の
# カンマ区切りリスト。
ENV OTEL_TRACES_EXPORTER=otlp \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
    OTEL_PYTHON_FASTAPI_EXCLUDED_URLS=/health
EXPOSE 8084
CMD ["opentelemetry-instrument", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8084"]
