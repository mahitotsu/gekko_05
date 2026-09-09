#!/bin/sh
# Redis has no docker-entrypoint-initdb.d equivalent, so this custom image starts
# redis-server, seeds initial data once it's reachable, then stays in the foreground.
# SETNX makes seeding idempotent: a restart of the same (persisted) data won't
# clobber stock that's already been decremented by reservations.
set -e

redis-server --save 60 1 --dir /data &
REDIS_PID=$!

until redis-cli ping >/dev/null 2>&1; do
  sleep 0.1
done

redis-cli SETNX stock:tokyo:product-A 100
redis-cli SETNX stock:osaka:product-A 50

wait "$REDIS_PID"
