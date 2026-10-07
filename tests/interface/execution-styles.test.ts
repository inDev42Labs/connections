import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import type { OAuthProviderDefinition } from '../../src/core/contracts/provider.js'
import { Connections, type ReadCredentialFailure as CredentialFailure } from '../../src/index.js'
import { Convex, type ConvexInvocationContext } from '../../src/stores/convex/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { makeDeterministicClientCredentialsProvider } from '../fixtures/client-credentials-provider.js'

interface ExecutionStyleCredentials {
  readonly accessToken: Redacted.Redacted<string>
  readonly instanceUrl: string
}

const context = {
  runQuery: () =>
    Promise.reject(new Error('The in-memory execution-style fixture does not query Convex')),
  runMutation: () =>
    Promise.reject(new Error('The in-memory execution-style fixture does not mutate Convex')),
} as ConvexInvocationContext

const controllers = new Set<AbortController>()

afterEach(() => {
  for (const controller of controllers) controller.abort()
  controllers.clear()
})

function fixture() {
  const store = makeInMemoryStore()
  let authorizationExchanges = 0
  let projections = 0
  const provider: OAuthProviderDefinition<ExecutionStyleCredentials> = {
    id: 'execution-style-provider',
    authorizationUrl: ({ state }) => Effect.succeed(`https://provider.example.test?state=${state}`),
    parseAuthorizationCallback: (callbackUrl) => {
      const url = new URL(callbackUrl)
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      return state === null || code === null
        ? Effect.die('Invalid fixture callback')
        : Effect.succeed({
            _tag: 'AuthorizationGranted' as const,
            state,
            code: Redacted.make(code),
          })
    },
    exchangeAuthorizationCode: () =>
      Effect.sync(() => {
        authorizationExchanges++
        return {
          protectedPayload: Redacted.make('execution-style-payload'),
          credentialExpiresAt: null,
        }
      }),
    refreshCredentials: () => Effect.die('Refresh is outside this fixture'),
    projectCredentials: () =>
      Effect.sync(() => {
        projections++
        return {
          accessToken: Redacted.make('style-access-token'),
          instanceUrl: 'https://instance.example.test',
        }
      }),
  }
  const manager = Connections.create({ provider, store })
  return {
    manager,
    store,
    get authorizationExchanges() {
      return authorizationExchanges
    },
    get projections() {
      return projections
    },
  }
}

function credentialFailure(effect: Effect.Effect<unknown, CredentialFailure>): Promise<unknown> {
  return Effect.runPromise(Effect.flip(effect))
}

async function enroll(configured: ReturnType<typeof fixture>, connectionId: string): Promise<void> {
  const started = await Effect.runPromise(
    configured.manager.effect.startAuthorization(connectionId, {
      binding: 'trusted-session',
      replace: false,
    }),
  )
  const state = new URL(started.url).searchParams.get('state')
  if (state === null) throw new Error('Expected fixture authorization state')
  await Effect.runPromise(
    configured.manager.effect.completeAuthorization({
      callbackUrl: `https://app.example.test/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
      binding: 'trusted-session',
      authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
    }),
  )
}

describe('Effect-native and Convex Promise execution styles', () => {
  test('run executes the same credential workflow and preserves structured outcomes', async () => {
    const configured = fixture()
    const native = configured.manager.effect
    const promise = configured.manager.effect

    const nativeFailure = await credentialFailure(native.credentialUse('native'))
    await expect(Convex.run(context, promise.credentialUse('promise'))).rejects.toMatchObject({
      _tag: 'AuthorizationRequired',
    })

    expect(nativeFailure).toMatchObject({ _tag: 'AuthorizationRequired' })
    expect(configured.store.diagnostics.reads).toBe(2)
    expect(configured.projections).toBe(0)
  })

  test('run preserves provider-specific success values through the shared workflow', async () => {
    const configured = fixture()
    await enroll(configured, 'native')
    await enroll(configured, 'promise')

    const native = await Effect.runPromise(configured.manager.effect.credentialUse('native'))
    const promised = await Convex.run(context, configured.manager.effect.credentialUse('promise'))

    expect(promised.credentials).toEqual(native.credentials)
    expect(typeof promised.reportRejected).toBe('function')
    expect(typeof native.reportRejected).toBe('function')
    expect(Redacted.value(promised.credentials.accessToken)).toBe('style-access-token')
    expect(promised.credentials.instanceUrl).toBe('https://instance.example.test')
    expect(configured.authorizationExchanges).toBe(2)
    expect(configured.projections).toBe(2)
  })

  test('run executes a complete client-credentials program at one Promise boundary', async () => {
    const store = makeInMemoryStore()
    const provider = makeDeterministicClientCredentialsProvider()
    const manager = Connections.create({
      provider: provider.provider,
      store,
    })
    const connection = manager.effect

    expect(provider.requests()).toBe(0)
    const replacement = await Convex.run(
      context,
      Effect.gen(function* () {
        yield* connection.setClientCredentials(
          'service',
          { source: Redacted.make('service-source') },
          { replace: false },
        )
        const issued = yield* connection.credentialUse('service')
        yield* issued.reportRejected()
        provider.issue('service-replacement')
        const next = yield* connection.credentialUse('service')
        expect(yield* connection.inspect('service')).toEqual({
          savedAuthorization: true,
          credentialWork: 'idle',
        })
        return next
      }),
    )

    expect(Redacted.value(replacement.credentials.token)).toBe('service-replacement')
    expect(provider.requests()).toBe(2)
    expect(provider.acquiredSources()).toEqual(['service-source', 'service-source'])
  })

  test.each(['success', 'failure'] as const)(
    'run closes invocation scope after %s',
    async (outcome) => {
      let finalized = false
      const expectedFailure = { _tag: 'ApplicationFailure' as const }
      const operation = Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => (finalized = true)),
      ).pipe(
        Effect.flatMap(() =>
          outcome === 'success' ? Effect.succeed('completed') : Effect.fail(expectedFailure),
        ),
      )

      const settled = await Convex.run(context, operation).then(
        (value) => ({ _tag: 'Success' as const, value }),
        (error: unknown) => ({ _tag: 'Failure' as const, error }),
      )

      expect(settled).toEqual(
        outcome === 'success'
          ? { _tag: 'Success', value: 'completed' }
          : { _tag: 'Failure', error: expectedFailure },
      )
      expect(finalized).toBe(true)
    },
  )

  test('run aborts waiting library work, awaits cleanup, and does not reverse dispatch', async () => {
    const controller = new AbortController()
    controllers.add(controller)
    let dispatched = false
    let finalized = false
    let started: () => void = () => undefined
    const reached = new Promise<void>((resolve) => (started = resolve))
    const operation = Effect.acquireRelease(
      Effect.sync(() => {
        dispatched = true
        started()
      }),
      () => Effect.sync(() => (finalized = true)),
    ).pipe(Effect.andThen(Effect.never))

    const result = Convex.run(context, operation, { signal: controller.signal })
    await reached
    controller.abort()

    await expect(result).rejects.toBeInstanceOf(Error)
    expect(finalized).toBe(true)
    expect(dispatched).toBe(true)
  })
})
