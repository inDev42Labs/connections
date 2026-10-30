# Testing Connections

Tests describe guarantees through interfaces that consumers or production infrastructure use. A test should survive a change to the implementation when those guarantees remain unchanged. Test names describe features, outcomes, or safety properties rather than helper functions and command sequences.

The [reference](reference.md) owns consumer behavior; the [constitution](../CONSTITUTION.md) requires executable evidence for security, coordination, recovery, and public types. Tests do not turn deferred custom integrations into supported extension interfaces.

## Choose a testing seam

A testing seam is the interface through which a test exercises and observes behavior. Use these seams:

| Seam | What to exercise and observe | Evidence limits |
| --- | --- | --- |
| Consumer operations | Create a manager with built-in integrations. Enroll, authorize, read, report rejection, inspect, replace, and remove. Assert returned credentials, actionable failures, and subsequent behavior. | A local provider substitute does not establish live-provider compatibility. |
| Provider HTTP interaction | Enter through manager operations and substitute the external provider at HTTP. Assert destinations, required parameters, encoding, callback validation, retry timing, cancellation, and duplicate dispatch prevention. | A fetch substitute does not prove real HTTP transport behavior; use a local server when redirects or transport behavior matter. |
| Store atomicity and persistence | Exercise the store operations used by production workflows against each adapter. Verify conditional writes, immutable replay, stale-writer fencing, bounded recovery, corruption handling, and reopening persisted state. | Memory and local database substitutes do not prove real PostgreSQL locking or cloud execution. |
| Encryption | Exercise the built-in AES-GCM encryptor for authentication, tampering, identity substitution, and invalid key material. Also verify protected persistence and secret-safe output through managers and stores. | An encryptor round trip alone does not establish that workflows persist only encrypted secrets. |
| Public types and packaged consumption | Compile accepted usage and rejected misuse. Import and use the packed package through supported entry points. | Source compilation alone does not establish that published artifacts work. |
| Process loss and adapter execution | Interrupt actual workers and reopen storage. Exercise Convex invocation binding and its query/action capabilities through the adapter. | In-process interruption does not replace process-loss evidence; local Convex does not prove a cloud deployment. |

Consumer operations are the default seam. Keep focused Promise/Effect parity checks; do not duplicate every workflow solely to exercise both execution styles. Use store and encryption contracts where their guarantees need direct evidence rather than forcing every check through an end-to-end workflow.

A new testing seam requires owner agreement. Extracting a helper or adding an internal module does not create a reason to test it separately.

## Assert guarantees, not mechanics

| Prefer | Avoid |
| --- | --- |
| Concurrent readers receive the same renewed credentials after one provider exchange. | A specific number of internal acquire, reserve, or completion commands. |
| A lost store acknowledgement does not repeat a remote exchange or lose committed credentials. | The exact number or order of store retries. |
| A delayed response cannot overwrite replacement credentials. | A particular generation or revision number in a consumer test. |
| Inspection works without provider requests, decryption, or mutation capability. | Exactly one metadata read. |
| Construction succeeds without resolving runtime configuration. | A configuration getter runs exactly once during later work. |
| A second renewal uses the rotated refresh token. | The exact serialized private provider payload after the first renewal. |
| Independent storage clients cannot both win conflicting work. | Exact SQL statement counts or a prescribed locking mechanism. |

Remote request counts are appropriate when they establish a guarantee such as avoiding duplicate one-use exchanges. Observe requests at the HTTP substitute rather than calls between internal collaborators. Compare decoded request semantics rather than incidental object classes or form-field ordering.

Exact declarations deserve exact checks when they are part of a compatibility or security contract: historical persisted records, command digests, encryption identity, public result fields, and package exports. Keep those checks at their owning seam. Shared pure protocol checks run once, not once per adapter when they do not exercise the adapter.

Exercise application-supplied authorization callbacks through the library, including denial and the recovered target and intent. Keep application-owned route permission examples distinct from library regression tests; a permission wrapper defined only inside a test cannot establish library enforcement.

## Substitute dependencies at the seam

- Use real built-in managers, providers, encryptors, and store implementations for ordinary feature scenarios. Prefer disposable databases where persistence matters.
- Substitute external provider HTTP, time, and infrastructure failures. Keep reusable controls in test fixtures rather than production-only test hooks.
- Fault fixtures may hold storage operations, lose acknowledgements, seed historical data, or corrupt saved data. They may know private representations to arrange those conditions; feature assertions still observe the chosen seam.
- Inspect raw persistence when proving encryption at rest, absence of secret leakage, format compatibility, or atomicity. Use credential reads and later operations to prove ordinary lifecycle outcomes.
- Use deterministic clocks and explicit checkpoints for races. Avoid arbitrary sleeps and scheduling-dependent call counts.
- Verify nontrivial fixture behavior separately from product features. Do not copy the production lifecycle engine into a fake store or provider.

Refactor fixture setup before adding production abstractions solely for testing. Accept dependencies where they actually vary, but do not expose private contracts or expand public configuration merely to reach an internal branch.

## Preserve coverage when replacing tests

For each coherent migration:

1. Identify every distinct guarantee, failure case, and concurrency or interruption condition in the old tests. Separate implementation assertions from required behavior.
2. Map each guarantee to an existing behavioral assertion or add its replacement at an approved seam. Executing the same path is not proof that the replacement detects the same failure.
3. Establish the baseline, then run the replacement checks. Where practical, temporarily break the relevant behavior and confirm the replacement fails; restore the implementation before verification and commit.
4. Remove superseded checks only after their meaningful guarantees have replacement evidence. Keep infrastructure, security, compatibility, and process-loss evidence that broader tests cannot establish.
5. Run repository checks and the relevant integration path. Report unavailable prerequisites and evidence limits.

Preserve meaningful pathways and failure coverage, not test counts or coverage percentages alone. Do not remove branches, relax expected outcomes, change persisted formats, or change encryption identity as a shortcut to simplifying tests.

## Run verification within scope

Use the prerequisites and commands in [Develop this repository](../README.md#develop-this-repository); `package.json` declares the commands. Run `bun run check` for changed maintained tests and the relevant integration path, such as `bun run test:convex` for Convex changes or `bun run test:process-loss` for worker-loss scenarios.

Use `bun run verify` for the broader local paths when their prerequisites are available and authorized. Packed-package and local Convex runners can require downloads; real PostgreSQL verification requires explicit authorization and a disposable backend. Do not infer live-provider validation or deployment from local substitutes.
