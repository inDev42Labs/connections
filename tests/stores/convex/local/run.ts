import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { startSalesforceServer } from '../../../fixtures/salesforce-server.js'
import {
  assertPortsAvailable,
  exited,
  inheritedCredentialCanaryName,
  isolatedEnvironment,
  listening,
  stopOwnedProcessGroup,
} from '../../../helpers/process-isolation.js'

const localRoot = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(localRoot, '../../../..')
const fixture = resolve(localRoot, 'fixture')
const cloudPort = 33_220
const sitePort = 33_221
const cloudUrl = `http://127.0.0.1:${cloudPort}`
const backendVersion = 'precompiled-2026-08-25-7cce8fb'
const cli = resolve(projectRoot, 'node_modules/convex/bin/main.js')
const fixtureState = resolve(fixture, '.convex')
const fixtureEnvironment = resolve(fixture, '.env.local')
const fixtureNodeModules = resolve(fixture, 'node_modules')
const accessToken = '__connections_local_access_token__'
const refreshToken = '__connections_local_refresh_token__'
const expiredAccessToken = '__connections_local_expired_access_token__'
const expiredRefreshToken = '__connections_local_expired_refresh_token__'
const concurrentAccessToken = '__connections_local_concurrent_access_token__'
const concurrentRefreshToken = '__connections_local_concurrent_refresh_token__'
const acknowledgementExpiredAccessToken = '__connections_local_ack_expired_access_token__'
const acknowledgementExpiredRefreshToken = '__connections_local_ack_expired_refresh_token__'
const acknowledgedAccessToken = '__connections_local_acknowledged_access_token__'
const acknowledgedRefreshToken = '__connections_local_acknowledged_refresh_token__'
const replacementInitialAccessToken = '__connections_local_replacement_initial_access_token__'
const replacementInitialRefreshToken = '__connections_local_replacement_initial_refresh_token__'
const replacementAccessToken = '__connections_local_replacement_access_token__'
const replacementRefreshToken = '__connections_local_replacement_refresh_token__'
const removalInitialAccessToken = '__connections_local_removal_initial_access_token__'
const removalInitialRefreshToken = '__connections_local_removal_initial_refresh_token__'
const removalStaleAccessToken = '__connections_local_removal_stale_access_token__'
const removalStaleRefreshToken = '__connections_local_removal_stale_refresh_token__'
const removalReenrolledAccessToken = '__connections_local_removal_reenrolled_access_token__'
const removalReenrolledRefreshToken = '__connections_local_removal_reenrolled_refresh_token__'
const pendingInitialAccessToken = '__connections_local_pending_initial_access_token__'
const pendingInitialRefreshToken = '__connections_local_pending_initial_refresh_token__'
const pendingAccessToken = '__connections_local_pending_access_token__'
const pendingRefreshToken = '__connections_local_pending_refresh_token__'
const rejectedInitialAccessToken = '__connections_local_rejected_initial_access_token__'
const rejectedInitialRefreshToken = '__connections_local_rejected_initial_refresh_token__'
const providerDiagnostic = '__connections_local_provider_diagnostic_canary__'
const unknownInitialAccessToken = '__connections_local_unknown_initial_access_token__'
const unknownInitialRefreshToken = '__connections_local_unknown_initial_refresh_token__'
const encryptionAccessToken = '__connections_local_encryption_access_token__'
const encryptionRefreshToken = '__connections_local_encryption_refresh_token__'
const conflictInitialAccessToken = '__connections_local_conflict_initial_access_token__'
const conflictInitialRefreshToken = '__connections_local_conflict_initial_refresh_token__'
const conflictAccessToken = '__connections_local_conflict_access_token__'
const conflictRefreshToken = '__connections_local_conflict_refresh_token__'
const storageCauseCanary = '__connections_local_storage_cause_canary__'
const authorizationCode = '__connections_local_authorization_code__'
const promiseApiKey = '__connections_local_promise_api_key__'
const clientSecret = '__connections_local_client_secret__'
const encryptionKey = Buffer.alloc(32, 42).toString('base64')
const secretCanaries = [
  accessToken,
  refreshToken,
  expiredAccessToken,
  expiredRefreshToken,
  concurrentAccessToken,
  concurrentRefreshToken,
  acknowledgementExpiredAccessToken,
  acknowledgementExpiredRefreshToken,
  acknowledgedAccessToken,
  acknowledgedRefreshToken,
  replacementInitialAccessToken,
  replacementInitialRefreshToken,
  replacementAccessToken,
  replacementRefreshToken,
  removalInitialAccessToken,
  removalInitialRefreshToken,
  removalStaleAccessToken,
  removalStaleRefreshToken,
  removalReenrolledAccessToken,
  removalReenrolledRefreshToken,
  pendingInitialAccessToken,
  pendingInitialRefreshToken,
  pendingAccessToken,
  pendingRefreshToken,
  rejectedInitialAccessToken,
  rejectedInitialRefreshToken,
  providerDiagnostic,
  unknownInitialAccessToken,
  unknownInitialRefreshToken,
  encryptionAccessToken,
  encryptionRefreshToken,
  conflictInitialAccessToken,
  conflictInitialRefreshToken,
  conflictAccessToken,
  conflictRefreshToken,
  storageCauseCanary,
  authorizationCode,
  promiseApiKey,
  clientSecret,
  encryptionKey,
] as const
const binding = 'local-trusted-session-binding'
const connectionId = `local-${crypto.randomUUID()}`
const concurrentConnectionId = `${connectionId}:concurrent`
const acknowledgementConnectionId = `${connectionId}:acknowledgement`
const replacementConnectionId = `${connectionId}:replacement`
const removalConnectionId = `${connectionId}:removal`
const pendingConnectionId = `${connectionId}:pending-outcome`
const rejectedConnectionId = `${connectionId}:provider-rejected-outcome`
const unknownConnectionId = `${connectionId}:provider-unknown-outcome`
const encryptionConnectionId = `${connectionId}:encryption-outcome`
const conflictConnectionId = `${connectionId}:conflict-outcome`
const missingConnectionId = `${connectionId}:missing-outcome`

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}

