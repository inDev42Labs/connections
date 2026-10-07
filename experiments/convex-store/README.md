# Local Convex component experiment

**Historical design evidence, not the target API.** This throwaway integration prototype is not a production store or OAuth implementation. Use [the consumer reference](../../docs/reference.md) and [Convex guide](../../docs/stores/convex.md) for target behavior. Everything uses fake credentials. No Convex cloud project/deployment or real OAuth provider is needed.

> **Historical interface:** This experiment includes the `Convex.withClient`, `Convex.inspect`, `ClientDisposed`, and Promise-mirrored connection design that was evaluated and later rejected. The current implementation retains `Convex.layer(ctx)` and `Convex.run(ctx, effect)`. The proposed interface also has Promise methods bound to the current invocation through `Convex.bind(ctx, manager)`. The facade evidence below records the experiment; it is not current consumer guidance.

Related evidence: [refresh experiments](../refresh/README.md). The original lifecycle specification and implementation plan are retained in Git history, not in active specifications.

## Run

Requires Bun, Node.js, and a supported POSIX system. Verified on Linux with Node 24.19.0 and Bun 1.4.0. The process-group cleanup runner is not intended for Windows.

```sh
cd experiments/convex-store
bun install
bun run typecheck
bun run test
bun run local
```

Dependencies are isolated in this private subpackage using Bun's isolated linker. Root package dependencies, scripts, and exports are unchanged. Generated Convex files are retained with the experiment, so mock tests and type checking do not require starting a backend first. `bun run local` regenerates them against the backend.

`bun run test` runs seventeen `convex-test` cases in Vitest's edge runtime. These are mock-backend checks, not deployed runtime evidence. Files use `.check.ts` and a local Vitest include pattern. The root Vitest configuration also explicitly excludes `experiments/**`, keeping all experiment checks opt-in.

`bun run local` starts an anonymous backend, installs the component, sets a fake application encryption key, executes assertions through HTTP, and shuts down. Backend data, account/cache isolation, configuration, and logs stay in this experiment's ignored `.convex/`, `.local/`, and `.env.local` paths. The log is `.local/convex-dev.log`. Do not put real credentials in these fixtures.

The successful local run ends with:

```text
ALL LOCAL CONVEX CHECKS PASSED. No cloud project or deployment was created.
Stopped the experiment backend and HTTP listener.
```

The runner pins Convex CLI **1.45.0**, Effect **4.0.0-rc.112**, and local backend **precompiled-2026-08-25-7cce8fb**. Initial package/backend downloads need internet access; this is not an air-gapped installation procedure. Test execution uses only loopback HTTP, fake values, and the local database. No login is performed.

## Local-only safeguards

- CLI child processes receive a private HOME and have inherited `CONVEX_*` deployment credentials removed.
- Every CLI invocation uses a freshly written explicit `--env-file` selecting `anonymous:anonymous-agent`. This bypasses `.env`/`.env.local` deployment selection; anonymous agent mode alone does not override a deploy key.
- Ports **33210** and **33211** must be free before starting. The runner refuses to touch a backend already using them.
- CLI 1.45.0 does not expose the backend's bind-interface option, and the binary defaults to `0.0.0.0`. The isolated CLI process loads `scripts/loopback.cjs`, a narrow version-specific spawn hook that forces the backend onto **127.0.0.1** and disables backend beacons/Sentry. It is never loaded in application code. Actual listening sockets were inspected to verify both bindings.
- App fixture endpoints reject non-loopback deployment URLs. The fake provider client permits only loopback URLs and rejects redirects instead of forwarding a credential-bearing POST elsewhere.
- The runner stops its own child process group on success, failure, SIGINT, or SIGTERM and checks that both listeners close. Interrupt and termination cleanup were exercised separately after backend startup.
- These fake fixture endpoints intentionally lack production authorization. Do not deploy this application publicly or use its raw storage wrappers as a production public API.

If an uncatchable kill or machine failure leaves a backend behind, inspect the experiment's process/log before stopping it. Do not kill unrelated Convex processes or delete your normal Convex configuration.

## The interface exercised

App-side definitions in `src/convex/connections.ts`:

```ts
const encryptor = AesGcm.make(() => env.CONNECTIONS_TEST_KEY)
const store = Convex.store({ component: components.credentialStore, encryptor })
const manager = makeManager({
  store,
  refresh: fakeHttpRefresh(() => env.CONVEX_SITE_URL),
})
```

