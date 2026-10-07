# Refresh coordination experiment

**Historical design evidence, not the target API.** This throwaway experiment tests refresh and recovery assumptions, not a package export, OAuth implementation, or production persistence contract. Use [the consumer reference](../../docs/reference.md) for target public behavior. All credentials are fake and no network calls are made.

Related material: [project recovery rule](../../CONSTITUTION.md#pr-007-recover-only-from-defensible-evidence) and the [earlier Effect wiring experiment](../effect-wiring/README.md). The original lifecycle specification and provider research are retained in Git history. The experiment's provider profiles below are assumptions, not current adapter guarantees.

## Question

Does Effect help express and verify credential refresh when concurrent callers, refresh-token rotation, and partial failures interact? What guarantees must come from the store rather than Effect? Can the same workflow recover uncertain exchanges where provider behavior permits it, without retrying strict single-use tokens or exceeding known recovery conditions?

## Run

From the repository root:

```sh
bunx --no-install tsc --noEmit -p experiments/tsconfig.json
bun experiments/refresh/demo.ts
```

The final line should be:

```text
ALL REFRESH EXPERIMENT CHECKS PASSED (fake backend; no exactly-once claim).
```

- `model.ts`: the experimental refresh state machine and required capabilities.
- `fakes.ts`: three fake provider profiles, shared store, fault injection, and controlled expiry clock.
- `demo.ts`: assertions, deterministic interleaving gates, and a 10-second watchdog.

## Model and assumptions

Each fixture represents **one connection**. Two separately constructed managers and managed runtimes use distinct clients for one shared fake backend. They share neither an application-level lock nor a token cache. Both run in one JavaScript process: this simulates the atomic contract a shared database would provide; it does not test distributed database behavior.

The initial access token is expired. The fake provider has three profiles inspired by the documented distinctions, not complete vendor implementations:

- **Strict:** consumes each refresh token once. Unknown exchange outcomes are not replayed.
- **Reusable:** retains the original refresh token and omits it from successful responses. The manager preserves that token and any existing expiry metadata.
- **Conditional:** issues replacements while retaining the presented token until a replacement is used, its original expiry is reached, or thirty days elapse after first use. Each replay deliberately returns a different token pair: the workflow does not rely on identical-response replay.

`RecoveryBehavior` is an experimental internal value, not an accepted public provider schema. The conditional profile is a simplified lineage model; it does not specify all sibling-token, app-installation, or acquisition semantics of Shopify.

The store models:

```text
ready(version 0, old credentials)
    → atomic claim
refreshing(version 1, operation ID, old credentials)
    → fenced, idempotent commit
ready(version 2, replacement credentials, last operation ID)
```

Only one claimant can win a particular ready version. Other callers wait for a change and re-read. A commit must match both the pending version and operation ID. Repeating the same commit after a lost acknowledgement succeeds without applying the change again. An old operation cannot overwrite a later generation.

The marker is conceptually durable, but physically **only in memory in this experiment**. It has no automatic lease expiry or takeover. Waiting callers time out after 100 milliseconds; this demonstration setting is not a proposed production default and does not clear the marker. Notifications use Effect `Deferred` in the fake backend; production could use bounded polling or subscriptions with a version recheck. In-process Deferreds are not distributed coordination.

Expiry uses a manually advanced wall clock, not sleeps. Timeout/cancellation deadlines use the real clock. Gates force the important interleavings, including two clients observing the same initial version and a follower waiting while the provider has already rotated but has not returned its response.

## Verified scenarios

The original strict-profile checks remain:

| Scenario | Observed result |
| --- | --- |
| Negative control without a storage claim | Two refresh requests race; one is rejected by the single-use provider. |
| Eight calls across two managers/runtimes | One claim, one provider exchange, one committed generation; all callers receive the same redacted access token. Competing claims are exercised, not merely sequential cache hits. |
| Next access-token expiry | The subsequent exchange uses the replacement refresh token, not the original. Fresh reads do not call the provider. |
| Stale or mismatched commit | Wrong ownership, wrong version, and a write from an older generation are rejected. |
| Commit before waiter subscribes | The waiter sees the changed version instead of missing the notification and hanging. |
| One write failure before application | Retry the same save; leader and waiting follower succeed. One provider exchange, two save attempts, one applied commit. |
| Write applied but acknowledgement lost | Retry the same save idempotently; leader and waiting follower succeed. Still one exchange and one applied commit. |
| All three save attempts fail before application | Leader receives typed persistence uncertainty with the storage cause. The remote token has rotated, but replacements are not stored. Waiting and later callers time out without another exchange. |
| Provider rotates but its response is lost | Leader receives typed exchange uncertainty with the provider cause. No save is attempted and no caller retries the consumed refresh token. |
| Leader interrupted after remote rotation | The pending marker survives caller interruption in the shared fake backend. The waiting follower does not take over. |
| Waiting follower interrupted | Its wait resource is released before runtime disposal. The leader continues, commits, and a later caller succeeds. |
| Definite provider rejection | The manager returns the known rejection rather than relabeling it as an unknown provider outcome. No rotation or save occurs. |

The extension additionally verifies:

| Scenario | Observed result |
| --- | --- |
| Lost response with reusable or conditional behavior | The owner repeats the exchange under the same claim, saves the actual second response, and unblocks a waiting caller in another runtime. |
| A transient save failure after successful exchange recovery | Retries the identical save, not another exchange. Both profiles complete with two exchanges, two save attempts, and one applied commit. |
| Reusable response omits refresh fields | Existing refresh token and finite expiry metadata survive; the next refresh uses the same token. |
| Conditional replacement is used | The fake retires its predecessor; a direct request using the retired predecessor is rejected. |
| External retirement followed by an uncertain response | Recovery gets an explicit rejection and stops; it does not consume the remaining retry budget. |
| Continuous response loss | Both recoverable profiles stop after three exchange attempts; no credentials are committed. |
| Persistent save failure despite replay permission | Both profiles attempt only one provider exchange and three saves. Permission to replay does not justify exchanging again when the successful response is already known. |
| Store reports changed operation, version, or state | Each injected observation independently stops replay under obsolete ownership. These are guard checks, not an implemented takeover protocol. |
| Reusable token with known expiry | Recovery stops at that expiry without another provider request. |
| Conditional recovery after two hours | Succeeds: the obsolete one-hour limit is not hard-coded. |
| Conditional recovery at thirty days or original expiry | Stops locally without an inadmissible replay. |
| Conditional recovery without expiry evidence | Stops conservatively rather than inventing an expiry. |
| Two lost responses, each advancing sixteen days | Stops after two calls: retries do not reset the first-use clock. |

The public success result contains only a redacted access token. Internal refresh credentials are not returned or logged. All runtime fixtures are disposed and wait-resource counts are checked. The experiment type-checks; the executable checks also passed repeatedly locally. The assertions, not this prose, are the reproducible evidence.

## What this tells us about Effect

Effect helps with composing typed failures, sharing dependencies through layers, running concurrent work, bounding waits, interruption, resource cleanup, and targeting retry at one specific operation. The fake clock and Deferred gates let the demonstration reach meaningful interleavings without arbitrary sleep-based orchestration.

The valuable retry placement remains narrow: **retry a known idempotent save separately from recovering an uncertain provider exchange**. The strict profile never replays an uncertain exchange. The other profiles permit up to two retries when ownership still matches and the modeled timing/expiry conditions permit recovery. Definite rejection is never retried. This is one library-owned workflow consulting provider facts, not three duplicated refresh implementations.

Production retry policy must distinguish retryable failures and include appropriate backoff, rate-limit handling, and deadlines. This fixture intentionally uses immediate bounded retries and a single abstract unknown-response failure, not a complete network/HTTP error classifier.

The experiment supports keeping Effect as the implementation foundation. It does not benchmark Effect against a Promise implementation or prove that an equivalent plain-TypeScript design is impossible. Storage correctness still comes from the explicitly modeled atomic operations, not from Effect.

## Storage requirements suggested by the experiment

These are findings to inform design, not accepted public method names:

1. Atomically claim a specific credential version before performing a potentially rotating exchange.
2. Persist refresh ownership so other application instances can observe it.
3. Atomically save replacement credentials only for the matching operation and version.
4. Recognize a repeated save after an uncertain acknowledgement without overwriting newer credentials.
5. Let callers observe state changes with a bounded, cancellable wait or polling policy.

A naive `get`/`save` interface or a process-local mutex does not provide these guarantees. One physical store can still hide the required internal operations behind a small adapter-construction interface.

## What cannot be transparently recovered here

If the provider consumes the refresh token and the replacement is lost, the old token may be unusable. If credentials were received but every save fails, their only remaining copy may disappear when the operation/process ends. Effect cannot roll back the provider.

The extension demonstrates **automatic recovery within an active operation**, using the same owner and claim. If that bounded recovery is exhausted, disallowed, or interrupted, the prototype still keeps the claim and stops. It does not yet implement a second worker recovering an abandoned claim, or resuming after a process dies. Provider-supported replay makes such recovery worth designing, but does not itself solve safe ownership transfer.

The conditional fixture begins with a token not previously presented by another operation, and tracks the earliest request time locally for this call. A durable recovery protocol would need trustworthy persisted timing/generation evidence; it must not reset an existing recovery window when a new worker starts. Handling clock uncertainty and unknown prior use is not solved by this local prototype.

A production recovery policy may also need durable staging, explicit reconciliation, or renewed authorization. None removes every remote/local partial-failure window.

Automatically expiring the claim would not solve the uncertainty. A slow or interrupted original worker may already have caused rotation; a second worker could reuse an invalid token. Storage fencing protects local writes, not the external provider's side effects.

## Deliberate limits

- No actual OAuth HTTP exchange, provider response parsing, SQL, encryption, authorization-attempt storage, multi-connection isolation, or Promise-facing client. The fake profiles are not certified Salesforce, Zoho, or Shopify adapters.
- No implemented coordination with token acquisition, reauthorization, or external writers. A changed-ownership read and externally retired grants are injected to verify guards and terminal handling, not to claim a complete coordination protocol.
- No actual process crash/restart, cross-process notification, transactional database test, or exactly-once guarantee.
- Initial claim/read failures and ambiguous claim acknowledgements are not injected. A real adapter must not assume that an unacknowledged claim failed.
- No bounded provider-request timeout is designed; the runner watchdog is not a production policy. Late remote effects remain possible after interruption.
- A known rejection is distinguished for the initiating caller, but its durable authorization-required transition is not implemented. Its claim remains pending conservatively; later callers cannot infer a final diagnosis from that state.
- No production renewal, operator recovery, lease, durable response journal, or recovery of abandoned claims. Even interruption before the external call can leave the conservative marker behind.
- No full public error taxonomy: the experimental errors retain safe causes but are not proposed export names. Save conflicts are not retried and are reported as uncertainty for this bounded demonstration.
- No completed interface decision about these storage capabilities. Do not copy the fixture's single-record, unencrypted store into a real adapter.
