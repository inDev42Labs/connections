# Protected storage

An application chooses infrastructure for encrypted credentials. Built-in stores hide coordination while preserving safe lifecycle transitions across competing workers and interrupted operations.

Target sources: [stores and security](../../docs/reference.md), [supported integrations](../../docs/reference.md#supported-integrations) and [retrieval failures](../../docs/reference.md#handle-retrieval-failures), [Convex](../../docs/stores/convex.md), and [PostgreSQL](../../docs/stores/postgresql.md). Project constraints: [PR-001, PR-004, PR-006 through PR-009](../../CONSTITUTION.md).

## Required behavior

- **STORE-01:** Built-in stores MUST accept direct `encryptionKey` configuration without requiring a separate encryptor. They MUST protect saved secrets with authenticated AES-256-GCM encryption bound to connection identity. The built-in AES-256-GCM encryptor remains available through the `encryptor` option; custom-store and custom-encryptor extension APIs are deferred. Redaction alone MUST NOT count as persistence protection.
- **STORE-02:** Persistence MUST NOT contain plaintext access tokens, refresh tokens, source credentials, or PKCE verifiers. Wrong keys, malformed envelopes, tampering, and cross-connection substitution MUST fail safely. Inspection and diagnostics MUST remain non-secret.
- **STORE-03:** Stores MUST atomically apply conditional transitions and their idempotency receipts. Retrying a committed write after acknowledgement loss MUST NOT apply it twice or overwrite newer state. Reusing a request ID with changed input MUST conflict.
- **STORE-04:** Stale callbacks, renewal workers, and rejection reports MUST NOT overwrite newer authorization. Removal MUST retain enough coordination evidence to prevent earlier work from restoring authorization.
- **STORE-05:** The workflow MUST retain evidence before potentially consuming provider requests. Ownership expiry, interruption, or lost responses MUST NOT establish that a remote call did not occur. Recovery MUST be bounded and justified by provider facts and retained evidence, otherwise it MUST require intervention. A store MUST NOT choose provider replay policy.
- **STORE-06:** Memory MUST remain process-local and non-durable. SQLite, PostgreSQL, and Convex MUST preserve transactional conditional writes through their respective infrastructure. Consumers own database/pool/component deployment and stable encryption keys. Key or encryption-identity changes require migration, not implicit rotation.
- **STORE-07:** Convex MUST keep credential persistence in its private component and run decryption and provider work in invocation-bound actions. Queries MUST support only non-secret inspection. No Connections-operated service is required.

## Acceptance boundaries

Verify encryption round trips and substitution failures, conditional-write conformance, lost acknowledgements, competing workers, stale completion, and removal races. Exercise controlled process loss separately from same-process interruption. Conformance helpers alone MUST NOT be presented as proof of complete concurrency or crash safety.

Exact records and commands belong to `src/core/contracts/store.ts`; backend schemas belong to the adapter declarations. Custom-store and custom-encryptor contracts remain internal. A smaller custom persistence interface remains unproven. Do not replace the transactional seam with independent `get`/`set` operations or claim a stable new extension contract.
