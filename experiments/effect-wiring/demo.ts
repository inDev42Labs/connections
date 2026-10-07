// THROWAWAY DESIGN EXPERIMENT. Run: bun experiments/effect-wiring/demo.ts
// All secrets and database rows below are fake. No external requests are made.
import assert from 'node:assert/strict'
import { ConfigProvider, Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import {
  Connections,
  Configuration,
  FakeDatabase,
  FakeStore,
  MissingConnection,
  Resend,
  Salesforce,
} from './model'

// 1. Configure once. This does not read a row or resolve a secret.
const store = FakeStore.store()
const salesforce = Connections.oauth({
  namespace: 'salesforce-production',
  provider: Salesforce,
  store,
})
const resend = Connections.apiKey({
  provider: Resend,
  key: Configuration.secret('RESEND_API_KEY'),
})

// 2. Ordinary application code has no database-client argument.
const getCredentials = (id: string) => Effect.gen(function* () {
  const connection = salesforce.connection(id)
  const { accessToken, instanceUrl } = yield* connection.credentials()
  return { accessToken, instanceUrl }
})

// 3. Supply the application's existing client once at startup.
let reads = 0
let bindings = 0
let releases = 0
const rows = new Map([
  ['salesforce-production/conn_acme', {
    accessToken: 'FAKE-acme-token',
    instanceUrl: 'https://acme.example.invalid',
  }],
  ['salesforce-production/conn_globex', {
    accessToken: 'FAKE-globex-token',
    instanceUrl: 'https://globex.example.invalid',
  }],
])
const existingDatabaseClient: FakeDatabase['Service'] = {
  read: (namespace, id) => Effect.gen(function* () {
    reads++
    const row = rows.get(`${namespace}/${id}`)
    return row === undefined
      ? yield* Effect.fail(new MissingConnection({ connectionId: id }))
      : row
  }),
}

// Layer.succeed(FakeDatabase, existingDatabaseClient) is the minimal wiring.
// This instrumented layer additionally proves one acquisition and one release
// across multiple runtime calls. It does not close the application-owned client.
const DatabaseLive = Layer.effect(FakeDatabase, Effect.acquireRelease(
  Effect.sync(() => {
    bindings++
    return existingDatabaseClient
  }),
  () => Effect.sync(() => { releases++ }),
))
const runtime = ManagedRuntime.make(DatabaseLive)

assert.equal(reads, 0)
assert.equal(bindings, 0)

try {
  const acme = await runtime.runPromise(getCredentials('conn_acme'))
  const globex = await runtime.runPromise(getCredentials('conn_globex'))
  await runtime.runPromise(getCredentials('conn_acme'))

  assert.equal(Redacted.value(acme.accessToken), 'FAKE-acme-token')
  assert.equal(Redacted.value(globex.accessToken), 'FAKE-globex-token')
  assert.equal(acme.instanceUrl, 'https://acme.example.invalid')
  assert.equal(globex.instanceUrl, 'https://globex.example.invalid')
  assert.equal(bindings, 1)
  assert.equal(reads, 3)
  assert.ok(!JSON.stringify(acme).includes('FAKE-acme-token'))
  console.log('OAuth-shaped retrieval: distinct connections, redacted tokens, one database binding.')

  const missingId = await runtime.runPromise(
    getCredentials('missing').pipe(
      Effect.match({
        onFailure: (error) => error instanceof MissingConnection ? error.connectionId : 'unexpected',
        onSuccess: () => 'unexpected success',
      }),
    ),
  )
  assert.equal(missingId, 'missing')

  // The exact same manager can run with a different application-provided client.
  const alternativeRuntime = ManagedRuntime.make(Layer.succeed(FakeDatabase, {
    read: () => Effect.succeed({
      accessToken: 'FAKE-alternative-token',
      instanceUrl: 'https://alternative.example.invalid',
    }),
  }))
  try {
    const alternative = await alternativeRuntime.runPromise(getCredentials('conn_acme'))
    assert.equal(Redacted.value(alternative.accessToken), 'FAKE-alternative-token')
  } finally {
    await alternativeRuntime.dispose()
  }
  assert.equal(reads, 4)
  console.log('Infrastructure swap: same configured manager, different runtime/client.')

  // A deterministic substitute for process environment; still exercises Config.redacted.
  // No FakeDatabase layer is supplied to this program.
  const staticProgram = resend.credentials().pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      RESEND_API_KEY: 'FAKE-resend-key',
    }))),
  )
  const { apiKey } = await Effect.runPromise(staticProgram)
  assert.equal(Redacted.value(apiKey), 'FAKE-resend-key')
  assert.equal(reads, 4)
  console.log('Static key: resolved without a database or Connections runtime.')
} finally {
  await runtime.dispose()
}
assert.equal(releases, 1)
console.log('PASS: lazy setup, shared dependency lifetime, runtime isolation, static key, cleanup.')

// Compile-only checks. Never execute these deliberately invalid calls.
export function checkPublicTypes() {
  const oauthCredentials = salesforce.connection('conn_acme').credentials()
  // @ts-expect-error OAuth-shaped retrieval still requires FakeDatabase.
  Effect.runPromise(oauthCredentials)

  // Unlike OAuth-shaped retrieval, API-key retrieval requires no database service.
  const staticCredentials: Effect.Effect<
    { apiKey: Redacted.Redacted<string> },
    Effect.Error<ReturnType<typeof resend.credentials>>,
    never
  > = resend.credentials()
  void staticCredentials

  Effect.gen(function* () {
    const { accessToken, instanceUrl } = yield* oauthCredentials
    const token: Redacted.Redacted<string> = accessToken
    const url: string = instanceUrl
    void token
    void url
    // @ts-expect-error A redacted secret is not a plain string.
    const plain: string = accessToken
    void plain
    // @ts-expect-error Salesforce's inferred result has no apiKey field.
    const { apiKey } = yield* oauthCredentials
    void apiKey
  })
}
