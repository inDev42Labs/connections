# Use Connections with Effect

Use this guide when your application composes Effect programs. Configure a manager with `Connections.create` exactly as in [getting started](getting-started.md), then use `manager.effect` instead of its Promise methods. Both interfaces preserve the same results, failures, and lifecycle guarantees.

The examples reuse the configured `salesforce` manager from getting started. Your application supplies `currentUser`, `connectionId`, and `requireConnectionAccess`. Keep these programs on the server.

## Read credentials in a program

```ts
import { Effect } from 'effect'
import { revealSecret } from '@indev42/connections'

const readLimits = Effect.gen(function* () {
  yield* Effect.tryPromise(() =>
    requireConnectionAccess(currentUser, connectionId),
  )
  const { accessToken, instanceUrl } =
    yield* salesforce.effect.credentials(connectionId)

  return yield* Effect.tryPromise(() =>
    fetch(new URL('/services/data/v61.0/limits', instanceUrl), {
      headers: { authorization: `Bearer ${revealSecret(accessToken)}` },
    }),
  )
})

const response = await Effect.runPromise(readLimits)
```

The permission check and provider request belong to your application. Connections only supplies credentials. Reveal secrets at the provider-request boundary, not before it.

## Handle credential retrieval failures

Credential retrieval failures are typed in the Effect error channel. Handle them before running the program:

```ts
const read = salesforce.effect.credentials(connectionId).pipe(
  Effect.map((credentials) => ({ status: 'ready' as const, credentials })),
  Effect.catchTag('AuthorizationRequired', () =>
    Effect.succeed({ status: 'authorization-required' as const }),
  ),
)
```

Run this read only after checking application permission. This example handles missing authorization; `TemporarilyUnavailable` and `InterventionRequired` remain failures. See [retrieval failures](reference.md#handle-retrieval-failures) for the caller actions. Do not return credentials to a browser.

## Report a confirmed rejection

Use `credentialUse` when your application needs to report rejection of a specific credential read. Your application supplies `callSalesforce`:

```ts
const request = Effect.gen(function* () {
  yield* Effect.tryPromise(() =>
    requireConnectionAccess(currentUser, connectionId),
  )
  const use = yield* salesforce.effect.credentialUse(connectionId)
  const response = yield* Effect.tryPromise(() =>
    callSalesforce(use.credentials),
  )

  if (response.status === 401) {
    yield* use.reportRejected()
  }
  return response
})
```

Report only a confirmed credential rejection. A late report cannot invalidate newer credentials. Connections does not retry the provider request.

## Compose other operations

Supported setup, inspection, and removal methods also appear on `manager.effect`, with the same arguments as their Promise equivalents. For example, use `yield* manager.effect.setApiKey(id, apiKey)` or `yield* manager.effect.inspect(id)`. Provider capabilities determine which methods exist.

OAuth authorization callbacks keep their documented callback signatures; placing an operation in an Effect program does not change them. See the [method reference](reference.md#methods).

## Run the program

Use `Effect.runPromise(program)` for built-in managers without invocation requirements, or compose the program into your application's existing Effect runtime. Import `effect` directly in an Effect-native application.

In Convex, use `Convex.run(ctx, program)` to supply the current invocation. See [Convex Effect composition](stores/convex.md#compose-an-effect-program-instead). Cancellation cannot undo a provider request or storage mutation that has already been dispatched.
