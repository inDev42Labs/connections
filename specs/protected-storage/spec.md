# Protected storage safety

The [store reference](../../docs/reference.md#stores) owns encryption configuration and built-in store choices. [Security and ownership](../../docs/reference.md#security-and-ownership), [Convex setup](../../docs/stores/convex.md), and [PostgreSQL setup](../../docs/stores/postgresql.md) own consumer responsibilities and adapter execution boundaries.

## Encryption and compatibility

- **STORE-02:** Persistence MUST NOT contain plaintext access tokens, refresh tokens, source credentials, or PKCE verifiers. Wrong keys, malformed envelopes, tampering, and cross-connection substitution MUST fail safely. Inspection and diagnostics MUST remain non-secret.
- Persistence changes require an explicit compatibility and migration decision before changing saved declarations or encryption identity. Key or encryption-identity changes require migration, not implicit rotation.

`src/encryptors/aes-gcm/aes-gcm.ts` authenticates envelopes against the context in `src/core/contracts/encryptor.ts`. Exact records and commands belong to `src/core/contracts/store.ts`; backend schemas belong to the adapter declarations. Evidence: `tests/encryptors/aes-gcm.test.ts`, `tests/interface/secret-safety.test.ts`, and `tests/stores/persisted-record-decoder.test.ts`.

## Atomic transitions and receipts

- **STORE-03:** Stores MUST atomically apply conditional transitions and their idempotency receipts. Retrying a committed write after acknowledgement loss MUST NOT apply it twice or overwrite newer state. Reusing a request ID with changed input MUST conflict.
- **STORE-04:** Stale callbacks, renewal workers, and rejection reports MUST NOT overwrite newer authorization. Removal MUST retain enough coordination evidence to prevent earlier work from restoring authorization.

`src/stores/internal/transition-kernel.ts` owns shared transitions and receipt validity. Backend persistence modules under `src/stores/` provide the atomic boundary; receipt and state writes MUST share the same transaction. Evidence: `tests/contracts/stores/conformance.ts` and `tests/lifecycle/` cover receipt replay, competing workers, stale completion, and removal races.

## Dispatch and recovery

- **STORE-05:** The workflow MUST retain evidence before potentially consuming provider requests. Ownership expiry, interruption, or lost responses MUST NOT establish that a remote call did not occur. Recovery MUST be bounded and justified by provider facts and retained evidence, otherwise it MUST require intervention. A store MUST NOT choose provider replay policy.

Provider calls cannot join a local store transaction. `src/core/renewable-credential-workflow.ts` coordinates ownership, dispatch evidence, bounded waiting, and recovery; possible-dispatch evidence MUST NOT be cleared merely because a lease expires.

`tests/lifecycle/recovery.in-memory.test.ts` covers same-process interruption. `tests/process-loss/run.ts` exercises controlled OS-worker loss separately. Conformance helpers alone MUST NOT be presented as proof of complete concurrency or crash safety. The [development quickstart](../../README.md#develop-this-repository) describes runner prerequisites and evidence limits; the [PostgreSQL guide](../../docs/stores/postgresql.md) distinguishes local substitutes from explicitly authorized real-backend checks.

A smaller custom persistence interface remains unproven; no pruning policy is selected. Do not replace the transactional seam with independent `get`/`set` operations or infer a stable extension contract from internal declarations; [custom extension APIs are deferred](../../docs/reference.md#supported-integrations).
