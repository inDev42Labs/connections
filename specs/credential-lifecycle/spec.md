# Execution choice

`src/core/manager.ts` supplies Promise runners over shared Effect workflows. Sharing the implementation is an architectural choice, not a constitutional requirement or public feature contract. The [method reference](../../docs/reference.md#methods) owns Promise/Effect equivalence.

`src/stores/convex/bind.ts` and `src/stores/convex/run.ts` supply invocation-specific execution without a global context; the [Convex guide](../../docs/stores/convex.md) owns its action/query boundary.