The environment variable is declared in `src/convex/convex.config.ts` and accessed through Convex's generated typed `env` export. The key getter is lazy; a component reference and configured store can live at module scope without retaining an invocation's `ctx`.

Inside an application action:

```ts
const use = await Convex.run(ctx, manager.connection(connectionKey).credentials())
```

`Convex.run` explicitly supplies the current invocation's query/mutation capabilities to Effect and closes its scope. Effect-native code can use `Convex.layer(ctx)`. No runtime or context is retained globally by the manager. This prototype uses its own minimal manager, not exported `Connections.oauth` functionality.

The same manager now supports a thin Promise facade:

```ts
await Convex.withClient(ctx, manager, async (client) => {
  const use = await client.connection(connectionKey).credentials()
  // Use use.credentials server-side; return only the application's safe result.
})
```

The callback owns scoped library work; escaped handles reject with `ClientDisposed`. `withClient` and `run` accept an optional final `{ signal }` argument. Aborting closes library scope even if an arbitrary application Promise continues running. Ordinary typed failures are preserved as rejection values rather than hidden in `FiberFailure`; complex causes/defects use Effect's `Cause.squash`, not a finalized production error taxonomy.

Read-only queries can use `Convex.inspect(ctx, manager.connection(connectionKey))`. A dedicated component query returns only `savedAuthorization` and `credentialWorkPending`; encrypted records do not cross into the parent query. No key resolution, decryption, mutations, or provider calls occur. These are deliberately narrow local facts, not a health verdict.

Only serializable ciphertext/envelope fields and coordination metadata cross credential-store calls. AES-GCM encryption/decryption and provider work happen in the app-side action. The fake provider's separate mutation intentionally receives a **fake** refresh token to simulate the remote issuer; it is not a credential-store operation.

## What passed

### `convex-test`

1. Competing claims, idempotent completion replay, and stale-owner write/renew rejection.
2. Lease expiry, fenced transfer, and rejection of late completion and invalid lease durations.
3. Session-binding mismatch without consumption, expiry rejection, and single-use authorization attempts.
4. AES-GCM round trip, ciphertext-only storage, and rejection of wrong keys, tampering, swapped connection keys, or altered expiry metadata.
5. App-side Effect orchestration through component functions and a mocked local HTTP route; one refresh for concurrent callers, redacted results, timers, interruption, and scoped cleanup.

The additional checks in `tests/facade.check.ts` cover:

- The same manager through native and Promise execution; provider-specific result inference and rejection of query-only capabilities for credential workflows.
- Query-only inspection without keys, credential payload reads, or writes; storage failure stays a failure rather than a fabricated disconnected state.
- Structured storage/cipher/provider/application failures; expired handles; scoped-child lifetime and cleanup on callback success/failure.
- Abort-signal cleanup while an application callback remains pending; library handles close, but non-cooperative application Promises are not magically cancelled.
- Completion response loss injected **after the component applies the write**, traversing the actual adapter and manager. Retries reuse the identical payload object, ciphertext, IV, write ID, and ownership. One provider exchange and one encryption occur for that completion.
- A newer stored authorization cannot be overwritten by a stale retry; retry exhaustion is bounded and later retrieval can read the committed result without another exchange.
- A successful refresh on the final polling iteration is re-read instead of incorrectly failing as pending; an already-expired provider result preserves its rotated refresh credential without an unbounded exchange loop.

### Real anonymous local backend

