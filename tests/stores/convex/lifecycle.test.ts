// oxlint-disable vitest/no-conditional-expect -- Table branches assert mechanism-specific postconditions.
import { convexTest } from 'convex-test'
import { componentsGeneric, getFunctionAddress } from 'convex/server'
import { Cause, Effect, Exit, Layer, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import type {
  AuthorizationCallback,
  OAuthProviderDefinition,
  ProviderRefreshOutcome,
} from '../../../src/core/contracts/provider.js'
import { Connections, type ReadCredentialFailure as CredentialFailure } from '../../../src/index.js'
import { Convex, type ConvexInvocationContext } from '../../../src/stores/convex/index.js'
import { makeDeterministicClientCredentialsProvider } from '../../fixtures/client-credentials-provider.js'
import type { ComponentApi } from '../../../src/stores/convex/component/_generated/component.js'
import componentSchema from '../../../src/stores/convex/component/schema.js'
import { makeLifecycleDriver, makeTestClock } from '../../fixtures/lifecycle-driver.js'
import { assertSecretCanariesAbsent, makeSecretCanary } from '../../fixtures/secret-assertions.js'

const componentModules = import.meta.glob('../../../src/stores/convex/component/**/*.ts')
const installedComponent = componentsGeneric().connections as unknown as ComponentApi<'connections'>
const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)))
const drivers = new Set<{ readonly dispose: () => Promise<void> }>()

interface TestCredentials {
  readonly accessToken: Redacted.Redacted<string>
}

interface StoredTestCredentials {
  readonly accessToken: string
  readonly refreshToken: string
}

interface RefreshControl {
  readonly reached: Promise<void>
  readonly release: () => void
  readonly wait: () => Promise<void>
}

type CredentialOutcomeTag =
  | 'AuthorizationRequired'
  | 'TemporarilyUnavailable'
  | 'InterventionRequired'

type SafeCauseTag =
  | 'ProviderRejected'
  | 'ProviderFailure'
  | 'ProviderOutcomeUnknown'
  | 'StorageFailure'
  | 'EncryptionFailure'
  | 'Conflict'

function expectCredentialOutcome(
  failure: unknown,
  outcome: CredentialOutcomeTag,
  cause?: SafeCauseTag,
): void {
  expect(failure).toMatchObject(
    cause === undefined ? { _tag: outcome } : { _tag: outcome, cause: { _tag: cause } },
  )
  const actualCause =
    typeof failure === 'object' && failure !== null ? Reflect.get(failure, 'cause') : undefined
  expect(
    typeof actualCause === 'object' && actualCause !== null
      ? Reflect.get(actualCause, '_tag')
      : undefined,
  ).toBe(cause)
}

function controlledRefresh(): RefreshControl {
  let reached: () => void = () => undefined
  let release: () => void = () => undefined
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    reached: reachedPromise,
    release,
    wait: () => {
      reached()
      return released
    },
  }
}

function storedCredentials(value: StoredTestCredentials): Redacted.Redacted<string> {
  return Redacted.make(JSON.stringify(value))
}

function makeProvider(options?: {
  readonly refreshControl?: RefreshControl
  readonly refreshOutcome?: Exclude<ProviderRefreshOutcome, { readonly _tag: 'Refreshed' }>
  readonly refreshedAccessToken?: string
  readonly replacementAccessToken?: string
  readonly onRefreshFinalize?: () => void
}) {
  let authorizationExchanges = 0
  let refreshDispatches = 0
  const initial = {
    accessToken: 'expired-access-token',
    refreshToken: 'initial-refresh-token',
  }
  const refreshed = {
    accessToken: options?.refreshedAccessToken ?? 'refreshed-access-token',
    refreshToken: 'replacement-refresh-token',
  }
  const replacement = {
    accessToken: options?.replacementAccessToken ?? 'replacement-access-token',
    refreshToken: 'replacement-authorization-refresh-token',
  }
  const provider: OAuthProviderDefinition<TestCredentials> = {
    id: 'salesforce',
    authorizationUrl: ({ state }) =>
      Effect.succeed(`https://provider.example.test/authorize?state=${encodeURIComponent(state)}`),
    parseAuthorizationCallback: (callbackUrl) => {
      const url = new URL(callbackUrl)
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      if (state === null || code === null) return Effect.fail(new Error('Invalid callback'))
      return Effect.succeed<AuthorizationCallback>({
        _tag: 'AuthorizationGranted',
        state,
        code: Redacted.make(code),
      })
    },
    exchangeAuthorizationCode: () =>
      Effect.sync(() => {
        authorizationExchanges++
        return {
          protectedPayload: storedCredentials(authorizationExchanges === 1 ? initial : replacement),
          credentialExpiresAt: authorizationExchanges === 1 ? 0 : null,
        }
      }),
    refreshCredentials: ({ protectedPayload }) =>
      Effect.gen(function* () {
        refreshDispatches++
        const previous = JSON.parse(Redacted.value(protectedPayload)) as StoredTestCredentials
        if (previous.refreshToken !== initial.refreshToken) {
          return { _tag: 'ProviderFailure' } satisfies ProviderRefreshOutcome
        }
        if (options?.refreshControl !== undefined) {
          yield* Effect.promise(() => options.refreshControl?.wait() ?? Promise.resolve())
        }
        if (options?.refreshOutcome !== undefined) return options.refreshOutcome
        return {
          _tag: 'Refreshed',
          credentials: {
            protectedPayload: storedCredentials(refreshed),
            credentialExpiresAt: null,
          },
        } satisfies ProviderRefreshOutcome
      }).pipe(Effect.ensuring(Effect.sync(() => options?.onRefreshFinalize?.()))),
    projectCredentials: (protectedPayload) => {
      const stored = JSON.parse(Redacted.value(protectedPayload)) as StoredTestCredentials
      return Effect.succeed({ accessToken: Redacted.make(stored.accessToken) })
    },
  }
  return {
    provider,
    get authorizationExchanges() {
      return authorizationExchanges
    },
    get refreshDispatches() {
      return refreshDispatches
    },
  }
}

