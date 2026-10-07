# Throwaway lifecycle/recovery contract experiment

**Historical design evidence, not the target API.** Use [the consumer reference](../../docs/reference.md) for target public behavior. This program tests recovery assumptions with fake infrastructure; do not use its interface as production guidance.

**Question:** Can jobs keep using the current connection during browser replacement preparation, without losing strict recovery evidence or allowing unsafe refresh/exchange overlap?

**Finding:** Yes, with bounded callback admission and same-invocation consumption retries, under the fake atomic-store and provider assumptions below. Opening, abandoning, expiring, or superseding an authorization page does not block existing credentials or refresh. The uncertainty boundary begins at the durable code-exchange reservation, not page creation. Lease or attempt expiry never grants permission to repeat an uncertain exchange. This is executable design evidence, not a production adapter or accepted public API.

This revision explored continued use during browser replacement preparation, without promising zero downtime. Current behavior is described in [the consumer guide](../../docs/getting-started.md); the mechanisms here remain experimental.

## Run

From the repository root, using the already-installed root dependencies:

```sh
bun experiments/lifecycle/demo.ts
bun experiments/lifecycle/process-demo.ts
bunx --no-install tsc --noEmit -p experiments/tsconfig.json
```

The first command runs deterministic assertions, not the root test suite. It exits nonzero on failure and has a ten-second watchdog. Expected final line:

```text
ALL LIFECYCLE CHECKS PASSED (168 fresh managers/runtimes; fake storage/provider; no process-kill proof).
```

The original demo reports **47 PASS scenarios**. The process demo adds the actual-process checks below. The final command checks the root-dependency experiments through their opt-in TypeScript configuration; successful output is empty. No installations, cloud resources, or real provider calls are needed.

## Files and context

- `model.ts`: one Effect-first credential workflow; lifecycle methods and injectable service contracts.
- `store.ts`: fake atomic backend, retained operation history, ownership fences, mutation receipts, attempts, and removal tombstones.
- `fakes.ts`: fake provider with deliberately narrow replay assumptions.
- `demo.ts`: assertions, interrupted workers, delayed workers, fresh managers/clients/contexts/runtimes.
- `process-store.ts`: disposable SQLite adapter around the same fake atomic algorithms; separate credential and provider database files.
- `process-worker.ts`: child entrypoint using `model.ts`, plus direct receipt conformance assertions.
- `process-demo.ts`: parent watchdog, controlled SIGKILL checkpoints, fresh-process recovery, and scratch cleanup.

This explores a historical recovery and store design whose specification and implementation plan are retained in Git history. Unlike the [earlier refresh experiment](../refresh/README.md), refresh recovery does not require the original manager, runtime, ownership token, or request stack. Callback consumption ACK recovery is narrower: it requires the same executing invocation before dispatch. These files own only this experiment's findings; they do not revise the accepted feature artifacts.

## Contract choices tested

