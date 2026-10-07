# Effect wiring experiment

**Historical design evidence, not the target API.** This throwaway experiment tests Effect wiring for the earlier interface. Use [the consumer reference](../../docs/reference.md) for current target behavior; this is not a package export or production implementation.

For current guidance, see the [product orientation](../../README.md). The original implementation plan is retained in Git history, not in active specifications.

## Question

Can a configured connection manager return Effects that obtain an application's existing infrastructure through layers, without passing infrastructure to every operation or hiding a runtime inside the library? Can the static-key path avoid the database dependency entirely?

## Run

From the repository root:

```sh
bunx --no-install tsc --noEmit -p experiments/tsconfig.json
bun experiments/effect-wiring/demo.ts
```

No database, network access, environment setup, or additional dependencies are needed. All secrets and records are fake. The final output should be:

```text
PASS: lazy setup, shared dependency lifetime, runtime isolation, static key, cleanup.
```

## The caller's experience

The prototype's minimal wiring is:

```ts
const store = FakeStore.store()
const salesforce = Connections.oauth({
  namespace: 'salesforce-production',
  provider: Salesforce,
  store,
})

const DatabaseLive = Layer.succeed(FakeDatabase, existingDatabaseClient)
const runtime = ManagedRuntime.make(DatabaseLive)

// Later, at an application entry point:
try {
  const use = await runtime.runPromise(
    salesforce.connection('conn_acme').credentials(),
  )
  // Pass use.credentials to your existing SDK.
} finally {
  // Application shutdown, NOT after each request in a long-running server.
  await runtime.dispose()
}
```

`existingDatabaseClient` is the application-owned fake client in `demo.ts`. `Layer.succeed` provides it; it does not acquire or close the client. The runnable demo instruments a scoped layer to count acquisitions and releases instead.

Application code already inside an Effect uses:

```ts
const use = yield* salesforce.connection('conn_acme').credentials()
```

`yield*` appears inside `Effect.gen`. The manager does not run the Effect. The application supplies infrastructure and decides when to execute it. An application with an existing Effect runtime would extend its own layer composition rather than create a separate Connections runtime.

## Observed result

Verified locally using the installed Effect 4 package, the dedicated `experiments/tsconfig.json` typecheck, and the demo:

- Constructing a manager does not bind the database or read credentials.
- Multiple executions through one managed runtime reuse a single database layer acquisition, released when that runtime is disposed.
- Different connection IDs return distinct fixture credentials.
- The same manager uses a different database implementation when run through a different runtime: it does not capture infrastructure globally.
- A missing fixture produces a typed failure.
- The Salesforce result infers `accessToken: Redacted<string>` and `instanceUrl: string` from the provider's schema.
- The compiler rejects executing the database-dependent Effect without supplying its dependency, treating the token as a plain string, and reading an API-key field from Salesforce credentials. `@ts-expect-error` checks are inside an uncalled function so the invalid operations never run.
- `Config.redacted`, exposed through the experimental `Configuration.secret` alias, reads a fake configuration provider without a database requirement. Effect's normal configuration provider can read environment variables.
- Returned secrets remain redacted in JSON serialization.

This supports configured manager objects whose operations propagate Effect requirements; a manager need not itself be an Effect service. This is evidence for the direction, not acceptance of every prototype type or constructor.

## Limits

`model.ts` deliberately contains only the wiring necessary for this question. The fake store is read-only and unencrypted. Its interface is not a proposed production persistence contract. Provider schemas here only validate fake records; they do not constitute complete provider definitions.

No HTTP client, OAuth exchange, token refresh, authorization-attempt management, concurrency control, real SQL adapter, encryption, or production error mapping is implemented or validated. Schema errors in this experiment are not a settled public error contract. Do not use this code with real secrets.

The proposed AES/store composition and the exact existing-SQL-client interface still need separate validation. This experiment proves Effect dependency plumbing, not compatibility with a real Postgres pool or a deployment environment.
