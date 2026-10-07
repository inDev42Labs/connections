import { Buffer } from 'node:buffer'
import { Data, Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, InterventionRequired } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { Zoho } from '../../src/providers/zoho/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { makeLifecycleDriver, makeTestClock } from '../fixtures/lifecycle-driver.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(71)).toString('base64')
const accessCanary = 'zoho-access-secret-canary'
const refreshCanary = 'zoho-refresh-secret-canary'
const clientSecretCanary = 'zoho-client-secret-canary'
const oneTimeCode = 'zoho-self-client-code-canary'
const accountsOrigin = 'https://accounts.zoho.example'

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

class ApplicationDenied extends Data.TaggedError('ApplicationDenied')<{}> {}

function tokenResponse(
  accessToken: string,
  options: { readonly refreshToken?: string; readonly expiresIn?: number } = {},
): Response {
  return Response.json({
    access_token: accessToken,
    refresh_token: options.refreshToken ?? `${accessToken}-refresh-token`,
    api_domain: 'https://www.zohoapis.example',
    token_type: 'Bearer',
    expires_in: options.expiresIn ?? 3_600,
  })
}

function requestForm(init: RequestInit | undefined): URLSearchParams {
  if (!(init?.body instanceof URLSearchParams))
    throw new Error('Expected a form-encoded token request')
  return init.body
}

function fixture() {
  const store = makeInMemoryStore({
    encryptor: AesGcm.encryptor({
      key: Configuration.secret(() => encryptionKey),
      keyId: 'default',
    }),
  })
  const manager = Connections.create({
    provider: Zoho.selfClient({
      clientId: 'zoho-client-id',
      clientSecret: Configuration.secret(() => clientSecretCanary),
      accountsOrigin,
    }),
    store,
  })
  return { connection: manager.effect, manager, store }
}

function enrollment(
  code: string,
  intent: 'enroll' | 'replace' = 'enroll',
  authorize: () => Effect.Effect<void, ApplicationDenied> = () => Effect.void,
) {
  return {
    code,
    replace: intent === 'replace',
    authorize: () => Effect.runPromise(authorize()),
  }
}

