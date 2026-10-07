# Credential lifecycle

An application reads usable, provider-specific credentials without managing renewal. It owns access checks and protected-resource requests.

Target sources: [getting started](../../docs/getting-started.md), [methods and retrieval failures](../../docs/reference.md), and [recovery boundaries](../../docs/reference.md#handle-retrieval-failures). Project constraints: [PR-002 through PR-004 and PR-006 through PR-008](../../CONSTITUTION.md). Setup belongs to [Authorization](../authorization/spec.md); persistence belongs to [Protected storage](../protected-storage/spec.md).

## Required behavior

- **READ-01:** `credentials(id)` MUST return only provider-specific use credentials, with secret fields redacted. It MUST renew when safe and necessary rather than return known expired credentials. Refresh tokens and lifecycle-only source secrets MUST remain internal.
- **READ-02:** Retrieval MUST distinguish `AuthorizationRequired`, `TemporarilyUnavailable`, and `InterventionRequired` according to the [documented mapping](../../docs/reference.md#handle-retrieval-failures). An unknown provider outcome MUST NOT be treated as proof of rejection or permission to replay an exchange.
- **READ-03:** `credentialUse(id)` MUST bind `reportRejected()` to the exact read. A stale report MUST NOT invalidate newer credentials. The application reports only confirmed rejection, and Connections MUST NOT retry the application's provider request. Rejection of a derived credential MUST NOT by itself invalidate its retained source credential.
- **READ-04:** `inspect(id)` MUST return local non-secret status without decrypting, renewing, or calling the provider. Storage failure MUST remain a failure, not fabricated absence. Inspection MUST NOT claim remote health.
- **READ-05:** `remove(id)` MUST remove local authorization without provider revocation. Work started before removal MUST NOT restore authorization. Credentials already returned to the application cannot be recalled.
- **READ-06:** Managers MUST expose Promise methods and equivalent operations through `manager.effect` for Effect composition. Both interfaces MUST preserve the same results, failures, and lifecycle guarantees. Ordinary built-in Promise use MUST NOT require a direct Effect import or composing Effect programs. This feature does not prescribe internal use of Effect or a shared implementation. `revealSecret` provides deliberate conversion at the application's SDK or HTTP boundary.
- **READ-07:** Manager construction MUST NOT perform storage reads, token acquisition, or invocation-context resolution. Convex Promise operations MUST use the current invocation through `Convex.bind`; query bindings MUST expose only inspection. No global invocation context is permitted.

## Acceptance boundaries

Verify usable and expired reads, all three retrieval categories, stale rejection reports, metadata-only inspection, and removal races through the public interface. Verify Promise/Effect equivalence and Convex action/query capability separation. A returned credential is not a guarantee that a later provider request succeeds.

`Connections.create` is the sole manager constructor. Provider and store definitions requiring arbitrary additional Effect services are unsupported in both execution styles. The built-in Convex invocation binding is the exception. Explicit namespace configuration and maximum credential age are not public options. Built-in support MUST NOT be presented as a universal runtime contract.
