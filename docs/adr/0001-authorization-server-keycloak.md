# ADR 0001: 認可サーバーにKeycloakを採用

- **Status**: Accepted
- **Date**: 2026-09-11

## Context

RFC 8693 Token Exchange (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`) をネイティブサポートするOSS IdPが必要だった。

| 候補 | 対応状況 |
|---|---|
| Keycloak 26.2+（Standard Token Exchange V2） | ネイティブサポート |
| Ory Hydra | token-exchange grant typeが未実装 |

## Decision

**Keycloak 26.2+**（Standard Token Exchange V2）を採用する。

## Consequences

- RFC 8693 Token Exchange をネイティブサポートしている数少ない OSS IdP として適合。