| Boundary | Experimental guarantee |
| --- | --- |
| Claim | Atomic revision check; one owner; store-clock lease. Transfer retains operation ID, first-send time, send count, budget, policy, and staged result. |
| Claim acknowledgement | A request key identifies the original acquisition, not a request to acquire again. Replay returns its ticket only while still owned and unexpired; otherwise it conflicts. |
| Ownership | Every progress write checks operation, lifecycle generation, fence, and unexpired lease. Expiry alone rejects writes, even before takeover. |
| Renewal | Extends only a live matching owner. Retrying the same renewal does not extend twice; expiry cannot be revived. |
| Send reservation | Atomic checkpoint before dispatch records earliest possible send and consumes one of **three total sends**. Input includes expected count and a library-derived deadline. Repeating the checkpoint does not consume another send. |
| Replay | Workflow combines retained policy, first-send time, original refresh expiry, and remaining budget. Taking ownership never clears uncertainty. |
| Stage/complete | A known response is durably staged, then committed without another exchange. Receipt input must match exactly. An aged staged access token is committed before a new operation refreshes using its replacement refresh token. |
| Completion acknowledgement | Identical completion is safe after its owner is cleared. A later operation or lifecycle generation invalidates that receipt's success path. |
| Browser preparation | Starting replacement supersedes only the previous unconsumed page. It does not advance credential generation, detach refresh history, reset budgets, or block retrieval/refresh. Default enrollment cannot overwrite saved authorization. An expired page disappears from the read-only pending projection without changing credentials. |
| Exchange coordination | `consume` validates binding, expiry, and current attempt ID, then atomically refuses any unresolved refresh or previous exchange. Refusal leaves the page unconsumed. On success it advances generation, detaches only completed refresh history, and records a durable possible-exchange marker before dispatch. |
| Exchange uncertainty | Retrieval and new authorization starts return `busy` during a fixed ten-millisecond callback admission window, then `attention` while the unresolved marker remains. Expiry grants neither takeover nor replay. Callback replay is single-use and cannot dispatch again. A known response may commit after expiry; removal clears local state but is not remote reconciliation. |
| Replacement success | A matching reserved attempt commits tokens and clears the marker; connection ID stays `workspace-crm`. The new grant enters ordinary refresh. Old refresh and callback writes remain fenced. |
| Removal | Clears local credentials and pending intent, advances a retained generation tombstone, and makes no provider call. An old removal receipt cannot delete deliberate later enrollment. |
| Authorization attempt | Unique, expiring, binding-checked, single-use attempt. A start retry requires identical input and a still-current live preparation. `consume` retries a lost acknowledgement only within the same executing workflow, using a stable internal invocation key and identical attempt ID/binding. Its receipt returns only the unchanged, live reservation, without extending its deadline. A new callback invocation cannot reuse browser consumption. Persistence binds the entire reservation, including intent and invocation, plus token payload. Completion rechecks generation after exchange. |
| Inspection | Separate read-only Effect service returns only selected booleans and connection ID. `pendingAuthorization` means live browser preparation; `unresolved` includes refresh or possible authorization exchange; `attention` excludes an exchange with live admission and includes an expired exchange marker; `unresolved: true, attention: false` represents pending callback work. Inspection never renews admission or mutates evidence. It needs no Provider, Worker, mutation capabilities, or secret keys. |

Receipts bind method, request ID, and input. Callback admission lasts ten fake milliseconds from consumption, independently of browser expiry. Its receipt is not a reusable dispatch ticket: only the trusted workflow retries consumption before its single provider call; the store cannot police a malicious caller that dispatches repeatedly outside that workflow. A duplicate progress write from an expired/superseded owner conflicts rather than reporting current ownership; a new worker reconciles through stored evidence. Successful claim receipts are retained even when the owner expires. Forgetting those receipts while accepting old request keys could resurrect acquisition.

Storage knows atomic conditions and supplied records; the workflow decides replay. The fake store does not implement provider policy. A provider transport failure returns `unknown`, not revoked authorization. A subsequent `.credentials()` call can recover after lease expiry. `attention` records that this experiment cannot justify automatic continuation.

## Executable evidence

Assertions cover:

- Interruption/disposal before reservation: a fresh worker safely sends once.
- Interruption after reservation but before dispatch: strict recovery refuses replay **even though this test knows no request was sent**. A possible-send marker cannot prove non-delivery.
- Lost strict response or worker loss after provider processing: no replay.
- Worker loss after staging: fresh worker completes without another provider exchange.
- Reusable and conditional recovery across three workers with the same first-send time and total budget; exhaustion stays exhausted across additional workers.
- Conditional window and refresh-expiry boundaries; ownership transfer cannot replace stored policy/budget with more permissive caller values.
- Lost acknowledgements for claim, renewal, reservation, staging, completion, replacement initiation, authorization persistence, and removal.
- Competing claims/transfers, expired renewal, fenced checkpoints/completion, and delayed workers resuming after removal.
- Valid existing credentials remain usable without provider IO during live abandoned and expired preparation; expired access credentials refresh during either phase.
- Competing/superseded pages and concurrent callbacks; start receipts bind payload and cannot renew expired or superseded pages.
- Callback attempts against claimed, reserved, response-received, and staged refresh states cannot overlap refresh, even after lease expiry. Recoverable refresh finishes before callback; strict uncertainty remains blocked with history retained.
- Reusable/conditional unknown-refresh recovery during preparation retains operation ID, first-send timing, policy, and budget through replacement.
- Callback interruption before dispatch or after response, and lost exchange responses, retain uncertainty through expiry and refuse replay or a competing replacement. A lost consumption acknowledgement recovers within the same live invocation and produces exactly one fake exchange; changed input, another invocation, and expired/superseded receipts cannot acquire permission.
- Reserved callbacks exclude refresh; known late responses may commit after page expiry. Removal before dispatch prevents the fake call; removal after processing fences the write.
- Explicit replacement preserves ID and rejects silent enrollment overwrite; binding mismatch does not consume an attempt; repeated completion does not exchange again. Authorization persistence retries enforce token payload identity and cannot overwrite a later replacement.
- Inspection's exact non-secret shape, unchanged backend state/mutation count, and unchanged provider counters, using a read-only service alone.
- A replacement grant proceeds into ordinary refresh under the same connection ID after its access token expires.

