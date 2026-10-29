# Persistence rationale

Provider requests cannot join a local store transaction. Admission, dispatch reservation, and completion therefore use separate fences. `src/stores/internal/transition-kernel.ts` owns conditional transitions and receipt validity; backend persistence modules apply receipt and state writes in one atomic operation. Independent `get`/`set` operations would lose that guarantee. A smaller custom persistence interface remains unproven; [custom extension APIs are deferred](../../docs/reference.md#supported-integrations).

Persistence changes require an explicit compatibility and migration decision before changing saved declarations or encryption identity. Key or encryption-identity changes require migration, not implicit rotation. The [store reference](../../docs/reference.md#stores) owns consumer encryption configuration; `src/core/contracts/store.ts` and adapter schemas own exact declarations.

No shared pruning policy is selected. The Convex component's current retention behavior in `src/stores/convex/component/receipts.ts` does not establish a general persistence or extension contract.
