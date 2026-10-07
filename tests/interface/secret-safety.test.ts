import { Buffer } from 'node:buffer'
import { inspect } from 'node:util'
import { Cause, Effect, Exit, Logger, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ConnectionStore } from '../../src/core/contracts/store.js'
import { Connections } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { makeDeterministicClientCredentialsProvider } from '../fixtures/client-credentials-provider.js'
import {
  assertSecretCanariesAbsent,
  makeSecretCanary,
  type SecretCanary,
} from '../fixtures/secret-assertions.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
  type ScriptedResponse,
} from '../fixtures/salesforce-server.js'

const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const servers = new Set<SalesforceTestServer>()
const consoleMethods = ['debug', 'info', 'log', 'warn', 'error'] as const

interface SecretSet {
  readonly authorizationCode: SecretCanary
  readonly clientSecret: SecretCanary
  readonly accessToken: SecretCanary
  readonly refreshToken: SecretCanary
  readonly encryptionKey: SecretCanary
  readonly all: ReadonlyArray<SecretCanary>
}

function makeSecrets(label: string): SecretSet {
  const authorizationCode = makeSecretCanary(`${label}:authorization-code`)
  const clientSecret = makeSecretCanary(`${label}:client-secret`)
  const accessToken = makeSecretCanary(`${label}:access-token`)
  const refreshToken = makeSecretCanary(`${label}:refresh-token`)
  const encryptionKey = {
    label: `${label}:encryption-key`,
    value: Buffer.from(new Uint8Array(32).fill(label.length)).toString('base64'),
  }
  return {
    authorizationCode,
    clientSecret,
    accessToken,
    refreshToken,
    encryptionKey,
    all: [authorizationCode, clientSecret, accessToken, refreshToken, encryptionKey],
  }
}

function captureLogs() {
  const effectLogs: unknown[] = []
  const consoleLogs: unknown[] = []
  const logger = Logger.make<unknown, void>(({ cause, logLevel, message }) => {
    effectLogs.push({ cause: Cause.pretty(cause), logLevel: String(logLevel), message })
  })
  const loggerLayer = Logger.layer([logger])

  for (const method of consoleMethods) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLogs.push({ args, method })
    })
  }

  return {
    run: <Value, Error>(effect: Effect.Effect<Value, Error>) =>
      Effect.runPromise(effect.pipe(Effect.provide(loggerLayer))),
    runExit: <Value, Error>(effect: Effect.Effect<Value, Error>) =>
      Effect.runPromiseExit(effect.pipe(Effect.provide(loggerLayer))),
    observations: () => ({ consoleLogs, effectLogs }),
  }
}

function renderings(value: unknown): ReadonlyArray<unknown> {
  return [JSON.stringify(value), String(value), inspect(value, { depth: null, getters: false })]
}

function assertSafe(
  canaries: ReadonlyArray<SecretCanary>,
  logs: ReturnType<typeof captureLogs>,
  ...observations: ReadonlyArray<unknown>
): void {
  assertSecretCanariesAbsent(
    canaries,
    ...observations,
    ...observations.flatMap(renderings),
    logs.observations(),
  )
}

async function observeStructuredFailure(
  effect: Effect.Effect<unknown, unknown>,
  logs: ReturnType<typeof captureLogs>,
) {
  const exit = await logs.runExit(effect)
  if (Exit.isSuccess(exit)) throw new Error('Expected the public operation to fail')
  const failure = Cause.squash(exit.cause)

  expect(failure).toEqual(expect.objectContaining({ _tag: expect.any(String) }))
  return {
    cause: exit.cause,
    causeInspect: inspect(exit.cause, { depth: null, getters: false }),
    causeJson: JSON.stringify(exit.cause),
    causePretty: Cause.pretty(exit.cause),
    causePrettyErrors: Cause.prettyErrors(exit.cause),
    causeString: String(exit.cause),
    failure,
    failureInspect: inspect(failure, { depth: null, getters: false }),
    failureJson: JSON.stringify(failure),
    failureString: String(failure),
  }
}

function withoutEnvelopes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEnvelopes)
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'credentialEnvelope' && key !== 'pkceVerifierEnvelope')
      .map(([key, entry]) => [key, withoutEnvelopes(entry)]),
  )
}

function encryptedStore(secrets: SecretSet) {
  const keyResolutions: string[] = []
  const store = makeInMemoryStore({
    encryptor: AesGcm.encryptor({
      key: Configuration.secret(() => {
        keyResolutions.push(secrets.encryptionKey.value)
        return secrets.encryptionKey.value
      }),
      keyId: 'default',
    }),
  })
  return { keyResolutions, store }
}

