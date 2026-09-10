FROM quay.io/keycloak/keycloak:26.4

# tracing-enabledとhealth-enabledはどちらも公式ドキュメント上ビルド時オプション
# とされているが、`start-dev`はコンテナ起動のたびに（事前にイメージへ何を焼き
# 込んでいても）毎回再augmentation（再ビルド）する——実機で確認済み：ここで
# `kc.sh build --tracing-enabled=true --health-enabled=true`を実行しても全く
# 効果が無かった一方、実行時に同等のKC_TRACING_ENABLED/KC_HEALTH_ENABLED環境変数
# を渡す（compose.yml）と効いた。そのため専用のビルドステップは設けず、これらは
# 他の全サービスのOTEL_SERVICE_NAME / OTEL_EXPORTER_OTLP_ENDPOINTと同じ扱いの
# 実行時設定として渡すだけにしている。

COPY realm-export.json /opt/keycloak/data/import/realm-export.json

ENTRYPOINT ["/opt/keycloak/bin/kc.sh", "start-dev", "--import-realm"]
