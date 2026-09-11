# ADR 0003: ローカル実行環境にDocker Composeを採用

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

Keycloak・5サービス・4種DB・edge-proxy・トレース基盤を含む複数コンテナをローカルで起動・管理するオーケストレーション手段を決める必要があった。候補は Docker Compose と Kubernetes。

## Decision

**Docker Compose** を採用する。

- Kubernetesは、Token Exchangeの意味論を示すという目的に対してオーケストレーション自体の学習コストが過剰であり、本リポジトリのスコープ外と判断した

## Consequences

- `docker compose up` 一発で全コンポーネントが起動できるシンプルな構成を維持できる。
- Envoy 等のプロキシを使わない方針（ADR 0002）と一貫して、オーケストレーション側の複雑さも最小化する。