async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await delay(10)
  }
  throw new Error(message)
}

function assertSecretCanariesAbsent(label: string, value: string): void {
  for (const secret of secretCanaries) {
    assert.equal(value.includes(secret), false, `${label} exposed a secret canary`)
  }
}

assert.equal(existsSync(fixtureState), false, 'Refusing to replace existing local Convex state')
assert.equal(
  existsSync(fixtureEnvironment),
  false,
  'Refusing to replace an existing fixture environment file',
)
assert.equal(
  existsSync(fixtureNodeModules),
  false,
  'Refusing to replace existing fixture dependencies',
)
await assertPortsAvailable([cloudPort, sitePort])

const scratch = mkdtempSync(join(tmpdir(), 'connections-convex-local-'))
const selectionFile = resolve(scratch, 'anonymous.env')
const logFile = resolve(scratch, 'convex-dev.log')
writeFileSync(selectionFile, 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n', { mode: 0o600 })
symlinkSync(resolve(projectRoot, 'node_modules'), fixtureNodeModules, 'dir')

const childEnvironment = isolatedEnvironment(
  scratch,
  {
    CI: '1',
    CONVEX_AGENT_MODE: 'anonymous',
    DISABLE_BEACON: 'true',
    SENTRY_DSN: '',
    NODE_OPTIONS: `--require=${JSON.stringify(resolve(localRoot, 'loopback.cjs'))}`,
  },
  {
    ...process.env,
    [inheritedCredentialCanaryName]: '__connections_inherited_credential_canary__',
  },
)
assert.equal(
  childEnvironment[inheritedCredentialCanaryName],
  undefined,
  'Inherited credential canary reached the local Convex environment',
)

type DirectorySnapshot = ReadonlyMap<string, string>

function snapshotDirectory(root: string): DirectorySnapshot {
  const snapshot = new Map<string, string>()
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else snapshot.set(relative(root, path), readFileSync(path, 'utf8'))
    }
  }
  visit(root)
  return snapshot
}

