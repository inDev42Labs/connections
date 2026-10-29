# Authorization safety

The [setup workflows](../../docs/getting-started.md) and [method reference](../../docs/reference.md#methods) own enrollment, explicit replacement, mechanism-specific inputs, and application permission checks. These constraints clarify callback and exchange safety.

- **AUTH-04:** Browser attempts MUST reject expired, superseded, or consumed callbacks. Completion MUST check application permission for the saved connection ID and intent before code exchange, not trust a browser-selected target.
- **AUTH-06:** Concurrent enrollment, replacement, renewal, and removal MUST preserve store fences. Uncertain exchange outcomes MUST remain explicit and MUST NOT cause blind code replay or stale persistence. Preparing a browser replacement MUST NOT itself discard current credentials; safe use may stop when exchange introduces uncertainty.

## Implementation and evidence

`src/core/workflow.ts` coordinates browser attempts, binding, callback authorization, admission, exchange, and persistence. `src/core/self-client-workflow.ts` coordinates operator code exchange without a browser attempt. The [storage constraints](../protected-storage/spec.md) explain why admission, dispatch reservation, and completion need separate fences: provider requests cannot join a local store transaction.

- `tests/interface/authorization.test.ts` covers callback binding, expiry, duplicate completion, and pre-exchange application approval.
- `tests/interface/replacement.test.ts` covers prepared, abandoned, expired, and superseded replacements, and uncertainty after exchange.
- `tests/interface/self-client.test.ts` covers approval before one-use exchange, lost acknowledgements, and fresh-code recovery without replaying an uncertain code.
- `tests/interface/enrollment-removal.test.ts` and `tests/lifecycle/replacement-removal.in-memory.test.ts` cover removal during exchange and stale completion.