function operationName(reference: unknown): string | null {
  const address = getFunctionAddress(reference)
  return 'reference' in address ? (address.reference ?? null) : null
}

function makeContext(
  base: ConvexInvocationContext,
  controls?: {
    readonly loseCompletionAcknowledgements?: number
    readonly completionAcknowledgementError?: Error
    readonly holdCompletion?: RefreshControl
    readonly completionCalls?: { value: number }
    readonly loseAuthorizationCompletionAcknowledgements?: number
    readonly authorizationCompletionCalls?: { value: number }
    readonly holdAdmissionAcknowledgement?: RefreshControl
    readonly holdRemovalAcknowledgement?: RefreshControl
    readonly loseRemovalAcknowledgements?: number
    readonly removalCalls?: { value: number }
  },
): ConvexInvocationContext {
  let acknowledgementsToLose = controls?.loseCompletionAcknowledgements ?? 0
  let authorizationAcknowledgementsToLose =
    controls?.loseAuthorizationCompletionAcknowledgements ?? 0
  let removalAcknowledgementsToLose = controls?.loseRemovalAcknowledgements ?? 0
  return {
    runQuery: base.runQuery,
    runMutation: (async (reference, arguments_) => {
      const operation = operationName(reference)
      const completion = operation?.endsWith('/operations/complete') === true
      const admission = operation?.endsWith('/attempts/admit') === true
      const authorizationCompletion = operation?.endsWith('/attempts/complete') === true
      const removal = operation?.endsWith('/connections/remove') === true
      if (completion) {
        if (controls?.completionCalls !== undefined) controls.completionCalls.value++
        if (controls?.holdCompletion !== undefined) {
          await controls.holdCompletion.wait()
        }
      }
      if (authorizationCompletion && controls?.authorizationCompletionCalls !== undefined) {
        controls.authorizationCompletionCalls.value++
      }
      if (removal && controls?.removalCalls !== undefined) controls.removalCalls.value++
      const result = await base.runMutation(reference, arguments_)
      if (admission && controls?.holdAdmissionAcknowledgement !== undefined) {
        await controls.holdAdmissionAcknowledgement.wait()
      }
      if (removal && controls?.holdRemovalAcknowledgement !== undefined) {
        await controls.holdRemovalAcknowledgement.wait()
      }
      if (completion && acknowledgementsToLose > 0) {
        acknowledgementsToLose--
        throw (
          controls?.completionAcknowledgementError ??
          new Error('Simulated lost Convex mutation acknowledgement')
        )
      }
      if (authorizationCompletion && authorizationAcknowledgementsToLose > 0) {
        authorizationAcknowledgementsToLose--
        throw new Error('Simulated lost authorization completion acknowledgement')
      }
      if (removal && removalAcknowledgementsToLose > 0) {
        removalAcknowledgementsToLose--
        throw new Error('Simulated lost removal acknowledgement')
      }
      return result
    }) as ConvexInvocationContext['runMutation'],
  }
}

