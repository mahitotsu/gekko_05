# ADR 0002: Token Exchange実装をアプリ本体に配置（プロキシ委譲しない）

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

Token Exchange ロジックの置き場として、各サービスのアプリケーション本体に実装するか、Envoy等のサイドカープロキシに委譲するかを決める必要があった。

## Decision

**各サービスのアプリケーション本体で実装する**。Envoy等のプロキシ／サイドカーには委譲しない。

## Consequences

- RFC 8693 の意味論がコードとして直接見えるため、学習サンプルという本リポジトリの目的に沿う。
- Envoy の `envoy.filters.http.oauth2` は Authorization Code フロー向けであり、RFC 8693 Token Exchange grant には非対応。プロキシ側で実現するにはカスタム ext_authz サービスの自作が必要となり、複雑さが移動するだけで可視性が下がる。
