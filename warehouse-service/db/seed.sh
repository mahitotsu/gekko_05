#!/bin/sh
# Redisにはdocker-entrypoint-initdb.d相当の仕組みが無いため、このカスタムイメージ
# はredis-serverを起動し、到達可能になったら初期データを投入したうえでフォア
# グラウンドに留まる。SETNXにより投入は冪等になる：同じ（永続化済みの）データで
# 再起動しても、既に引当てで減算済みの在庫を上書きしない。
set -e

redis-server --save 60 1 --dir /data &
REDIS_PID=$!

until redis-cli ping >/dev/null 2>&1; do
  sleep 0.1
done

redis-cli SETNX stock:tokyo:product-A 100
redis-cli SETNX stock:osaka:product-A 50
redis-cli SETNX stock:osaka:product-C 50

wait "$REDIS_PID"
