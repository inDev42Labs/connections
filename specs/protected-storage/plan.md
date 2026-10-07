# Protected storage approach

Support the [protected storage target](spec.md) through a shared transition kernel and backend-owned atomic persistence.

## Implementation seams

- `src/integrations/store-encryption.ts` resolves direct-key or advanced-encryptor configuration. `src/encryptors/aes-gcm/aes-gcm.ts` authenticates envelopes against the encryption context declared in `src/core/contracts/encryptor.ts`.
- `src/core/contracts/store.ts` declares current records, commands, conditional inputs, and results. `src/stores/internal/transition-kernel.ts` owns shared transition logic and receipt validity. `src/stores/internal/persisted-record-decoder.ts` validates persisted inputs. Reference these declarations rather than copying schemas into prose.
- `src/stores/memory/persistence.ts`, `src/stores/sqlite/persistence.ts`, `src/stores/postgresql/persistence.ts`, and `src/stores/convex/component/persistence.ts` provide backend-specific atomic boundaries. Keep receipt and state writes in the same transaction.
- `src/core/renewable-credential-workflow.ts` coordinates operation ownership, dispatch evidence, bounded waiting, and recovery. Provider calls cannot join a local store transaction. Never clear possible-dispatch evidence merely because a lease expires.
- Convex component schema and functions remain under `src/stores/convex/component/`. The invocation bridge lives outside the component, as described in the [lifecycle approach](../credential-lifecycle/plan.md).

## Direct verification

| Requirements | Evidence and command |
| --- | --- |
| STORE-01, STORE-02 | `tests/encryptors/aes-gcm.test.ts`, `tests/interface/secret-safety.test.ts`, `tests/stores/persisted-record-decoder.test.ts`; `bun run check` |
| STORE-03, STORE-04, STORE-06 | `tests/contracts/stores/` and `tests/lifecycle/`; `bun run check` |
| STORE-05 | `tests/lifecycle/recovery.in-memory.test.ts`; `bun run check`. Controlled OS-worker loss through `tests/process-loss/run.ts`; `bun run test:process-loss` |
| STORE-07 | `tests/stores/convex/`; `bun run test:convex`. Actual anonymous local backend through `tests/stores/convex/local/run.ts`; `bun run test:convex:local` |

PostgreSQL default tests use a PGlite-backed protocol endpoint. `bun run test:postgresql:real` requires an explicitly authorized disposable backend; its declarations are in `tests/stores/postgresql/real-postgres.ts`. No live PostgreSQL service, provider integration, or cloud deployment is established by source inspection or local substitutes.

Persistence changes require an explicit compatibility and migration decision before changing saved declarations or encryption identity. A custom seam or pruning policy is not selected by this plan.