## Actual-process verification

`bun experiments/lifecycle/process-demo.ts` uses Bun's `node:sqlite` `DatabaseSync`, root dependencies, and an owned `mkdtemp` directory. These process/signal checks require POSIX behavior and are verified on Linux. It runs **18 OS workers and 9 confirmed SIGKILL exits**, with a 30-second watchdog. No user database, Convex backend, cloud resource, HTTP request, or real credential is involved. Recovery workers execute the unchanged `model.ts` Effect workflow with fresh UUID request namespaces.

| Controlled kill checkpoint | Asserted result in a fresh process |
| --- | --- |
| Claimed, before send reservation | Stored sends=0; recovery succeeds; total calls=processed=1. |
| Fake strict provider committed a lost response | Provider rotated to `FAKE-refresh-1` while storage still has `FAKE-refresh-0`; recovery returns `attention`; calls=processed=1, no replay. |
| Strict response received, not staged | Recovery returns `attention`; calls=processed=1, no replay. |
| Response staged | Recovery commits `FAKE-access-1`; calls=processed=1, no additional exchange. |
| Two reusable workers killed after provider commit | Third worker recovers, retaining operation ID=1, firstSend=100, maxSends=3, sends=calls=3. With continuing response loss, two further workers return `attention` without resetting exhaustion. |
| Receipt fixture reserved an authorization | Fresh process verifies immutable consumption receipt/binding, stale claim/renew/checkpoint/complete fencing, authorization payload identity, history retention, and removal receipt safety after reenrollment at generation=3. No provider call is made by these direct storage assertions. |

Each local mutation acquires `BEGIN IMMEDIATE`, loads **all** fake state, executes the existing synchronous algorithm, serializes all state, and commits before returning. Public read/inspection methods use SELECT-only paths; SQL update-audit triggers verify that inspection, state reads, and constructing provider work issue no writes. Export/restore helpers include receipts, generations, revision/serial/mutation counters, clock, history, attempts, pending/exchange/reservations/results, lost-ACK counters, and all provider counters/replay state. Modeled failures are captured as Effect `Result` inside the transaction: `ack-lost` must retain a committed write, and provider `unknown` must retain processing. SQLite errors and defects are not converted to `unknown` or `attention`. Effect construction does not execute store/provider operations.

The fake provider commits in a **separate database transaction**, with no credential transaction open. A subsequent credential error or worker kill cannot roll back that provider effect. This is a test adapter with trusted JSON, not a production schema, migration system, or second orchestration engine.

The parent kills only child handles it owns, awaits their exits, closes local connections, and recursively removes only its scratch directory on success, failure, watchdog expiry, or SIGINT/SIGTERM/SIGHUP. Optional cleanup probes deliberately exit nonzero:

```sh
LIFECYCLE_TEST_ABORT=failure bun experiments/lifecycle/process-demo.ts
LIFECYCLE_TEST_ABORT=signal bun experiments/lifecycle/process-demo.ts
```

Successful final lines:

```text
ALL PROCESS CHECKS PASSED (9 SIGKILLs; 18 OS workers; controlled checkpoints; fake provider).
CLEANUP VERIFIED: all owned workers reaped; scratch directory absent
```

**These checkpoints are controlled, not exhaustive power-loss, mid-transaction, or remote-ordering proof.** The provider remains fake and synchronous; the clock is persisted but manually advanced, not distributed time. SQLite serializes the adapter's load/apply/save operations, but this suite does not stress competing processes or arbitrary transaction interruption. Parent SIGKILL, machine loss, or filesystem failure cannot guarantee automatic cleanup. No production durability, encryption, safe pruning, or real-provider behavior is established. The consumer journey links this narrower process-loss evidence without treating it as a production durability guarantee.

## Fake assumptions and honest limits

**The original `demo.ts` still models storage durability.** A `FakeDatabase` object outlives its workers; synchronous mutations stand in for serializable transactions and snapshots are copied. Its worker-loss tests interrupt an Effect and dispose its runtime without releasing ownership. New managers, store clients, contexts, and managed runtimes recover from that shared backend. Separate delayed-worker tests resume old workflows after a lifecycle change and assert failure. Only `process-demo.ts` adds disk serialization and independent OS worker termination.

