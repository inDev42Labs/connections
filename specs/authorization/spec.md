# Authorization

An application establishes or deliberately replaces authorization for its own connection ID. Setup differs by credential mechanism; subsequent reads share the [credential lifecycle](../credential-lifecycle/spec.md).

Target sources: [setup workflows](../../docs/getting-started.md), [methods and providers](../../docs/reference.md), and [application ownership](../../docs/reference.md#security-and-ownership). Project constraints: [PR-002 through PR-004 and PR-006 through PR-007](../../CONSTITUTION.md).

## Required behavior

- **AUTH-01:** Setup MUST default to enrollment and conflict with saved authorization. The named `{ replace: true }` option MUST require saved authorization and preserve the connection ID. No setup method may silently overwrite authorization.
- **AUTH-02:** `setApiKey` MUST protect an application-supplied opaque key before success without creating a key or calling the external provider.
- **AUTH-03:** `setClientCredentials` MUST protect a provider-specific source before success. It MUST defer derived-credential acquisition until retrieval and retain the source for safe reacquisition. Source and derived credentials are not interchangeable.
- **AUTH-04:** Browser OAuth MUST generate and validate state, bind the saved attempt to trusted server-verified session evidence, and validate the callback. Completion MUST check application permission for the saved connection ID and intent before code exchange, not trust a browser-selected target. Attempts MUST reject expired, superseded, or consumed callbacks.
- **AUTH-05:** Zoho Self Client MUST use `enrollCode(id, { code, authorize, replace? })`, not browser start/callback methods. Its application authorization callback MUST run before exchanging the operator-supplied one-use code.
- **AUTH-06:** Concurrent enrollment, replacement, renewal, and removal MUST preserve store fences. Uncertain exchange outcomes MUST remain explicit and MUST NOT cause blind code replay or stale persistence. Preparing a browser replacement MUST NOT itself discard current credentials; safe use may stop when exchange introduces uncertainty.
- **AUTH-07:** Connections MUST leave caller authentication, permissions, connection ownership, OAuth routes, and provider API requests to the application. A connection ID or session binding is not a permission grant. Setup results and failures MUST NOT expose lifecycle-only secrets.

## Acceptance boundaries

For each built-in mechanism, exercise enrollment, conflict, explicit replacement, replacement against absence, and later retrieval. For OAuth and Self Client, deny application permission and assert that no code exchange occurs. Verify callback binding, expiry, duplicate completion, uncertainty, and removal during exchange.

The [provider reference](../../docs/reference.md#providers) defines the built-in choices. Exact inputs, outputs, and configuration fields belong to provider definitions in `src/providers/`; no universal credential shape or additional custom-provider contract is implied.