function configuredManager(
  secrets: SecretSet,
  store: ConnectionStore<unknown, never, unknown, never>,
  loginUrl = 'https://login.example.test',
) {
  const clientSecretResolutions: string[] = []
  const provider = Salesforce.oauth({
    clientId: 'public-client-id',
    clientSecret: Configuration.secret(() => {
      clientSecretResolutions.push(secrets.clientSecret.value)
      return secrets.clientSecret.value
    }),
    redirectUri,
    scopes: ['api', 'refresh_token'],
    loginUrl,
  })
  const manager = Connections.create({ provider, store })
  return { clientSecretResolutions, manager, provider }
}

function callbackFor(authorizationUrl: string, code: string): string {
  const destination = new URL(authorizationUrl)
  const callback = new URL(destination.searchParams.get('redirect_uri') ?? redirectUri)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', destination.searchParams.get('state') ?? '')
  return callback.toString()
}

function tokenResponse(
  secrets: SecretSet,
  options: { readonly issuedAt: number; readonly expiresIn: number },
): ScriptedResponse {
  return {
    _tag: 'Response',
    status: 200,
    json: {
      access_token: secrets.accessToken.value,
      refresh_token: secrets.refreshToken.value,
      instance_url: 'https://instance.example.test',
      token_type: 'Bearer',
      issued_at: String(options.issuedAt),
      expires_in: options.expiresIn,
    },
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('client credentials secret safety at public seams', () => {
  test('encrypts source credentials at rest and drops source, validation, and storage failures', async () => {
    const source = makeSecretCanary('client-credentials-source')
    const validationCause = makeSecretCanary('client-credentials-validation-cause')
    const storageCause = makeSecretCanary('client-credentials-storage-cause')
    const encrypted = encryptedStore(makeSecrets('client-credentials-encryption'))
    const deterministic = makeDeterministicClientCredentialsProvider()
    const provider = {
      ...deterministic.provider,
      prepareClientCredentials: () =>
        Effect.fail(new Error(`invalid source: ${validationCause.value}`)),
    }
    const validationConnection = Connections.create({
      provider,
      store: encrypted.store,
    }).effect
    const logs = captureLogs()
    const validation = await observeStructuredFailure(
      validationConnection.setClientCredentials(
        'conn_acme',
        { source: Redacted.make(source.value) },
        { replace: false },
      ),
      logs,
    )

    const storage = makeInMemoryStore()
    const storageConnection = Connections.create({
      provider: deterministic.provider,
      store: {
        ...storage,
        executeCredentialOperation: () =>
          Effect.fail(new Error(`storage failed: ${storageCause.value}`)),
      },
    }).effect
    const storageFailure = await observeStructuredFailure(
      storageConnection.setClientCredentials(
        'conn_acme',
        { source: Redacted.make(source.value) },
        { replace: false },
      ),
      logs,
    )

    const persisted = encrypted.store.unsafeReadConnection({
      namespace: 'default',
      providerId: deterministic.provider.id,
      connectionId: 'conn_acme',
    })
    expect(persisted).toBeNull()
    expect(deterministic.requests()).toBe(0)
    assertSafe(
      [source, validationCause, storageCause],
      logs,
      validationConnection,
      validation,
      storageConnection,
      storageFailure,
    )
  })

  test('persists a client-credential source only inside its encrypted envelope', async () => {
    const source = makeSecretCanary('client-credentials-persisted-source')
    const secrets = makeSecrets('client-credentials-persisted')
    const encrypted = encryptedStore(secrets)
    const provider = makeDeterministicClientCredentialsProvider()
    const connection = Connections.create({
      provider: provider.provider,
      store: encrypted.store,
    }).effect

    await Effect.runPromise(
      connection.setClientCredentials(
        'conn_acme',
        { source: Redacted.make(source.value) },
        { replace: false },
      ),
    )
    const snapshot = encrypted.store.unsafeReadConnection({
      namespace: 'default',
      providerId: provider.provider.id,
      connectionId: 'conn_acme',
    })
    if (snapshot === null) throw new Error('Expected persisted client credentials')

    expect(JSON.stringify(snapshot)).not.toContain(source.value)
    expect(provider.requests()).toBe(0)

    const logs = captureLogs()
    provider.failNext()
    const providerFailure = await observeStructuredFailure(
      connection.credentialUse('conn_acme'),
      logs,
    )
    expect(provider.requests()).toBe(1)
    assertSafe([source], logs, connection, snapshot, providerFailure)
  })
})

describe('secret safety at public seams', () => {
  test('keeps browser/public results, logs, and persisted non-envelope metadata secret-safe', async () => {
    const secrets = makeSecrets('successful-lifecycle')
    const scriptedResponses = [
      tokenResponse(secrets, { issuedAt: 0, expiresIn: 1 }),
      tokenResponse(secrets, { issuedAt: Date.now(), expiresIn: 3_600 }),
    ]
    const server = await startSalesforceServer({
      authorization: [{ _tag: 'Grant', code: secrets.authorizationCode.value }],
      token: scriptedResponses,
    })
    servers.add(server)
    const encrypted = encryptedStore(secrets)
    const persistedWrites: unknown[] = []
    const store = {
      ...encrypted.store,
      execute: (command: Parameters<typeof encrypted.store.execute>[0]) => {
        persistedWrites.push(withoutEnvelopes(command))
        return encrypted.store.execute(command)
      },
      executeCredentialOperation: (
        command: Parameters<typeof encrypted.store.executeCredentialOperation>[0],
      ) => {
        persistedWrites.push(withoutEnvelopes(command))
        return encrypted.store.executeCredentialOperation(command)
      },
    }
    const configured = configuredManager(secrets, store, server.loginUrl)
    const connection = configured.manager.effect
    const logs = captureLogs()

    const start = await logs.run(
      connection.startAuthorization('conn_acme', { binding: 'trusted-session', replace: false }),
    )
    const authorizationResponse = await fetch(start.url, { redirect: 'manual' })
    const callbackUrl = authorizationResponse.headers.get('location')
    if (callbackUrl === null) throw new Error('Expected an authorization callback')
    const completed = await logs.run(
      configured.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'trusted-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
    )
    const credentials = await logs.run(connection.credentialUse(completed.connectionId))
    const inspection = await logs.run(connection.inspect(completed.connectionId))
    const snapshot = encrypted.store.unsafeReadConnection({
      namespace: 'default',
      providerId: 'salesforce',
      connectionId: 'conn_acme',
    })
    if (snapshot === null) throw new Error('Expected a persisted connection')
    const persistedMetadata = withoutEnvelopes(snapshot)

    // These are deliberate secret sinks. They prove each canary traversed the intended
    // callback, provider, encryption, and credential-use boundaries, and are intentionally
    // excluded from the absence scan below.
    const incomingCallbackUrl = new URL(callbackUrl)
    const authorizationRequest = server.tokenRequests[0]?.form
    const refreshRequest = server.tokenRequests[1]?.form
    const unwrappedCredential = Redacted.value(credentials.credentials.accessToken)
    expect(incomingCallbackUrl.searchParams.get('code')).toBe(secrets.authorizationCode.value)
    expect(authorizationRequest?.get('code')).toBe(secrets.authorizationCode.value)
    expect(authorizationRequest?.get('client_secret')).toBe(secrets.clientSecret.value)
    expect(refreshRequest?.get('refresh_token')).toBe(secrets.refreshToken.value)
    expect(refreshRequest?.get('client_secret')).toBe(secrets.clientSecret.value)
    expect(unwrappedCredential).toBe(secrets.accessToken.value)
    expect(configured.clientSecretResolutions).toEqual([
      secrets.clientSecret.value,
      secrets.clientSecret.value,
    ])
    expect(encrypted.keyResolutions.length).toBeGreaterThan(0)
    expect(encrypted.keyResolutions.every((value) => value === secrets.encryptionKey.value)).toBe(
      true,
    )
    expect(server.tokenRequestCount).toBe(2)
    expect(persistedWrites.length).toBeGreaterThan(0)

    assertSafe(
      secrets.all,
      logs,
      configured.provider,
      configured.manager,
      connection,
      start,
      completed,
      credentials,
      inspection,
      persistedWrites,
      persistedMetadata,
    )
  })

  test('does not echo a contaminated incoming callback URL through failures or diagnostics', async () => {
    const secrets = makeSecrets('callback-failure')
    const encrypted = encryptedStore(secrets)
    const configured = configuredManager(secrets, encrypted.store)
    const logs = captureLogs()
    const callbackUrl = new URL(redirectUri)
    callbackUrl.searchParams.set('state', 'public-state')
    callbackUrl.searchParams.set('code', secrets.authorizationCode.value)
    callbackUrl.searchParams.set('error', 'access_denied')

    const diagnostics = await observeStructuredFailure(
      configured.manager.effect.completeAuthorization({
        callbackUrl: callbackUrl.toString(),
        binding: 'trusted-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
      logs,
    )

    // The incoming callback URL is a deliberate input sink and is not scanned.
    expect(callbackUrl.searchParams.get('code')).toBe(secrets.authorizationCode.value)
    expect(encrypted.store.diagnostics.reads).toBe(0)
    assertSafe([secrets.authorizationCode], logs, configured.manager, diagnostics)
  })

  test('drops contaminated provider response data from public failures and diagnostics', async () => {
    const secrets = makeSecrets('provider-response-failure')
    const encrypted = encryptedStore(secrets)
    const configured = configuredManager(secrets, encrypted.store)
    const logs = captureLogs()
    const requests: Array<{
      readonly input: Parameters<typeof fetch>[0]
      readonly init?: RequestInit
    }> = []
    const contaminatedResponse = {
      access_token: secrets.accessToken.value,
      refresh_token: secrets.refreshToken.value,
      instance_url: 'https://instance.example.test',
      token_type: 'deliberately-invalid',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({ input, init })
        return Promise.resolve(Response.json(contaminatedResponse))
      }),
    )

    const start = await logs.run(
      configured.manager.effect.startAuthorization('conn_acme', {
        binding: 'trusted-session',
        replace: false,
      }),
    )
    const callbackUrl = callbackFor(start.url, secrets.authorizationCode.value)
    const diagnostics = await observeStructuredFailure(
      configured.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'trusted-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
      logs,
    )

    const providerRequest = requests[0]?.init?.body
    expect(providerRequest).toBeInstanceOf(URLSearchParams)
    if (!(providerRequest instanceof URLSearchParams)) throw new Error('Expected provider form')
    expect(providerRequest.get('code')).toBe(secrets.authorizationCode.value)
    expect(providerRequest.get('client_secret')).toBe(secrets.clientSecret.value)
    expect(contaminatedResponse.access_token).toBe(secrets.accessToken.value)
    expect(contaminatedResponse.refresh_token).toBe(secrets.refreshToken.value)
    expect(requests).toHaveLength(1)

    // callbackUrl, providerRequest, and contaminatedResponse are deliberate boundary
    // sources/sinks and are excluded; all values emitted by the library are scanned.
    assertSafe(secrets.all, logs, start, diagnostics)
  })

  test('drops a contaminated fetch rejection from public failures and diagnostics', async () => {
    const secrets = makeSecrets('fetch-failure')
    const fetchFailure = makeSecretCanary('fetch-failure:transport-error')
    const canaries = [...secrets.all, fetchFailure]
    const encrypted = encryptedStore(secrets)
    const configured = configuredManager(secrets, encrypted.store)
    const logs = captureLogs()
    const sourceError = Object.assign(new Error(`fetch rejected: ${fetchFailure.value}`), {
      response: { diagnostic: fetchFailure.value },
    })
    const requests: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push(init ?? {})
        return Promise.reject(sourceError)
      }),
    )

    const start = await logs.run(
      configured.manager.effect.startAuthorization('conn_acme', {
        binding: 'trusted-session',
        replace: false,
      }),
    )
    const callbackUrl = callbackFor(start.url, secrets.authorizationCode.value)
    const diagnostics = await observeStructuredFailure(
      configured.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'trusted-session',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
      logs,
    )
    const providerRequest = requests[0]?.body

    expect(providerRequest).toBeInstanceOf(URLSearchParams)
    if (!(providerRequest instanceof URLSearchParams)) throw new Error('Expected provider form')
    expect(providerRequest.get('code')).toBe(secrets.authorizationCode.value)
    expect(providerRequest.get('client_secret')).toBe(secrets.clientSecret.value)
    expect(sourceError.message).toContain(fetchFailure.value)
    expect(requests).toHaveLength(1)

    // The callback, outgoing provider request, and rejected source Error are deliberately
    // contaminated boundary values and are excluded from the public diagnostic scan.
    assertSafe(canaries, logs, start, diagnostics)
  })

  test.each(['storage', 'encryption'] as const)(
    'drops a contaminated %s source from public failures and diagnostics',
    async (boundary) => {
      const secrets = makeSecrets(`${boundary}-source-failure`)
      const sourceCanary = makeSecretCanary(`${boundary}-source-failure:raw-cause`)
      const sourceError = Object.assign(new Error(`${boundary} failed: ${sourceCanary.value}`), {
        details: { secret: sourceCanary.value },
      })
      const encrypted = encryptedStore(secrets)
      const crossedBoundary = vi.fn<() => Effect.Effect<never, Error>>(() =>
        Effect.fail(sourceError),
      )
      const store: ConnectionStore<unknown, never, unknown, never> =
        boundary === 'storage'
          ? { ...encrypted.store, readConnection: crossedBoundary }
          : { ...encrypted.store, protect: crossedBoundary }
      const configured = configuredManager(secrets, store)
      const connection = configured.manager.effect
      const logs = captureLogs()
      const operation =
        boundary === 'storage'
          ? connection.credentialUse('conn_acme')
          : connection.startAuthorization('conn_acme', {
              binding: 'trusted-session',
              replace: false,
            })

      const diagnostics = await observeStructuredFailure(operation, logs)

      expect(crossedBoundary).toHaveBeenCalled()
      expect(sourceError.details.secret).toBe(sourceCanary.value)

      // sourceError is the contaminated storage/encryption seam value and is excluded.
      assertSafe([sourceCanary], logs, configured.manager, connection, diagnostics)
    },
  )
})