async function makeFixture(options?: {
  readonly provider?: ReturnType<typeof makeProvider>
  readonly context?: (base: ConvexInvocationContext) => ConvexInvocationContext
  readonly clock?: ReturnType<typeof makeTestClock>
  readonly encryptionKey?: () => string
  readonly skipCompletion?: boolean
}) {
  const backend = convexTest(componentSchema, componentModules)
  backend.registerComponent('connections', componentSchema, componentModules)
  const base: ConvexInvocationContext = {
    runQuery: backend.query as ConvexInvocationContext['runQuery'],
    runMutation: backend.mutation as ConvexInvocationContext['runMutation'],
  }
  const context = options?.context?.(base) ?? base
  const provider = options?.provider ?? makeProvider()
  const store = Convex.store({
    component: installedComponent,
    encryptionKey: () => options?.encryptionKey?.() ?? encryptionKey,
  })
  const manager = Connections.create({
    provider: provider.provider,
    store,
  })
  const layer =
    options?.clock === undefined
      ? Convex.layer(context)
      : Layer.merge(Convex.layer(context), options.clock.layer)
  const driver = makeLifecycleDriver(layer)
  drivers.add(driver)
  if (options?.clock !== undefined) await driver.run(options.clock.initialize)

  const connection = manager.effect
  const started = await driver.run(
    connection.startAuthorization('conn_acme', { binding: 'trusted-session', replace: false }),
  )
  const state = new URL(started.url).searchParams.get('state')
  if (state === null) throw new Error('Expected authorization state')
  if (options?.skipCompletion !== true) {
    await driver.run(
      manager.effect.completeAuthorization({
        callbackUrl: `https://app.example.test/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
        binding: 'trusted-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
    )
  }

  return { backend, base, connection, context, driver, manager, provider, state, store }
}

function credentialFailure<Requirements>(
  effect: Effect.Effect<unknown, CredentialFailure, Requirements>,
) {
  return Effect.flip(effect)
}

const encryptionContext = {
  namespace: 'default',
  providerId: 'salesforce',
  connectionId: 'conn_acme',
  generation: 0,
  purpose: 'credentials',
} as const
const encryptionInvocationLayer = Convex.layer({
  runQuery: (async () => null) as ConvexInvocationContext['runQuery'],
  runMutation: (async () => null) as ConvexInvocationContext['runMutation'],
})

async function expectEncryptionFailureFromKey(encryptionKey: () => string): Promise<unknown> {
  let resolutions = 0
  const store = Convex.store({
    component: installedComponent,
    encryptionKey: () => {
      resolutions++
      return encryptionKey()
    },
  })
  expect(resolutions).toBe(0)

  const exit = await Effect.runPromiseExit(
    store
      .protect(Redacted.make('plaintext'), encryptionContext)
      .pipe(Effect.provide(encryptionInvocationLayer)),
  )
  expect(resolutions).toBe(1)
  return Exit.isSuccess(exit) ? exit : Cause.squash(exit.cause)
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function makeClientCredentialsFixture(options?: {
  readonly clock?: ReturnType<typeof makeTestClock>
  readonly context?: (base: ConvexInvocationContext) => ConvexInvocationContext
}) {
  const base = await makeFixture({ clock: options?.clock, context: options?.context })
  const provider = makeDeterministicClientCredentialsProvider()
  const manager = Connections.create({
    provider: provider.provider,
    store: base.store,
  })
  const connection = manager.effect
  await base.driver.run(
    connection.setClientCredentials(
      'conn_acme',
      { source: Redacted.make('service-source') },
      { replace: false },
    ),
  )
  return { ...base, connection, manager, provider }
}

async function prepareReplacement(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  binding: string,
): Promise<string> {
  const started = await fixture.driver.run(
    fixture.connection.startAuthorization('conn_acme', { binding, replace: true }),
  )
  const state = new URL(started.url).searchParams.get('state')
  if (state === null) throw new Error('Expected replacement state')
  return `https://app.example.test/callback?code=replacement-code&state=${encodeURIComponent(state)}`
}

afterEach(async () => {
  await Promise.all([...drivers].map((driver) => driver.dispose()))
  drivers.clear()
})

describe('shared credential workflow with the Convex component store', () => {
  test('resolves built-in encryption keys only when protecting or unprotecting', async () => {
    let resolutions = 0
    const store = Convex.store({
      component: installedComponent,
      encryptionKey: () => {
        resolutions++
        return encryptionKey
      },
    })

    expect(resolutions).toBe(0)
    const envelope = await Effect.runPromise(
      store
        .protect(Redacted.make('plaintext'), encryptionContext)
        .pipe(Effect.provide(encryptionInvocationLayer)),
    )
    expect(resolutions).toBe(1)
    expect(
      Redacted.value(
        await Effect.runPromise(
          store
            .unprotect(envelope, encryptionContext)
            .pipe(Effect.provide(encryptionInvocationLayer)),
        ),
      ),
    ).toBe('plaintext')
    expect(resolutions).toBe(2)

    const stringKeyStore = Convex.store({
      component: installedComponent,
      encryptionKey,
    })
    const stringKeyEnvelope = await Effect.runPromise(
      stringKeyStore
        .protect(Redacted.make('plaintext'), encryptionContext)
        .pipe(Effect.provide(encryptionInvocationLayer)),
    )
    expect(
      Redacted.value(
        await Effect.runPromise(
          stringKeyStore
            .unprotect(stringKeyEnvelope, encryptionContext)
            .pipe(Effect.provide(encryptionInvocationLayer)),
        ),
      ),
    ).toBe('plaintext')
  })

  test('maps missing, throwing, and invalid encryption keys to safe failures', async () => {
    const missingFailure = await expectEncryptionFailureFromKey(
      () => Reflect.get({}, 'missingKey') as string,
    )
    expect(missingFailure).toMatchObject({ _tag: 'EncryptionFailure', reason: 'InvalidKey' })

    const leakedValue = 'do-not-leak-convex-encryption-key'
    const thrownFailure = await expectEncryptionFailureFromKey(() => {
      throw new Error(leakedValue)
    })
    expect(thrownFailure).toMatchObject({ _tag: 'EncryptionFailure', reason: 'InvalidKey' })
    expect(String(thrownFailure)).not.toContain(leakedValue)
    expect(JSON.stringify(thrownFailure)).not.toContain(leakedValue)

    const invalidFailure = await expectEncryptionFailureFromKey(() => 'not-a-valid-key')
    expect(invalidFailure).toMatchObject({ _tag: 'EncryptionFailure', reason: 'InvalidKey' })
  })

  test('run accepts query-only inspection and a complete action program', async () => {
    const fixture = await makeFixture()
    const queryContext = { runQuery: fixture.base.runQuery }

    await expect(
      Convex.run(queryContext, fixture.connection.inspect('conn_acme')),
    ).resolves.toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })

    let authorizedTarget: { readonly connectionId: string; readonly intent: string } | undefined
    const inspection = await Convex.run(
      fixture.context,
      Effect.gen(function* () {
        const connection = fixture.manager.effect
        const use = yield* connection.credentialUse('conn_acme')
        expect(Redacted.value(use.credentials.accessToken)).toBe('refreshed-access-token')

        const replacement = yield* connection.startAuthorization('conn_acme', {
          binding: 'effect-session',
          replace: true,
        })
        const state = new URL(replacement.url).searchParams.get('state')
        if (state === null) return yield* Effect.die('Expected replacement state')
        const completed = yield* fixture.manager.effect.completeAuthorization({
          callbackUrl: `https://app.example.test/callback?code=effect-code&state=${encodeURIComponent(state)}`,
          binding: 'effect-session',
          authorize: (target) =>
            Effect.runPromise(Effect.sync(() => (authorizedTarget = target)).pipe(Effect.asVoid)),
        })
        expect(
          Redacted.value(
            (yield* connection.credentialUse(completed.connectionId)).credentials.accessToken,
          ),
        ).toBe('replacement-access-token')
        yield* connection.remove(completed.connectionId)
        return yield* connection.inspect(completed.connectionId)
      }),
    )

    expect(authorizedTarget).toEqual({ connectionId: 'conn_acme', intent: 'replace' })
    expect(inspection).toEqual({ savedAuthorization: false, credentialWork: 'idle' })
  })

  test('binds Promise lifecycle operations to each action and limits queries to inspection', async () => {
    let keyResolutions = 0
    const fixture = await makeFixture({
      encryptionKey: () => {
        keyResolutions++
        return encryptionKey
      },
      skipCompletion: true,
    })
    const resolutionsBeforeManagerCreation = keyResolutions
    const promiseManager = Connections.create({
      store: fixture.store,
      provider: fixture.provider.provider,
    })
    expect(keyResolutions).toBe(resolutionsBeforeManagerCreation)

    const action = Convex.bind(fixture.context, promiseManager)
    const connectionId = 'promise-bound-connection'
    const start = await action.startAuthorization(connectionId, { binding: 'promise-binding' })
    const state = new URL(start.url).searchParams.get('state')
    if (state === null) throw new Error('Expected Promise authorization state')
    await action.completeAuthorization({
      callbackUrl: `https://app.example.test/callback?code=promise-code&state=${encodeURIComponent(state)}`,
      binding: 'promise-binding',
      authorize: ({ connectionId: authorizedConnectionId }) => {
        expect(authorizedConnectionId).toBe(connectionId)
      },
    })
    expect(keyResolutions).toBeGreaterThan(0)

    const queryContext = { runQuery: fixture.base.runQuery }
    const queryManager = Convex.bind(queryContext, promiseManager)
    await expect(queryManager.inspect(connectionId)).resolves.toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
    const keyResolutionsBeforeQuery = keyResolutions
    await queryManager.inspect(connectionId)
    expect(keyResolutions).toBe(keyResolutionsBeforeQuery)

    const effectCredentials = await Convex.run(
      fixture.context,
      promiseManager.effect.credentials(connectionId),
    )
    expect(Redacted.value(effectCredentials.accessToken)).toBe('refreshed-access-token')

    let invocationReads = 0
    const invocationContext: ConvexInvocationContext = {
      runQuery: async (reference, arguments_) => {
        invocationReads++
        return fixture.base.runQuery(reference, arguments_)
      },
      runMutation: fixture.base.runMutation,
    }
    const invocationBound = Convex.bind(invocationContext, promiseManager)
    const credentials = await invocationBound.credentials(connectionId)
    expect(Redacted.value(credentials.accessToken)).toBe('refreshed-access-token')
    expect(invocationReads).toBeGreaterThan(0)

    const use = await invocationBound.credentialUse(connectionId)
    await expect(use.reportRejected()).resolves.toBeUndefined()
    await action.remove(connectionId)
    await expect(queryManager.inspect(connectionId)).resolves.toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
  })

  test('enrolls and replaces Self Client OAuth credentials through the Convex component', async () => {
    const fixture = await makeFixture()
    const codes: string[] = []
    const provider = {
      id: 'deterministic-self-client',
      exchangeSelfClientCode: ({ code }: { readonly code: Redacted.Redacted<string> }) =>
        Effect.sync(() => {
          const value = Redacted.value(code)
          codes.push(value)
          return {
            protectedPayload: storedCredentials({
              accessToken: `access-${value}`,
              refreshToken: `refresh-${value}`,
            }),
            credentialExpiresAt: null,
          }
        }),
      refreshCredentials: () => Effect.succeed({ _tag: 'ProviderOutcomeUnknown' as const }),
      projectCredentials: (payload: Redacted.Redacted<string>) =>
        Effect.sync(() => ({
          accessToken: Redacted.make(
            (JSON.parse(Redacted.value(payload)) as StoredTestCredentials).accessToken,
          ),
        })),
    }
    const manager = Connections.create({
      provider,
      store: fixture.store,
    })
    const connection = manager.effect

    let approvals = 0
    await fixture.driver.run(
      connection.enrollCode('conn_acme', {
        code: 'first-code',
        authorize: () => Effect.runPromise(Effect.sync(() => approvals++).pipe(Effect.asVoid)),
        replace: false,
      }),
    )
    expect(
      Redacted.value(
        (await fixture.driver.run(connection.credentialUse('conn_acme'))).credentials.accessToken,
      ),
    ).toBe('access-first-code')
    await fixture.driver.run(
      connection.enrollCode('conn_acme', {
        code: 'replacement-code',
        authorize: () => Effect.runPromise(Effect.sync(() => approvals++).pipe(Effect.asVoid)),
        replace: true,
      }),
    )
    expect(await fixture.driver.run(connection.inspect('conn_acme'))).toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
    expect(
      Redacted.value(
        (await fixture.driver.run(connection.credentialUse('conn_acme'))).credentials.accessToken,
      ),
    ).toBe('access-replacement-code')
    expect(codes).toEqual(['first-code', 'replacement-code'])
    expect(approvals).toBe(2)
  })

  test('client-credentials coordinates first acquisition through Effect and the Promise boundary', async () => {
    const fixture = await makeClientCredentialsFixture()
    const checkpoint = fixture.provider.pauseNextAcquisition()
    const callers = fixture.driver.run(
      Effect.all(
        [
          fixture.connection.credentialUse('conn_acme'),
          fixture.connection.credentialUse('conn_acme'),
        ],
        {
          concurrency: 'unbounded',
        },
      ),
    )

    await checkpoint.reached
    expect(fixture.provider.requests()).toBe(1)
    checkpoint.release()
    expect((await callers).map((issued) => Redacted.value(issued.credentials.token))).toEqual([
      'token-1',
      'token-1',
    ])
    const reused = await Convex.run(fixture.context, fixture.connection.credentialUse('conn_acme'))
    expect(Redacted.value(reused.credentials.token)).toBe('token-1')
    expect(fixture.provider.requests()).toBe(1)
  })

  test('client-credentials replaces an expired Convex credential', async () => {
    const clock = makeTestClock(1_000)
    const fixture = await makeClientCredentialsFixture({ clock })
    fixture.provider.issue('token-1', 2_000)
    await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))
    fixture.provider.issue('token-2', 3_000)
    await fixture.driver.run(clock.advanceBy(1_000))
    const replacement = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))

    expect(Redacted.value(replacement.credentials.token)).toBe('token-2')
    expect(fixture.provider.requests()).toBe(2)
  })

  test('client-credentials rejection handles are exact, duplicate and stale reports are harmless', async () => {
    const fixture = await makeClientCredentialsFixture()
    const first = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))
    await fixture.driver.run(first.reportRejected())
    await fixture.driver.run(first.reportRejected())
    fixture.provider.issue('token-2')
    const second = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))
    await fixture.driver.run(first.reportRejected())

    const current = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))
    expect(Redacted.value(second.credentials.token)).toBe('token-2')
    expect(Redacted.value(current.credentials.token)).toBe('token-2')
    expect(fixture.provider.requests()).toBe(2)
  })

  test.each([
    [
      'replacement',
      async (fixture: Awaited<ReturnType<typeof makeClientCredentialsFixture>>) =>
        fixture.driver.run(
          fixture.connection.setClientCredentials(
            'conn_acme',
            { source: Redacted.make('replacement-source') },
            { replace: true },
          ),
        ),
    ],
    [
      'removal',
      async (fixture: Awaited<ReturnType<typeof makeClientCredentialsFixture>>) =>
        fixture.driver.run(fixture.connection.remove('conn_acme')),
    ],
  ] as const)(
    'client-credentials fences a dispatched acquisition during %s',
    async (_transition, transition) => {
      const fixture = await makeClientCredentialsFixture()
      const checkpoint = fixture.provider.pauseNextAcquisition()
      const stale = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
      await checkpoint.reached

      await transition(fixture)
      checkpoint.release()
      expect(Exit.isFailure(await stale.exit)).toBe(true)
      if (_transition === 'replacement') {
        fixture.provider.issue('replacement-token')
        const current = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))
        expect(Redacted.value(current.credentials.token)).toBe('replacement-token')
        expect(fixture.provider.acquiredSources()).toEqual(['service-source', 'replacement-source'])
      } else {
        await expect(
          fixture.driver.run(credentialFailure(fixture.connection.credentialUse('conn_acme'))),
        ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
      }
    },
  )

  test('client-credentials preserves provider uncertainty and reconciles a lost completion receipt', async () => {
    const completionCalls = { value: 0 }
    const fixture = await makeClientCredentialsFixture({
      context: (base) => makeContext(base, { loseCompletionAcknowledgements: 1, completionCalls }),
    })
    fixture.provider.outcomeUnknownNext()
    const unknown = await fixture.driver.run(
      credentialFailure(fixture.connection.credentialUse('conn_acme')),
    )
    expectCredentialOutcome(unknown, 'InterventionRequired', 'ProviderOutcomeUnknown')

    await fixture.driver.run(
      fixture.connection.setClientCredentials(
        'conn_acme',
        { source: Redacted.make('recovered-source') },
        { replace: true },
      ),
    )
    fixture.provider.issue('recovered-token')
    const recovered = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))
    expect(Redacted.value(recovered.credentials.token)).toBe('recovered-token')
    expect(completionCalls.value).toBe(2)
    expect(fixture.provider.requests()).toBe(2)
  })

  test('simultaneous callers contend transactionally and dispatch one refresh', async () => {
    const refresh = controlledRefresh()
    const provider = makeProvider({ refreshControl: refresh })
    const fixture = await makeFixture({ provider })
    const executions = Array.from({ length: 12 }, () =>
      fixture.driver.run(fixture.connection.credentialUse('conn_acme')),
    )

    await refresh.reached
    await nextTurn()
    expect(provider.refreshDispatches).toBe(1)
    refresh.release()

    const credentials = await Promise.all(executions)
    expect(credentials.map(({ credentials }) => Redacted.value(credentials.accessToken))).toEqual(
      Array.from({ length: 12 }, () => 'refreshed-access-token'),
    )
    expect(provider.refreshDispatches).toBe(1)
  })

  test('returns temporary unavailability when active Convex credential work outlasts the bounded wait', async () => {
    const clock = makeTestClock(1_000)
    const refresh = controlledRefresh()
    const provider = makeProvider({ refreshControl: refresh })
    const fixture = await makeFixture({ clock, provider })
    const owner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    try {
      await refresh.reached
      const follower = fixture.driver.run(
        credentialFailure(fixture.connection.credentialUse('conn_acme')),
      )
      await nextTurn()
      await fixture.driver.run(clock.advanceBy(5_000))

      const failure = await follower
      expectCredentialOutcome(failure, 'TemporarilyUnavailable')
      expect(provider.refreshDispatches).toBe(1)
    } finally {
      refresh.release()
      await owner.exit
    }
  })

  test('requires authorization after a known provider rejection', async () => {
    const provider = makeProvider({ refreshOutcome: { _tag: 'ProviderRejected' } })
    const fixture = await makeFixture({ provider })

    const failure = await fixture.driver.run(
      credentialFailure(fixture.connection.credentialUse('conn_acme')),
    )

    expectCredentialOutcome(failure, 'AuthorizationRequired')
    expect(provider.refreshDispatches).toBe(1)
  })

  test('requires intervention when Convex credentials cannot authenticate', async () => {
    let currentEncryptionKey = encryptionKey
    const fixture = await makeFixture({ encryptionKey: () => currentEncryptionKey })
    currentEncryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(43)))

    const failure = await fixture.driver.run(
      credentialFailure(fixture.connection.credentialUse('conn_acme')),
    )

    expectCredentialOutcome(failure, 'InterventionRequired', 'EncryptionFailure')
    expect(fixture.provider.refreshDispatches).toBe(0)
  })

  test('a cancelled follower does not cancel its refresh owner or dispatch again', async () => {
    const refresh = controlledRefresh()
    const provider = makeProvider({ refreshControl: refresh })
    const fixture = await makeFixture({ provider })
    const owner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    await refresh.reached
    const follower = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
    await nextTurn()
    follower.interrupt()
    const followerExit = await follower.exit

    expect(Exit.isFailure(followerExit) && Cause.hasInterrupts(followerExit.cause)).toBe(true)
    expect(provider.refreshDispatches).toBe(1)
    refresh.release()
    await expect(owner.exit).resolves.toSatisfy(Exit.isSuccess)
    expect(provider.refreshDispatches).toBe(1)
  })

  test('resumes an admitted pre-dispatch callback after its worker is interrupted', async () => {
    const clock = makeTestClock(1_000)
    const provider = makeProvider()
    const admissionAcknowledgement = controlledRefresh()
    const fixture = await makeFixture({
      clock,
      provider,
      skipCompletion: true,
      context: (base) =>
        makeContext(base, { holdAdmissionAcknowledgement: admissionAcknowledgement }),
    })
    const complete = () =>
      fixture.manager.effect.completeAuthorization({
        callbackUrl: `https://app.example.test/callback?code=authorization-code&state=${encodeURIComponent(fixture.state)}`,
        binding: 'trusted-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      })
    const abandoned = fixture.driver.start(complete())

    try {
      await admissionAcknowledgement.reached
      abandoned.interrupt()
      admissionAcknowledgement.release()
      await abandoned.exit
      await fixture.driver.run(clock.advanceBy(30_001))

      await fixture.driver.run(complete())

      expect(provider.authorizationExchanges).toBe(1)
      expect(await fixture.driver.run(fixture.connection.inspect('conn_acme'))).toEqual({
        savedAuthorization: true,
        credentialWork: 'idle',
      })
    } finally {
      admissionAcknowledgement.release()
      abandoned.interrupt()
      await abandoned.exit
      await fixture.driver.dispose()
    }
  })

  test('recovers an immutable completion receipt after a lost acknowledgement', async () => {
    const completionCalls = { value: 0 }
    const provider = makeProvider()
    const fixture = await makeFixture({
      provider,
      context: (base) => makeContext(base, { loseCompletionAcknowledgements: 1, completionCalls }),
    })

    const credentials = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))

    expect(Redacted.value(credentials.credentials.accessToken)).toBe('refreshed-access-token')
    expect(completionCalls.value).toBe(2)
    expect(provider.refreshDispatches).toBe(1)
  })

  test('a fresh invocation adopts committed credentials after contaminated acknowledgements are lost', async () => {
    const completionCalls = { value: 0 }
    const provider = makeProvider()
    const canary = makeSecretCanary('raw-convex-adapter-error')
    const rawAdapterError = Object.assign(
      new Error(`Contaminated Convex adapter failure: ${canary.value}`),
      { rawMessage: canary.value },
    )
    const fixture = await makeFixture({
      provider,
      context: (base) =>
        makeContext(base, {
          loseCompletionAcknowledgements: 3,
          completionAcknowledgementError: rawAdapterError,
          completionCalls,
        }),
    })

    const failed = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
    const failedExit = await failed.exit
    if (!Exit.isFailure(failedExit)) throw new Error('Expected a storage failure')
    const failure = Cause.squash(failedExit.cause)
    expectCredentialOutcome(failure, 'TemporarilyUnavailable', 'StorageFailure')
    expect(rawAdapterError.message).toContain(canary.value)
    expect(rawAdapterError.rawMessage).toBe(canary.value)
    assertSecretCanariesAbsent(
      [canary],
      failure,
      failedExit.cause,
      String(failure),
      JSON.stringify(failure),
      Cause.pretty(failedExit.cause),
    )
    expect(completionCalls.value).toBe(3)
    expect(provider.refreshDispatches).toBe(1)

    const freshStore = Convex.store({
      component: installedComponent,
      encryptionKey: () => encryptionKey,
    })
    const freshManager = Connections.create({
      provider: provider.provider,
      store: freshStore,
    })
    const fresh = await Effect.runPromise(
      freshManager.effect
        .credentialUse('conn_acme')
        .pipe(Effect.provide(Convex.layer(fixture.base))),
    )

    expect(Redacted.value(fresh.credentials.accessToken)).toBe('refreshed-access-token')
    expect(provider.refreshDispatches).toBe(1)
  })

  test('replacement preparation does not stale an unresolved refresh and admission stays pending', async () => {
    const refresh = controlledRefresh()
    const provider = makeProvider({ refreshControl: refresh })
    const fixture = await makeFixture({ provider })
    const owner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    await refresh.reached
    const callbackUrl = await prepareReplacement(fixture, 'replacement-session')
    await expect(
      fixture.driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl,
            binding: 'replacement-session',
            authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
          }),
        ),
      ),
    ).resolves.toMatchObject({ reason: 'Pending' })
    expect(provider.authorizationExchanges).toBe(1)

    refresh.release()
    await expect(owner.exit).resolves.toSatisfy(Exit.isSuccess)
    const completed = await fixture.driver.run(
      fixture.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'replacement-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
    )
    const credentials = await fixture.driver.run(
      fixture.manager.effect.credentialUse(completed.connectionId),
    )

    expect(completed.connectionId).toBe('conn_acme')
    expect(Redacted.value(credentials.credentials.accessToken)).toBe('replacement-access-token')
    expect(provider.refreshDispatches).toBe(1)
    expect(provider.authorizationExchanges).toBe(2)
  })

  test('confirms replacement after its Convex completion acknowledgement is lost', async () => {
    const completionCalls = { value: 0 }
    const provider = makeProvider()
    const fixture = await makeFixture({
      provider,
      context: (base) =>
        makeContext(base, {
          loseAuthorizationCompletionAcknowledgements: 2,
          authorizationCompletionCalls: completionCalls,
        }),
    })
    const callbackUrl = await prepareReplacement(fixture, 'replacement-session')

    const completed = await fixture.driver.run(
      fixture.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'replacement-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
    )
    const credentials = await fixture.driver.run(
      fixture.manager.effect.credentialUse(completed.connectionId),
    )

    expect(Redacted.value(credentials.credentials.accessToken)).toBe('replacement-access-token')
    expect(completionCalls.value).toBe(2)
    expect(provider.authorizationExchanges).toBe(2)
  })

  test('rejects a superseded replacement callback without an exchange', async () => {
    const provider = makeProvider()
    const fixture = await makeFixture({ provider })
    const stale = await prepareReplacement(fixture, 'stale-session')
    const current = await prepareReplacement(fixture, 'current-session')

    await fixture.driver.run(
      fixture.manager.effect.completeAuthorization({
        callbackUrl: current,
        binding: 'current-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
    )
    await expect(
      fixture.driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl: stale,
            binding: 'stale-session',
            authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
          }),
        ),
      ),
    ).resolves.toMatchObject({ reason: 'InvalidAttempt' })

    const credentials = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))
    expect(Redacted.value(credentials.credentials.accessToken)).toBe('replacement-access-token')
    expect(provider.authorizationExchanges).toBe(2)
  })

  test('rejects a stale owner completion after a fresh invocation marks uncertainty', async () => {
    const clock = makeTestClock(1_000)
    const completion = controlledRefresh()
    const provider = makeProvider()
    const fixture = await makeFixture({
      provider,
      clock,
      context: (base) => makeContext(base, { holdCompletion: completion }),
    })
    const staleOwner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    await completion.reached
    await fixture.driver.run(clock.advanceBy(30_000))
    const intervention = await fixture.driver.run(
      credentialFailure(fixture.connection.credentialUse('conn_acme')),
    )
    expectCredentialOutcome(intervention, 'InterventionRequired', 'ProviderOutcomeUnknown')
    completion.release()

    const staleExit = await staleOwner.exit
    if (!Exit.isFailure(staleExit)) throw new Error('Expected stale owner conflict')
    expectCredentialOutcome(Cause.squash(staleExit.cause), 'InterventionRequired', 'Conflict')
    expect(provider.refreshDispatches).toBe(1)
    const snapshot = await fixture.driver.run(
      fixture.store.readConnection({
        namespace: 'default',
        providerId: 'salesforce',
        connectionId: 'conn_acme',
      }),
    )
    expect(snapshot?.credentialOperation?.phase).toMatchObject({
      _tag: 'InterventionRequired',
      reason: 'DispatchOwnerExpired',
    })
  })

  test('removal tombstones a pending refresh and fences its stale Convex completion', async () => {
    const completion = controlledRefresh()
    const provider = makeProvider()
    const fixture = await makeFixture({
      provider,
      context: (base) => makeContext(base, { holdCompletion: completion }),
    })
    const staleRefresh = fixture.driver.start(
      credentialFailure(fixture.connection.credentialUse('conn_acme')),
    )

    try {
      await completion.reached
      await expect(fixture.driver.run(fixture.connection.inspect('conn_acme'))).resolves.toEqual({
        savedAuthorization: true,
        credentialWork: 'pending',
      })

      await fixture.driver.run(fixture.connection.remove('conn_acme'))
      const removedFailure = await fixture.driver.run(
        credentialFailure(fixture.connection.credentialUse('conn_acme')),
      )
      expectCredentialOutcome(removedFailure, 'AuthorizationRequired')
      await expect(fixture.driver.run(fixture.connection.inspect('conn_acme'))).resolves.toEqual({
        savedAuthorization: false,
        credentialWork: 'idle',
      })

      completion.release()
      const staleExit = await staleRefresh.exit
      if (!Exit.isSuccess(staleExit)) throw new Error('Expected stale refresh failure')
      expect(['AuthorizationRequired', 'InterventionRequired']).toContain(staleExit.value._tag)
      const finalFailure = await fixture.driver.run(
        credentialFailure(fixture.connection.credentialUse('conn_acme')),
      )
      expectCredentialOutcome(finalFailure, 'AuthorizationRequired')
      expect(provider.refreshDispatches).toBe(1)
      expect(provider.authorizationExchanges).toBe(1)
    } finally {
      completion.release()
      staleRefresh.interrupt()
      await staleRefresh.exit
    }
  })

  test('delayed removal retry and stale callback cannot damage deliberate same-ID reenrollment', async () => {
    const delayedAcknowledgement = controlledRefresh()
    const removalCalls = { value: 0 }
    const provider = makeProvider()
    const fixture = await makeFixture({
      provider,
      context: (base) =>
        makeContext(base, {
          holdRemovalAcknowledgement: delayedAcknowledgement,
          loseRemovalAcknowledgements: 1,
          removalCalls,
        }),
    })
    const staleCallback = await prepareReplacement(fixture, 'stale-replacement')
    const removal = fixture.driver.start(Effect.flip(fixture.connection.remove('conn_acme')))

    try {
      await delayedAcknowledgement.reached
      const started = await fixture.driver.run(
        fixture.connection.startAuthorization('conn_acme', {
          binding: 'reenrollment',
          replace: false,
        }),
      )
      const state = new URL(started.url).searchParams.get('state')
      if (state === null) throw new Error('Expected reenrollment state')
      const reenrolled = await fixture.driver.run(
        fixture.manager.effect.completeAuthorization({
          callbackUrl: `https://app.example.test/callback?code=reenrollment-code&state=${encodeURIComponent(state)}`,
          binding: 'reenrollment',
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      )

      let staleApprovals = 0
      await expect(
        fixture.driver.run(
          Effect.flip(
            fixture.manager.effect.completeAuthorization({
              callbackUrl: staleCallback,
              binding: 'stale-replacement',
              authorize: () =>
                Effect.runPromise(Effect.sync(() => staleApprovals++).pipe(Effect.asVoid)),
            }),
          ),
        ),
      ).resolves.toMatchObject({ reason: 'InvalidAttempt' })
      delayedAcknowledgement.release()

      const removalExit = await removal.exit
      if (!Exit.isSuccess(removalExit)) throw new Error('Expected delayed removal failure')
      expect(removalExit.value).toMatchObject({ reason: 'Conflict' })
      const credentials = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))

      expect(reenrolled.connectionId).toBe('conn_acme')
      expect(staleApprovals).toBe(0)
      expect(Redacted.value(credentials.credentials.accessToken)).toBe('replacement-access-token')
      expect(removalCalls.value).toBe(2)
      expect(provider.authorizationExchanges).toBe(2)
      expect(provider.refreshDispatches).toBe(0)
    } finally {
      delayedAcknowledgement.release()
      removal.interrupt()
      await removal.exit
    }
  })
})