- The CLI installed the component and generated actual component references/types; the main app schema contains no credential tables.
- **Default Convex action runtime** successfully executed Effect, Web Crypto AES-GCM, cryptographic randomness, timers, a local `fetch`, timeout interruption, and finalizers. A scoped child fiber was confirmed finalized before `Convex.run` returned. No `"use node"` fallback was needed.
- Eight concurrently requested app actions obtained usable, redacted fake credentials. The HTTP fixture independently recorded **one HTTP attempt** and **one successful provider exchange**; the credential record advanced through one claim and one completion.
- The query-only inspection path executed on the backend with a key getter that throws if invoked; saved and missing records returned only the selected booleans.
- The Promise facade performed a fake HTTP refresh, survived an injected after-apply completion acknowledgement loss with one encryption and two identical writes, and returned usable credentials only after persistence. Independent issuer counters measured one HTTP attempt/exchange. Escaped handles rejected and scoped finalization completed before return.
- A separate connection was processed independently through the same configured manager.
- Twelve simultaneous claim mutations produced one winner. The HTTP client's default mutation queue was explicitly bypassed with `skipQueue: true`, so this exercised backend OCC rather than client-side serialization.
- Repeated completion was recognized without another write; stale completion and renewal were rejected. Expired storage ownership transferred with a higher fence, without claiming that transfer permits a new OAuth exchange.
- Concurrent attempt consumption returned one result, with binding and expiry enforced.
- Both listeners stopped after the run. SIGINT/SIGTERM cleanup and loopback-only socket bindings were also verified.

The assertions in `tests/component.check.ts`, `tests/facade.check.ts`, and `scripts/local.ts` are the repeatable evidence. Live local checks have passed repeatedly. Mock checks alone would not have established the default-runtime compatibility or real OCC results.

## Limits and next design work

- This is a representative subset, not the seven-operation store contract. There is no checkpoint operation, durable retry budget, response journal, full initial-enrollment/replacement/deletion protocol, automatic recovery, or lease-renewal loop in the driver.
- The component can transfer eligible storage ownership, but the app-side workflow deliberately refuses to take over any pending operation. Provider-safe recovery after worker death remains separate work.
- Completion acknowledgement loss is now tested through the full adapter and manager, in mocks and the real local runtime. That bounded retry retains its prepared payload only within the invocation. Re-executing the whole completion Effect creates another payload; there is no durable cross-worker response/payload recovery in this adapter. The [lifecycle experiment](../lifecycle/README.md) separately models durable evidence with fake storage.
- The fake issuer has strict single-use tokens and runs locally. No Salesforce/Zoho/Shopify contract or actual OAuth protocol is implemented or validated.
- The concurrency smoke submits simultaneous calls but is not a scheduler-level overlap proof for every action. The separate unqueued mutation test supplies direct storage-contention evidence; the earlier fake refresh experiment provides controlled interleavings.
- The crypto code uses a hard-coded **fake test key** supplied through the app environment, not production key provisioning. Key IDs, rotation, envelope version migration, secret-source interfaces, and secure metadata design still need work.
- A single component instance and arbitrary fixture connection keys are used. Provider-specific shared-authorization coordination keys and permission checks are not solved by this experiment.
- Timeout/finalizer, scoped-fiber, and explicit abort cleanup are checked. Cancellation cannot undo already-dispatched Convex mutations, non-cooperative application Promises, detached work, or late remote side effects.
- Component mutations remain transactional storage work. Parent queries can execute the read-only inspection Effect; credential workflows and provider calls remain in actions. The fixture status query is local-only, not a production-authorized public endpoint.
- This does not establish hosted deployment limits, all Node/default runtime combinations, schema migration behavior, component publishing/export layout, or cloud operational reliability.

## Files

- `src/component/`: component-owned schema and transactional operations, with generated types.
- `src/adapter.ts`: Effect/Promise invocation bridges, read-only inspection, Web Crypto encryptor, and minimal credential workflow with immutable completion retry.
- `src/convex/`: consuming app configuration, actions, local fake HTTP issuer, and test-only wrappers.
- `tests/component.check.ts`: original storage/runtime mock checks.
- `tests/facade.check.ts`: facade, inference, disposal/cancellation, metadata-only queries, adapter acknowledgement loss, and wait-boundary regression checks.
- `src/convex/facadeProbes.ts`: local-only real-runtime inspection and facade/acknowledgement probes.
- `scripts/local.ts`: isolated anonymous backend lifecycle and real-runtime smoke checks.
- `scripts/loopback.cjs`: runner-only bind-interface/privacy guard for the pinned CLI.

## References

- [Convex components](https://docs.convex.dev/components/using)
- [Component authoring](https://docs.convex.dev/components/authoring)
- [Anonymous local development](https://docs.convex.dev/cli/local-deployments)
- [convex-test and its limitations](https://docs.convex.dev/testing/convex-test)
- [Runtime restrictions](https://docs.convex.dev/functions/runtimes)
- [OCC and atomicity](https://docs.convex.dev/database/advanced/occ)
