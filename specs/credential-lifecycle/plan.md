# Credential lifecycle approach

The current implementation supports the [credential lifecycle target](spec.md) through shared Effect workflows with Promise runners. This is an architectural choice, not a constitutional requirement or part of the public feature contract.

## Implementation seams

- `src/index.ts` exports the sole constructor, `Connections.create`. `src/core/manager.ts` wires provider capabilities directly to the Effect workflows and supplies Promise runners over those operations. It projects plain credential results and captures rejection reporting without intermediate connection handles.
- Workflows produce the documented retrieval categories directly. `src/core/renewable-credential-workflow.ts` owns renewal and recovery for OAuth and client credentials. Provider definitions own response interpretation and credential projection.
- `src/core/local-lifecycle.ts` owns metadata inspection and receipt-confirmed removal for every mechanism. A delayed removal receipt cannot report success over newer enrollment.
- `src/core/credential-rejection.ts` preserves observation-bound invalidation. Store conditions fence writes against newer state.
- `src/stores/convex/bind.ts` supplies invocation-specific runners. `src/stores/convex/run.ts` supplies Effect requirements and scope. Query bindings return only `inspect`; reusable definitions never retain `ctx` globally.

## Direct verification

- READ-01, READ-02, READ-06: `tests/interface/promise-read.test.ts`, `tests/interface/outcomes.test.ts`, and `tests/lifecycle/refresh.in-memory.test.ts` cover renewal, projection, failure mapping, and equivalent execution behavior.
- READ-03: `tests/interface/credentials.test.ts` and `tests/interface/client-credentials.test.ts` cover rejection observations and retained sources.
- READ-04, READ-05: `tests/interface/inspection.test.ts`, `tests/interface/removal.test.ts`, and `tests/lifecycle/replacement-removal.in-memory.test.ts` cover local inspection and stale work.
- READ-07: `tests/interface/configuration.test.ts`, `tests/types/public-interface.ts`, and `tests/stores/convex/lifecycle.test.ts` cover lazy configuration and invocation capabilities.

Run `bun run check` and `bun run test:convex` for these paths. The full package and local-runtime gates are declared by `verify` in `package.json`. Local substitutes do not establish live-provider or cloud behavior.

Do not select a custom runtime or namespace API from existing internal defaults. The [documented integration boundaries](../../docs/reference.md#supported-integrations) require owner decisions before implementation.
