# Credential lifecycle safety

The [method reference](../../docs/reference.md#methods) owns credential reads, observation-bound rejection reports, inspection, removal, and Promise/Effect equivalence. The [retrieval failure reference](../../docs/reference.md#handle-retrieval-failures) and [Shopify recovery guide](../../docs/providers/shopify.md#understand-renewal-failures) own failure categories and provider replay policy.

## Recovery evidence

`src/core/renewable-credential-workflow.ts` coordinates renewal for OAuth and client credentials. Retained `ProviderFailure` operations with explicit `NotDispatched` evidence admit one fresh operation on a later read, with new ownership and recovery limits. The store transition checks generation and revision so concurrent readers cannot each recover the same failure. Missing evidence and confirmed rejection do not grant replay permission.

A provider replay deadline MUST survive later failures and ownership changes without extension. An expired window requires intervention; an abandoned first dispatch without retained evidence remains uncertain. The persisted decoder and optional Convex validators MUST preserve older records without inventing evidence.

Evidence: `tests/interface/provider-failure-recovery.test.ts`, `tests/lifecycle/shopify-recovery.test.ts`, `tests/contracts/stores/conformance.ts`, and `tests/stores/persisted-record-decoder.test.ts`.

## Inspection and removal

- **READ-04:** Inspection storage failure MUST remain a failure, not fabricated absence. `src/core/local-lifecycle.ts` uses the metadata-only store capability; `tests/interface/inspection.test.ts` rejects decryption, renewal, and provider calls on this path.
- **READ-05:** Removal MUST fence saved authorization, prepared browser attempts, and pending initial exchanges. The shared store transition advances the generation and clears local work; an already empty record keeps its generation and revision. A delayed removal receipt MUST NOT report success over newer enrollment. `src/core/local-lifecycle.ts` confirms the returned receipt against current state.

Evidence: `tests/interface/removal.test.ts`, `tests/interface/enrollment-removal.test.ts`, and `tests/contracts/stores/conformance.ts` cover empty-state removal, initial-enrollment removal, and reenrollment through the production command seam.

## Execution choice

`src/core/manager.ts` supplies Promise runners over shared Effect workflows. Sharing the implementation is an architectural choice, not a constitutional requirement or public feature contract. `src/stores/convex/bind.ts` and `src/stores/convex/run.ts` supply invocation-specific execution without a global context; the [Convex guide](../../docs/stores/convex.md) owns its action/query boundary.
