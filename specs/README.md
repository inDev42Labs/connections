# Active features

These technical specifications explain the current target for maintainers. [Consumer docs](../docs/reference.md) are authoritative for intended behavior and extension boundaries. Specifications clarify that target, not redefine it. [CONSTITUTION.md](../CONSTITUTION.md) sets project constraints; [CONTEXT.md](../CONTEXT.md) defines domain terms.

| Feature | Technical specification | Approach and verification | Remaining work |
| --- | --- | --- | --- |
| Credential lifecycle | [Read, renew, report rejection, inspect, and remove](credential-lifecycle/spec.md) | [Shared workflow and execution](credential-lifecycle/plan.md) | None |
| Authorization | [Enroll and deliberately replace authorization](authorization/spec.md) | [Mechanism-specific setup](authorization/plan.md) | |
| Protected storage | [Encrypted persistence and safe coordination](protected-storage/spec.md) | [Transactional adapters](protected-storage/plan.md) | |

Exact types, provider fields, storage schemas, exports, and commands belong to their declarations in `src/` and `package.json`. Tests provide executable assertions, not a competing product target.

Maintain features by outcome, without numeric prefixes or delivery-stage directories. Keep each spec current. Add a plan only for distinct technical decisions and a task list only for actionable remaining work. Earlier targets and completed delivery checklists remain in Git, not here.

Custom-provider, custom-store, and custom-encryptor extension APIs are deferred by the [supported integration boundary](../docs/reference.md#supported-integrations). Additional Effect-service provision and provider namespaces require separate design decisions under the [reference](../docs/reference.md). The current constructor rejects additional Effect-service requirements except for the built-in Convex invocation binding. These boundaries are not approved implementation tasks. Resolve the relevant boundary with the owner before extending it.
