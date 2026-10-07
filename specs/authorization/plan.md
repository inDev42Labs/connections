# Authorization approach

Support the [authorization target](spec.md) with mechanism-specific setup over shared protected storage.

## Implementation seams

- `src/core/manager.ts` converts ordinary secret inputs at the boundary and maps `replace` to enrollment/replacement intent. It delegates directly to the mechanism's Effect workflow.
- `src/core/api-key-workflow.ts` saves opaque keys locally. `src/core/client-credentials-workflow.ts` saves retained sources and delegates acquisition to the renewable workflow.
- `src/core/workflow.ts` coordinates browser attempts, trusted binding, callback authorization, admission, exchange, and persistence. `src/core/self-client-workflow.ts` coordinates operator code exchange without a browser attempt.
- `src/core/contracts/provider.ts` declares current internal provider capabilities. `src/providers/` owns provider configuration, transport validation, renewal facts, and credential projection. These declarations are not proof of a stable public extension API.
- The [storage approach](../protected-storage/plan.md) supplies atomic admissions, dispatch reservations, and completion fences. Keep application authorization before one-use exchange and keep provider policy out of persistence adapters.

## Direct verification

- AUTH-01 through AUTH-03: `tests/interface/promise-read.test.ts`, `tests/interface/api-key.test.ts`, and `tests/interface/client-credentials.test.ts` exercise strict intent and deferred acquisition.
- AUTH-04, AUTH-05: `tests/interface/promise-provider-oauth.test.ts`, `tests/interface/promise-self-client.test.ts`, `tests/interface/authorization.test.ts`, and `tests/interface/self-client.test.ts` exercise public flows and pre-exchange checks.
- AUTH-06: `tests/interface/replacement.test.ts`, `tests/interface/enrollment-removal.test.ts`, `tests/lifecycle/client-credentials-replacement-removal.in-memory.test.ts`, and `tests/lifecycle/replacement-removal.in-memory.test.ts` cover races and uncertainty.
- AUTH-07: `tests/interface/secret-safety.test.ts` and `tests/interface/authorization.test.ts` cover safe results and application authority.

Run `bun run check`; provider transport tests under `tests/providers/` use controlled substitutes. Do not infer live provider configuration, production credentials, or deployment readiness from their success.