function restoreDirectory(root: string, snapshot: DirectorySnapshot): void {
  rmSync(root, { recursive: true, force: true })
  for (const [path, contents] of snapshot) {
    const target = resolve(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

function assertDirectoryUnchanged(label: string, root: string, before: DirectorySnapshot): void {
  const after = snapshotDirectory(root)
  try {
    assert.deepEqual(after, before, `${label} changed during code generation`)
  } catch (error) {
    restoreDirectory(root, before)
    throw error
  }
}

const componentGenerated = resolve(projectRoot, 'src/stores/convex/component/_generated')
const fixtureGenerated = resolve(fixture, '_generated')
const componentGeneratedBefore = snapshotDirectory(componentGenerated)
const fixtureGeneratedBefore = snapshotDirectory(fixtureGenerated)

const log = createWriteStream(logFile)
const development = spawn(
  'node',
  [
    cli,
    'dev',
    '--typecheck',
    'enable',
    '--codegen',
    'disable',
    '--tail-logs',
    'disable',
    '--local-cloud-port',
    String(cloudPort),
    '--local-site-port',
    String(sitePort),
    '--local-backend-version',
    backendVersion,
    '--env-file',
    selectionFile,
  ],
  {
    cwd: fixture,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  },
)

let recentOutput = ''
let stopping: Promise<void> | undefined
const commands = new Set<ChildProcess>()
const developmentExited = new Promise<void>((done) => development.once('exit', () => done()))
const ready = new Promise<void>((done, reject) => {
  const timeout = setTimeout(
    () => reject(new Error(`Local backend startup timed out; log: ${logFile}\n${recentOutput}`)),
    90_000,
  )
  const receive = (data: Buffer) => {
    log.write(data)
    recentOutput = (recentOutput + data.toString()).slice(-40_000)
    if (recentOutput.includes('Convex functions ready!')) {
      clearTimeout(timeout)
      done()
    }
    if (recentOutput.includes('Error: Unable to start push')) {
      clearTimeout(timeout)
      reject(new Error(recentOutput))
    }
  }
  development.stdout.on('data', receive)
  development.stderr.on('data', receive)
  development.once('error', (error) => {
    clearTimeout(timeout)
    reject(error)
  })
  development.once('exit', (code) => {
    clearTimeout(timeout)
    reject(new Error(`Local Convex CLI exited (${code}): ${recentOutput}`))
  })
})
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onTerminate)

function command(
  arguments_: ReadonlyArray<string>,
  options: { readonly envFile?: boolean } = {},
): Promise<void> {
  return new Promise((done, reject) => {
    const useEnvFile = options.envFile ?? true
    const child = spawn(
      'node',
      [cli, ...arguments_, ...(useEnvFile ? ['--env-file', selectionFile] : [])],
      {
        cwd: fixture,
        env: useEnvFile
          ? childEnvironment
          : {
              ...childEnvironment,
              CONVEX_DEPLOYMENT: 'anonymous:anonymous-agent',
            },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    commands.add(child)
    let output = ''
    child.stdout.on('data', (data) => (output += data.toString()))
    child.stderr.on('data', (data) => (output += data.toString()))
    child.once('error', reject)
    child.once('exit', (code) => {
      commands.delete(child)
      if (code === 0) done()
      else reject(new Error(`Local Convex command failed (${code}): ${output}`))
    })
  })
}

async function stop(): Promise<void> {
  stopping ??= (async () => {
    try {
      await Promise.all(
        [...commands].map(async (child) => {
          child.kill('SIGTERM')
          await Promise.race([exited(child), delay(2_000)])
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          await exited(child)
        }),
      )
      await stopOwnedProcessGroup(development)
      await developmentExited
      await new Promise<void>((done) => log.end(done))
      assert.equal(await listening(cloudPort), false, 'Owned local backend did not stop')
      assert.equal(await listening(sitePort), false, 'Owned local HTTP listener did not stop')
    } finally {
      rmSync(fixtureState, { recursive: true, force: true })
      rmSync(fixtureEnvironment, { force: true })
      rmSync(fixtureNodeModules, { force: true })
      rmSync(scratch, { recursive: true, force: true })
      assert.equal(existsSync(fixtureState), false, 'Local Convex state was not cleaned')
      assert.equal(existsSync(scratch), false, 'Runner scratch directory was not cleaned')
    }
  })()
  return stopping
}

function exitAfterSignal(code: number): void {
  void stop().then(
    () => process.exit(code),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
}

function onInterrupt(): void {
  exitAfterSignal(130)
}
function onTerminate(): void {
  exitAfterSignal(143)
}
const watchdog = setTimeout(() => {
  console.error('Local Convex authorization check exceeded its two-minute deadline')
  exitAfterSignal(1)
}, 120_000)

let salesforce: Awaited<ReturnType<typeof startSalesforceServer>> | undefined
try {
  salesforce = await startSalesforceServer({
    authorization: Array.from({ length: 13 }, () => ({
      _tag: 'Grant' as const,
      code: authorizationCode,
    })),
    token: [
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: accessToken,
          refresh_token: refreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: expiredAccessToken,
          refresh_token: expiredRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: '0',
          expires_in: 1,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        delayMilliseconds: 1_500,
        json: {
          access_token: concurrentAccessToken,
          refresh_token: concurrentRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: acknowledgementExpiredAccessToken,
          refresh_token: acknowledgementExpiredRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: '0',
          expires_in: 1,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: acknowledgedAccessToken,
          refresh_token: acknowledgedRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: replacementInitialAccessToken,
          refresh_token: replacementInitialRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: replacementAccessToken,
          refresh_token: replacementRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: removalInitialAccessToken,
          refresh_token: removalInitialRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: '0',
          expires_in: 1,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        delayMilliseconds: 2_000,
        json: {
          access_token: removalStaleAccessToken,
          refresh_token: removalStaleRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: removalReenrolledAccessToken,
          refresh_token: removalReenrolledRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: pendingInitialAccessToken,
          refresh_token: pendingInitialRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: '0',
          expires_in: 1,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        delayMilliseconds: 6_000,
        json: {
          access_token: pendingAccessToken,
          refresh_token: pendingRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: rejectedInitialAccessToken,
          refresh_token: rejectedInitialRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: '0',
          expires_in: 1,
        },
      },
      {
        _tag: 'Response',
        status: 400,
        json: {
          error: 'invalid_grant',
          error_description: providerDiagnostic,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: unknownInitialAccessToken,
          refresh_token: unknownInitialRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: '0',
          expires_in: 1,
        },
      },
      { _tag: 'TransportFailure' },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: encryptionAccessToken,
          refresh_token: encryptionRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: conflictInitialAccessToken,
          refresh_token: conflictInitialRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: '0',
          expires_in: 1,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: conflictAccessToken,
          refresh_token: conflictRefreshToken,
          instance_url: 'https://local-instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3600,
        },
      },
    ],
  })
  await ready
  await command(['codegen', '--typecheck', 'disable'], { envFile: false })
  assertDirectoryUnchanged('Fixture generated files', fixtureGenerated, fixtureGeneratedBefore)
  await command(
    [
      'codegen',
      '--component-dir',
      resolve(projectRoot, 'src/stores/convex/component'),
      '--typecheck',
      'disable',
    ],
    { envFile: false },
  )
  assertDirectoryUnchanged(
    'Component generated files',
    componentGenerated,
    componentGeneratedBefore,
  )
  await command(['env', 'set', 'CONNECTIONS_TEST_KEY', encryptionKey])
  await command(['env', 'set', 'SALESFORCE_TEST_BINDING', binding])
  await command(['env', 'set', 'SALESFORCE_TEST_CLIENT_ID', 'local-client-id'])
  await command(['env', 'set', 'SALESFORCE_TEST_CLIENT_SECRET', clientSecret])
  await command(['env', 'set', 'SALESFORCE_TEST_CONNECTION_ID', connectionId])
  await command(['env', 'set', 'SALESFORCE_TEST_LOGIN_URL', salesforce.loginUrl])

  const generatedApi = resolve(fixture, '_generated/api.d.ts')
  assert.equal(existsSync(generatedApi), true, 'Convex did not generate fixture references')
  assert.match(
    readFileSync(generatedApi, 'utf8'),
    /src\/stores\/convex\/component\/_generated\/component\.js/,
    'Generated fixture references do not point to the production component API',
  )
  const { api } = await import('./fixture/_generated/api.js')
  const client = new ConvexHttpClient(cloudUrl)
  const serializedOutcomes: string[] = []
  const recordOutcome = <Outcome>(outcome: Outcome): Outcome => {
    serializedOutcomes.push(JSON.stringify(outcome))
    return outcome
  }

  const authorize = async (selectedConnectionId: string): Promise<void> => {
    const started = await client.action(api.actions.startAuthorization, {
      connectionId: selectedConnectionId,
    })
    const authorization = await fetch(started.url, { redirect: 'manual' })
    const callbackUrl = authorization.headers.get('location')
    assert.ok(callbackUrl, 'Deterministic Salesforce server did not return a callback')
    const callback = await fetch(callbackUrl, { redirect: 'manual' })
    assert.equal(callback.status, 200)
    assert.deepEqual(await callback.json(), { connectionId: selectedConnectionId })
  }

  const promiseConnectionId = `${connectionId}:promise`
  assert.deepEqual(
    await client.query(api.actions.inspectPromiseApiKey, { connectionId: promiseConnectionId }),
    { savedAuthorization: false, credentialWork: 'idle' },
  )
  assert.deepEqual(
    await client.action(api.actions.enrollPromiseApiKey, {
      connectionId: promiseConnectionId,
      apiKey: promiseApiKey,
    }),
    { saved: true },
  )
  assert.deepEqual(
    await client.query(api.actions.inspectPromiseApiKey, { connectionId: promiseConnectionId }),
    { savedAuthorization: true, credentialWork: 'idle' },
  )
  assert.deepEqual(
    await client.action(api.actions.useAndRemovePromiseApiKey, {
      connectionId: promiseConnectionId,
      expectedApiKey: promiseApiKey,
    }),
    { credentialMatched: true, rejectionReported: true },
  )
  assert.deepEqual(
    await client.query(api.actions.inspectPromiseApiKey, { connectionId: promiseConnectionId }),
    { savedAuthorization: false, credentialWork: 'idle' },
  )

  assert.deepEqual(await client.query(api.actions.inspectConnection, { connectionId }), {
    savedAuthorization: false,
    credentialWork: 'idle',
  })

  await authorize(connectionId)

  assert.deepEqual(await client.query(api.actions.inspectConnection, { connectionId }), {
    savedAuthorization: true,
    credentialWork: 'idle',
  })

  const persisted = await client.query(api.actions.rawConnection, { connectionId })
  assert.ok(persisted)
  assert.equal(persisted.authorization._tag, 'Authorized')
  assert.ok(persisted.credentialEnvelope)
  assert.equal(persisted.credentialEnvelope.algorithm, 'AES-256-GCM')
  const serializedPersistence = JSON.stringify(persisted)
  for (const secret of [
    accessToken,
    refreshToken,
    authorizationCode,
    clientSecret,
    encryptionKey,
  ]) {
    assert.equal(serializedPersistence.includes(secret), false, 'Raw persistence exposed a secret')
  }

  assert.deepEqual(await client.action(api.actions.useCredentials, { connectionId }), {
    used: true,
    instanceUrl: 'https://local-instance.example.test',
  })
  assert.deepEqual(await client.action(api.actions.effectProgramProbe, { connectionId }), {
    accessTokenMatched: true,
    inspected: true,
  })
  assert.deepEqual(await client.action(api.actions.promiseRunCancellationProbe, {}), {
    started: true,
    finalized: true,
    rejected: true,
  })
  assert.equal(salesforce.authorizationRequestCount, 1)
  assert.equal(salesforce.tokenRequestCount, 1)
  assert.equal(salesforce.tokenRequests[0]?.form.get('grant_type'), 'authorization_code')
  assert.match(salesforce.tokenRequests[0]?.form.get('code_verifier') ?? '', /^[\w-]{43}$/)

  await authorize(concurrentConnectionId)
  const simultaneousRefreshes = Array.from({ length: 8 }, () =>
    client.action(api.actions.useCredentials, { connectionId: concurrentConnectionId }),
  )
  await eventually(
    () => salesforce?.tokenRequestCount === 3,
    'Simultaneous local refresh did not dispatch',
  )
  assert.deepEqual(
    await client.query(api.actions.inspectConnection, { connectionId: concurrentConnectionId }),
    { savedAuthorization: true, credentialWork: 'pending' },
  )
  const cancelledFollower = await client.action(api.actions.cancelCredentialFollower, {
    connectionId: concurrentConnectionId,
  })
  assert.deepEqual(cancelledFollower, { cancelled: true })
  const refreshed = await Promise.all(simultaneousRefreshes)
  assert.deepEqual(
    refreshed,
    Array.from({ length: 8 }, () => ({
      used: true,
      instanceUrl: 'https://local-instance.example.test',
    })),
  )
  assert.equal(salesforce.tokenRequestCount, 3, 'Concurrent callers duplicated refresh dispatch')
  assert.equal(salesforce.tokenRequests[2]?.form.get('grant_type'), 'refresh_token')
  assert.equal(salesforce.tokenRequests[2]?.form.get('refresh_token'), expiredRefreshToken)

  assert.deepEqual(await client.action(api.actions.clientCredentialsLifecycle, { connectionId }), {
    concurrentRequests: 1,
    reused: true,
  })

  await authorize(acknowledgementConnectionId)
  assert.deepEqual(
    await client.action(api.actions.useCredentialsWithLostAcknowledgement, {
      connectionId: acknowledgementConnectionId,
    }),
    {
      used: true,
      instanceUrl: 'https://local-instance.example.test',
      completionMutations: 2,
    },
  )
  assert.equal(salesforce.tokenRequestCount, 5)
  assert.deepEqual(
    await client.action(api.actions.useCredentials, {
      connectionId: acknowledgementConnectionId,
    }),
    { used: true, instanceUrl: 'https://local-instance.example.test' },
  )
  assert.equal(
    salesforce.tokenRequestCount,
    5,
    'Lost acknowledgement recovery repeated the provider exchange',
  )

  await authorize(replacementConnectionId)
  const preparedReplacement = await client.action(api.actions.startReplacement, {
    connectionId: replacementConnectionId,
  })
  assert.deepEqual(
    await client.query(api.actions.inspectConnection, { connectionId: replacementConnectionId }),
    { savedAuthorization: true, credentialWork: 'idle' },
  )
  const replacementAuthorization = await fetch(preparedReplacement.url, { redirect: 'manual' })
  const replacementCallbackUrl = replacementAuthorization.headers.get('location')
  assert.ok(replacementCallbackUrl, 'Replacement did not return a callback')
  const replacementCallback = await fetch(replacementCallbackUrl, { redirect: 'manual' })
  assert.equal(replacementCallback.status, 200)
  assert.deepEqual(await replacementCallback.json(), { connectionId: replacementConnectionId })
  assert.deepEqual(
    await client.action(api.actions.useCredentials, { connectionId: replacementConnectionId }),
    { used: true, instanceUrl: 'https://local-instance.example.test' },
  )
  assert.equal(salesforce.tokenRequestCount, 7)
  assert.equal(salesforce.tokenRequests[6]?.form.get('grant_type'), 'authorization_code')

  assert.deepEqual(await client.action(api.actions.rejectStaleCompletion, { connectionId }), {
    interventionMarked: true,
    staleCompletionRejected: true,
    retainedPhase: 'InterventionRequired',
  })
  assert.deepEqual(await client.query(api.actions.inspectConnection, { connectionId }), {
    savedAuthorization: true,
    credentialWork: 'intervention-required',
  })
  assert.equal(salesforce.tokenRequestCount, 7, 'Stale completion check dispatched provider work')

  await authorize(removalConnectionId)
  const beforeRemoval = await client.query(api.actions.rawConnection, {
    connectionId: removalConnectionId,
  })
  assert.ok(beforeRemoval)
  assert.equal(beforeRemoval.authorization._tag, 'Authorized')

  const preparedStaleReplacement = await client.action(api.actions.startReplacement, {
    connectionId: removalConnectionId,
  })
  const staleReplacementAuthorization = await fetch(preparedStaleReplacement.url, {
    redirect: 'manual',
  })
  const staleReplacementCallbackUrl = staleReplacementAuthorization.headers.get('location')
  assert.ok(staleReplacementCallbackUrl, 'Stale replacement did not return a callback')

  const staleRefresh = client
    .action(api.actions.useCredentials, { connectionId: removalConnectionId })
    .then(
      (value) => ({ _tag: 'Succeeded' as const, value }),
      () => ({ _tag: 'Failed' as const }),
    )
  await eventually(
    () => salesforce?.tokenRequestCount === 9,
    'Removal-racing local refresh did not dispatch',
  )
  const stateAtRemoval = await client.query(api.actions.rawConnection, {
    connectionId: removalConnectionId,
  })
  assert.ok(stateAtRemoval)
  const providerRequestsBeforeRemoval = {
    authorization: salesforce.authorizationRequestCount,
    token: salesforce.tokenRequestCount,
  }

  assert.deepEqual(
    await client.action(api.actions.removeConnection, { connectionId: removalConnectionId }),
    { removed: true },
  )
  assert.deepEqual(
    {
      authorization: salesforce.authorizationRequestCount,
      token: salesforce.tokenRequestCount,
    },
    providerRequestsBeforeRemoval,
    'Local removal made a provider request',
  )
  assert.deepEqual(
    await client.query(api.actions.inspectConnection, { connectionId: removalConnectionId }),
    { savedAuthorization: false, credentialWork: 'idle' },
  )
  assert.deepEqual(
    recordOutcome(
      await client.action(api.actions.credentialOutcome, { connectionId: removalConnectionId }),
    ),
    { _tag: 'AuthorizationRequired' },
  )

  const tombstone = await client.query(api.actions.rawConnection, {
    connectionId: removalConnectionId,
  })
  assert.ok(tombstone)
  assert.equal(tombstone.generation, stateAtRemoval.generation + 1)
  assert.equal(tombstone.revision, stateAtRemoval.revision + 1)
  assert.deepEqual(tombstone.authorization, { _tag: 'NotAuthorized' })
  assert.equal(tombstone.credentialEnvelope, null)

  await authorize(removalConnectionId)
  assert.equal(
    (await fetch(staleReplacementCallbackUrl, { redirect: 'manual' })).status,
    400,
    'A callback from before removal was accepted after reenrollment',
  )
  assert.deepEqual(await staleRefresh, { _tag: 'Failed' })
  assert.equal(
    salesforce.tokenRequestCount,
    providerRequestsBeforeRemoval.token + 1,
    'Stale callback or refresh work dispatched another provider request',
  )
  assert.deepEqual(
    await client.action(api.actions.useCredentials, { connectionId: removalConnectionId }),
    { used: true, instanceUrl: 'https://local-instance.example.test' },
  )
  assert.deepEqual(
    await client.query(api.actions.inspectConnection, { connectionId: removalConnectionId }),
    { savedAuthorization: true, credentialWork: 'idle' },
  )
  const reenrolled = await client.query(api.actions.rawConnection, {
    connectionId: removalConnectionId,
  })
  assert.ok(reenrolled)
  assert.equal(reenrolled.generation, tombstone.generation)
  assert.ok(reenrolled.revision > tombstone.revision)
  assert.equal(reenrolled.authorization._tag, 'Authorized')
  const serializedReenrollment = JSON.stringify(reenrolled)
  for (const secret of [
    removalInitialAccessToken,
    removalInitialRefreshToken,
    removalStaleAccessToken,
    removalStaleRefreshToken,
    removalReenrolledAccessToken,
    removalReenrolledRefreshToken,
    clientSecret,
    encryptionKey,
  ]) {
    assert.equal(
      serializedReenrollment.includes(secret),
      false,
      'Reenrollment persistence exposed a secret',
    )
  }

  await authorize(pendingConnectionId)
  const pendingOwner = client.action(api.actions.credentialOutcome, {
    connectionId: pendingConnectionId,
  })
  await eventually(() => salesforce?.tokenRequestCount === 12, 'Pending refresh did not dispatch')
  assert.deepEqual(
    recordOutcome(
      await client.action(api.actions.credentialOutcome, { connectionId: pendingConnectionId }),
    ),
    { _tag: 'TemporarilyUnavailable' },
  )
  assert.deepEqual(recordOutcome(await pendingOwner), { _tag: 'Succeeded' })

  await authorize(rejectedConnectionId)
  assert.deepEqual(
    recordOutcome(
      await client.action(api.actions.credentialOutcome, { connectionId: rejectedConnectionId }),
    ),
    { _tag: 'AuthorizationRequired' },
  )

  await authorize(unknownConnectionId)
  assert.deepEqual(
    recordOutcome(
      await client.action(api.actions.credentialOutcome, { connectionId: unknownConnectionId }),
    ),
    { _tag: 'InterventionRequired', cause: 'ProviderOutcomeUnknown' },
  )

  assert.deepEqual(
    recordOutcome(
      await client.action(api.actions.credentialOutcomeWithStorageFailure, {
        connectionId: missingConnectionId,
      }),
    ),
    { _tag: 'TemporarilyUnavailable', cause: 'StorageFailure' },
  )

  await authorize(encryptionConnectionId)
  assert.deepEqual(
    recordOutcome(
      await client.action(api.actions.credentialOutcomeWithEncryptionFailure, {
        connectionId: encryptionConnectionId,
      }),
    ),
    { _tag: 'InterventionRequired', cause: 'EncryptionFailure' },
  )

  await authorize(conflictConnectionId)
  assert.deepEqual(
    recordOutcome(
      await client.action(api.actions.credentialOutcomeWithConflict, {
        connectionId: conflictConnectionId,
      }),
    ),
    { _tag: 'InterventionRequired', cause: 'Conflict' },
  )
  assert.equal(salesforce.authorizationRequestCount, 13)
  assert.equal(salesforce.tokenRequestCount, 19)

  const persistedConnections = await Promise.all(
    [
      connectionId,
      concurrentConnectionId,
      acknowledgementConnectionId,
      replacementConnectionId,
      removalConnectionId,
      pendingConnectionId,
      rejectedConnectionId,
      unknownConnectionId,
      encryptionConnectionId,
      conflictConnectionId,
    ].map((selectedConnectionId) =>
      client.query(api.actions.rawConnection, { connectionId: selectedConnectionId }),
    ),
  )
  const nonEnvelopeMetadata = persistedConnections.map((connection) => {
    if (connection === null) return null
    const { credentialEnvelope: _credentialEnvelope, ...metadata } = connection
    return metadata
  })
  assertSecretCanariesAbsent('Serialized credential outcomes', serializedOutcomes.join('\n'))
  assertSecretCanariesAbsent('Raw persisted connections', JSON.stringify(persistedConnections))
  assertSecretCanariesAbsent('Non-envelope persisted metadata', JSON.stringify(nonEnvelopeMetadata))
  await delay(50)
  assertSecretCanariesAbsent(
    'Local Convex logs',
    `${recentOutput}\n${readFileSync(logFile, 'utf8')}`,
  )

  console.log(
    'PASS: anonymous local Convex authorization, same-ID replacement and removal/reenrollment, complete Effect programs with scoped Promise-boundary cleanup, three retrieval categories with five safe causes, query-only inspection, unqueued shared refresh, follower cancellation, acknowledgement recovery, stale callback/work fencing, secret-safe diagnostics/metadata/logs, encrypted persistence, and generated references.',
  )
  console.log('No Salesforce or Convex cloud service was contacted.')
} finally {
  try {
    await salesforce?.close()
  } finally {
    await stop()
    clearTimeout(watchdog)
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
  }
}