async function authorizationFailure<Error>(effect: Effect.Effect<unknown, Error>) {
  return Effect.runPromise(Effect.flip(effect))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Zoho Self Client public connection workflow', () => {
  test('enrolls and replaces through protected storage and shared credential retrieval', async () => {
    const fetchMock = vi.fn<TestFetch>((_input, init) => {
      const request = requestForm(init)
      if (request.get('grant_type') !== 'authorization_code') {
        return Promise.reject(new Error('Unexpected non-enrollment request'))
      }
      const code = request.get('code')
      return Promise.resolve(
        tokenResponse(code === oneTimeCode ? `${accessCanary}-first` : 'replacement-access-token', {
          refreshToken: code === oneTimeCode ? refreshCanary : 'replacement-refresh-token',
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const { connection, store } = fixture()
    let authorizations = 0

    await Effect.runPromise(
      connection.enrollCode('conn_zoho', {
        ...enrollment(oneTimeCode),
        authorize: () => Effect.runPromise(Effect.sync(() => authorizations++).pipe(Effect.asVoid)),
      }),
    )
    const initialUse = await Effect.runPromise(connection.credentialUse('conn_zoho'))

    expect(authorizations).toBe(1)
    expect(initialUse.credentials.apiDomain).toBe('https://www.zohoapis.example')
    expect(Redacted.value(initialUse.credentials.accessToken)).toBe(`${accessCanary}-first`)
    expect(Object.keys(initialUse.credentials).sort()).toEqual(['accessToken', 'apiDomain'])
    expect(await Effect.runPromise(connection.inspect('conn_zoho'))).toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })

    const deniedEnrolls = store.diagnostics.commands.AdmitSelfClientExchange ?? 0
    const wrongIntent = await authorizationFailure(
      connection.enrollCode('conn_zoho', enrollment('should-not-be-used', 'enroll')),
    )
    expect(wrongIntent).toMatchObject({ reason: 'Conflict' })
    expect(store.diagnostics.commands.AdmitSelfClientExchange).toBe(deniedEnrolls)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const admissionHold = store.holdNext('AdmitSelfClientExchange', 'after')
    const replacement = Effect.runPromise(
      connection.enrollCode('conn_zoho', enrollment('replacement-code', 'replace')),
    )
    await admissionHold.reached
    try {
      const duringPreparation = await Effect.runPromise(connection.credentialUse('conn_zoho'))
      expect(Redacted.value(duringPreparation.credentials.accessToken)).toBe(
        `${accessCanary}-first`,
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      admissionHold.release()
      await replacement.catch(() => undefined)
    }
    await replacement

    const replacementUse = await Effect.runPromise(connection.credentialUse('conn_zoho'))
    const replacementRequest = fetchMock.mock.calls[1]
    expect(replacementRequest).toBeDefined()
    const [endpoint, init] = replacementRequest!
    expect(new URL(String(endpoint)).toString()).toBe(`${accountsOrigin}/oauth/v2/token`)
    expect(requestForm(init).get('redirect_uri')).toBeNull()
    expect(requestForm(init).get('code_verifier')).toBeNull()
    expect(Redacted.value(replacementUse.credentials.accessToken)).toBe('replacement-access-token')

    const saved = store.unsafeReadConnection({
      namespace: 'default',
      providerId: 'zoho-self-client',
      connectionId: 'conn_zoho',
    })
    expect(JSON.stringify(saved)).not.toContain(oneTimeCode)
    expect(JSON.stringify(saved)).not.toContain(clientSecretCanary)
    expect(JSON.stringify(saved)).not.toContain(refreshCanary)
    await Effect.runPromise(connection.remove('conn_zoho'))
    await expect(
      Effect.runPromise(Effect.flip(connection.credentialUse('conn_zoho'))),
    ).resolves.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
  })

  test('requires application approval before admission or code dispatch and rejects wrong intent', async () => {
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(tokenResponse('should-not-exist')))
    vi.stubGlobal('fetch', fetchMock)
    const { connection, store } = fixture()
    const executionsBefore = store.diagnostics.executions

    await expect(
      Effect.runPromise(
        connection.enrollCode(
          'conn_zoho',
          enrollment('denied-code', 'enroll', () => Effect.fail(new ApplicationDenied())),
        ),
      ),
    ).rejects.toThrow(ApplicationDenied)
    expect(store.diagnostics.executions).toBe(executionsBefore)
    expect(fetchMock).not.toHaveBeenCalled()

    let wrongIntentAuthorization = 0
    const wrongIntent = await authorizationFailure(
      connection.enrollCode('conn_zoho', {
        ...enrollment('wrong-intent-code', 'replace'),
        authorize: () =>
          Effect.runPromise(Effect.sync(() => wrongIntentAuthorization++).pipe(Effect.asVoid)),
      }),
    )
    expect(wrongIntent).toMatchObject({ reason: 'Conflict' })
    expect(wrongIntentAuthorization).toBe(1)
    expect(store.diagnostics.executions).toBe(executionsBefore)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('confirms a committed result after its store acknowledgement is lost without re-exchanging the code', async () => {
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(tokenResponse('saved-access')))
    vi.stubGlobal('fetch', fetchMock)
    const { connection, store } = fixture()
    store.loseNextAcknowledgement('CompleteSelfClientExchange')

    await Effect.runPromise(connection.enrollCode('conn_zoho', enrollment('one-time-code')))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(
      Redacted.value(
        (await Effect.runPromise(connection.credentialUse('conn_zoho'))).credentials.accessToken,
      ),
    ).toBe('saved-access')
    expect(store.diagnostics.commands.CompleteSelfClientExchange).toBeGreaterThanOrEqual(1)
  })

  test('keeps intervention evidence when a successful exchange cannot be protected', async () => {
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(tokenResponse('new-access')))
    vi.stubGlobal('fetch', fetchMock)
    const underlying = makeInMemoryStore({
      encryptor: AesGcm.encryptor({
        key: Configuration.secret(() => encryptionKey),
        keyId: 'default',
      }),
    })
    let rejectProtection = true
    const store = {
      ...underlying,
      protect: (...args: Parameters<typeof underlying.protect>) => {
        if (rejectProtection && args[1].purpose === 'credentials') {
          rejectProtection = false
          return Effect.fail(new Error('protected storage unavailable'))
        }
        return underlying.protect(...args)
      },
    }
    const connection = Connections.create({
      provider: Zoho.selfClient({
        clientId: 'zoho-client-id',
        clientSecret: Configuration.secret(() => clientSecretCanary),
        accountsOrigin,
      }),
      store,
    }).effect

    const failure = await authorizationFailure(
      connection.enrollCode('conn_zoho', enrollment('first-code')),
    )
    expect(failure).toMatchObject({ reason: 'EncryptionFailure' })
    expect(await Effect.runPromise(connection.inspect('conn_zoho'))).toEqual({
      savedAuthorization: false,
      credentialWork: 'intervention-required',
    })
    await expect(
      Effect.runPromise(Effect.flip(connection.credentialUse('conn_zoho'))),
    ).resolves.toBeInstanceOf(InterventionRequired)

    await Effect.runPromise(connection.enrollCode('conn_zoho', enrollment('fresh-code')))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestForm(fetchMock.mock.calls[0]?.[1]).get('code')).toBe('first-code')
    expect(requestForm(fetchMock.mock.calls[1]?.[1]).get('code')).toBe('fresh-code')
    expect(
      Redacted.value(
        (await Effect.runPromise(connection.credentialUse('conn_zoho'))).credentials.accessToken,
      ),
    ).toBe('new-access')
  })

  test('requires a fresh code after an uncertain exchange without replaying the prior code', async () => {
    const fetchMock = vi.fn<TestFetch>((_input, init) =>
      requestForm(init).get('code') === 'lost-code'
        ? Promise.reject(new TypeError('simulated transport interruption'))
        : Promise.resolve(tokenResponse('fresh-code-access')),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { connection } = fixture()

    const uncertain = await authorizationFailure(
      connection.enrollCode('conn_zoho', enrollment('lost-code')),
    )
    expect(uncertain).toMatchObject({ reason: 'InterventionRequired' })
    await expect(
      Effect.runPromise(Effect.flip(connection.credentialUse('conn_zoho'))),
    ).resolves.toBeInstanceOf(InterventionRequired)

    await Effect.runPromise(connection.enrollCode('conn_zoho', enrollment('fresh-code')))
    const current = await Effect.runPromise(connection.credentialUse('conn_zoho'))
    expect(Redacted.value(current.credentials.accessToken)).toBe('fresh-code-access')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([, init]) => requestForm(init).get('code'))).toEqual([
      'lost-code',
      'fresh-code',
    ])
  })

  test('fences a late response from an expired dispatch after a fresh authorized code supersedes it', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    let markFirstStarted: () => void = () => undefined
    let releaseFirst: () => void = () => undefined
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(tokenResponse('late-stale-access'))
    })
    const fetchMock = vi.fn<TestFetch>((_input, init) => {
      const code = requestForm(init).get('code')
      if (code === 'stale-code') {
        markFirstStarted()
        return firstResponse
      }
      return Promise.resolve(tokenResponse('fresh-current-access'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { connection } = fixture()
    await driver.run(clock.initialize)

    try {
      const staleEnrollment = driver.run(
        connection.enrollCode('conn_zoho', enrollment('stale-code')),
      )
      await firstStarted
      await driver.run(clock.advanceBy(31_000))
      await expect(
        driver.run(Effect.flip(connection.credentialUse('conn_zoho'))),
      ).resolves.toBeInstanceOf(InterventionRequired)

      await driver.run(connection.enrollCode('conn_zoho', enrollment('fresh-fenced-code')))
      releaseFirst()
      await expect(staleEnrollment).rejects.toMatchObject({ reason: 'Conflict' })
      const current = await driver.run(connection.credentialUse('conn_zoho'))

      expect(Redacted.value(current.credentials.accessToken)).toBe('fresh-current-access')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls.map(([, init]) => requestForm(init).get('code'))).toEqual([
        'stale-code',
        'fresh-fenced-code',
      ])
    } finally {
      releaseFirst()
      await driver.dispose()
    }
  })

  test('refreshes normally after an application-reported 401 without exposing the refresh token', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fetchMock = vi.fn<TestFetch>((_input, init) => {
      const request = requestForm(init)
      return Promise.resolve(
        request.get('grant_type') === 'authorization_code'
          ? tokenResponse('before-401-access', { refreshToken: 'report-refresh-token' })
          : tokenResponse('after-401-access'),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const { connection } = fixture()
    await driver.run(clock.initialize)

    try {
      await driver.run(connection.enrollCode('conn_zoho', enrollment('401-test-code')))
      const issued = await driver.run(connection.credentialUse('conn_zoho'))
      const responseFromApplicationClient = new Response(null, { status: 401 })
      expect(responseFromApplicationClient.status).toBe(401)
      await driver.run(issued.reportRejected())

      const refreshed = await driver.run(connection.credentialUse('conn_zoho'))
      expect(Redacted.value(refreshed.credentials.accessToken)).toBe('after-401-access')
      expect(Object.keys(refreshed.credentials).sort()).toEqual(['accessToken', 'apiDomain'])
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(requestForm(fetchMock.mock.calls[1]?.[1]).get('grant_type')).toBe('refresh_token')
      expect(requestForm(fetchMock.mock.calls[1]?.[1]).get('refresh_token')).toBe(
        'report-refresh-token',
      )
      expect(JSON.stringify(refreshed)).not.toContain('report-refresh-token')
    } finally {
      await driver.dispose()
    }
  })
})
