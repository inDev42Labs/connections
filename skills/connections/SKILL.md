---
name: connections
description: >
  Work with @indev42/connections credentials, authorization, providers, and stores.
  Read the getting-started guide for the built-in Promise interface and the
  Effect guide for composition. Use the reference for supported integrations
  and the provider and store catalogs for integration-specific setup.
metadata:
  type: core
  library: '@indev42/connections'
  library_version: '0.0.0'
sources:
  - 'inDev42Labs/connections:README.md'
  - 'inDev42Labs/connections:CONTEXT.md'
  - 'inDev42Labs/connections:docs/getting-started.md'
  - 'inDev42Labs/connections:docs/effect.md'
  - 'inDev42Labs/connections:docs/reference.md'
  - 'inDev42Labs/connections:docs/providers/*.md'
  - 'inDev42Labs/connections:docs/stores/*.md'
  - 'inDev42Labs/connections:src/index.ts'
---

# Connections

Connections supplies credentials for an application-owned connection to an external provider. The application owns authentication, authorization, OAuth routes, store deployment, provider API calls, and its mapping from users or tenants to connection IDs.

## Read the right page

1. Read [Get credentials for a connection](../../docs/getting-started.md) for the implemented built-in setup and retrieval paths. Supply the application-owned permissions and provider requests shown as placeholders.
2. Read [Reference](../../docs/reference.md) for provider and store choices, method behavior, and error categories. Follow the [provider catalog](../../docs/reference.md#providers) links for provider-specific setup and constraints.
3. Read [Use Connections with Effect](../../docs/effect.md) when composing `manager.effect` operations, handling their failures, or running an Effect program.
4. Read [Using Connections with Convex](../../docs/stores/convex.md) or [PostgreSQL](../../docs/stores/postgresql.md) only when that adapter is in use. Read the reference's [supported integrations](../../docs/reference.md#supported-integrations) and [retrieval failures](../../docs/reference.md#handle-retrieval-failures) for extension and recovery boundaries.

Treat the linked consumer docs as the authoritative target. In a source checkout, read the root `AGENTS.md` and `CONSTITUTION.md` before changes, then use `specs/README.md` to find technical clarification and verification paths. Specs do not override docs; prior targets remain in Git. Verify implementation claims in `src/index.ts`, tests, and the relevant adapter. Stop and ask the owner if implementation requires an undocumented public contract. Custom-provider, custom-store, and custom-encryptor extension APIs are deferred. Do not add restrictions solely to block unsupported structural use or claim arbitrary Effect-service Promise execution.

## Preserve lifecycle safety

- Authenticate and authorize every application-facing action. A connection ID is an identifier, not permission to use the connection.
- Keep access tokens, API keys, source credentials, refresh tokens, and encryption keys on the server. Reveal redacted secrets only where an SDK or HTTP request needs a string. The built-in Promise interface exports `revealSecret` from Connections; Effect-native callers can still use `Redacted.value` from `effect`.
- Bind browser OAuth to trusted, server-verified session evidence. Check permission for the connection ID recovered from the callback attempt before exchanging the code.
- Report a credential as rejected only after the application's provider request confirms an authentication rejection. Bind the report to that exact credential read; do not invalidate a newer credential.
- Do not retry a possibly consumed one-use code or rotated refresh credential merely because a worker lost the provider response. Return an actionable failure when safe renewal is unknown.
- Keep provider API requests outside the credential lifecycle. `remove` deletes local authorization; it does not revoke provider-side authorization.
- Preserve equivalent results, failures, and lifecycle guarantees through Promise methods and `manager.effect`. The feature contract does not prescribe shared implementation or internal use of Effect. Bind Convex's context within the current action, never in a module-global runtime.

## Verify implementation work

In a source checkout, read `package.json` for current commands. Run `bun run check` and the relevant adapter integration tests. For public-interface changes, exercise the same lifecycle through Promise and Effect, Convex invocation binding when applicable, and package imports. Read runner prerequisites before full verification; local backend downloads and fixture installs may require network access. Obtain explicit permission before contacting external services or testing a real PostgreSQL backend. Do not infer configured integrations or deployments from code or local substitutes.