**Provider assumptions are deliberately stronger than generic OAuth:**

- **Browser preparation has no credential-changing side effects until code exchange.** Opening the page, consent, abandonment, and expiry cannot invalidate the current grant in this fake. This must be verified per real provider; permission to refresh during preparation cannot be generalized to providers with earlier credential-changing effects.
- Strict tokens are single-use; a processed request can rotate remotely while its response is lost.
- Reusable tokens remain reusable until known expiry. Concurrent/repeated refresh has no grant-invalidating side effect; earlier access tokens remain usable under this assumed contract. Mere non-rotation in a real provider would not establish this.
- Conditional replay returns the **same replacement response** within a fixed first-use window and original expiry, until that replacement is itself used. The fake enforces its own window/retirement checks. This is not a Shopify or other real-provider preset.
- The connection exclusively controls one provider authorization; no outside actor acquires/refreshes/revokes the grant. Stable provider configuration is assumed. External interference and cross-ID shared grants are not modeled. Acquiring a replacement grant changes the fake issuer's valid refresh token and clears old conditional replay permissions.
- Provider processing is synchronous. Delayed-worker tests pause outside provider processing and prove local write fencing, not remote request reordering or overlapping exchange safety.

Local fencing cannot cancel an already-dispatched request, make remote effects atomic with storage, recall issued credentials, or close the gap between the last local check and dispatch. Removal followed by deliberate reenrollment is locally fenced but does not prove remote safety against a delayed request from the removed lifecycle; it is not a recommended workaround for uncertainty. Safe replay must tolerate that gap and overlapping old requests. Durable staging reduces one loss window but cannot recover a response that never reached storage.

## Remaining engineering work and evidence limits

- **Recovery after credential-changing uncertainty:** page-only abandonment is no longer a blocker. An unresolved strict refresh cannot be bypassed by replacement, and an uncertain callback exchange cannot be superseded by another callback. Known late callback persistence can resolve its marker, but a lost response or interrupted worker has no automatic exchange reconciliation here. Production needs provider-specific outcome evidence, safe reauthorization/reconciliation, and an actionable intervention path. Expiry or a new page cannot supply that evidence.
- **Availability during exchange:** a fixed admission deadline separates active `busy` from expired `attention`. There is no callback renewal, takeover, or waiting. A stopped worker or lost response can remain classified as busy until the deadline; expiry indicates uncertainty, not proof that the worker stopped. Current tokens stay stored but are not served after reservation because exchange may invalidate them. No zero-downtime guarantee, cancel/rollback API, or recall of credentials already handed to jobs is provided.
- **Authorization recovery/security:** no URLs, state generation, PKCE, CSRF, binding cryptography, application permission hook, denial classification, or durable staging of callback responses. Consumption is acknowledgement-loss recoverable only before dispatch within the same executing invocation. A crash after consumption can still strand replacement even if dispatch never happened. Browser expiry is checked at consumption; admission expiry is checked immediately before dispatch. A known response can persist after both deadlines only against its unchanged reservation/generation. Invocation keys are trusted internal worker identities, not browser-supplied idempotency keys; the process demo uses UUID namespaces, but production invocation identity is not implemented.
- **Lease operation:** ten fake milliseconds, opportunistic renewals, no heartbeat during remote I/O, no waiting/polling/backoff. A live owner yields immediate `busy`; long exchanges can lose their lease. Production needs bounded waiting and renewal/cancellation policy.
- **Adapter contract:** receipts/history/tombstones are retained forever. Safe pruning, request-key scope, encrypted payload identity, production serialization/config migration, and production transactional implementation/conformance remain unsolved. The disposable SQLite adapter supplies only the narrow process-loss evidence above. One fixed connection ID is modeled, not namespaces or shared provider-authorization coordination.
- **Secrets and errors:** plaintext synthetic token strings are stored; only returned access tokens use Effect `Redacted`. Inspection is an explicit projection, not a general security audit. There is no encryption, permission enforcement, provider revocation, complete error taxonomy, schema validation, or malformed-provider-response testing.

The useful result is a smaller uncertainty boundary, not exactly-once OAuth. Redesigning from the accepted availability requirement separated inert preparation from possible exchange instead of merely clearing an old busy flag. Executable interruption, recovery, and stale-worker checks prove the modeled behavior; the additional SQLite process checks prove only controlled local recovery, not production adapter durability or real-provider semantics.
