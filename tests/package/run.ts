import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortsAvailable,
  inheritedCredentialCanaryName,
  isolatedEnvironment,
  listening,
  stopOwnedProcessGroup,
} from '../helpers/process-isolation.js'

interface CommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const testRoot = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(testRoot, '../..')
const fixtureRoot = join(testRoot, 'fixture')
const typescriptCli = join(projectRoot, 'node_modules/typescript/bin/tsc')
const convexCli = join(projectRoot, 'node_modules/convex/bin/main.js')
const intentCli = join(projectRoot, 'node_modules/@tanstack/intent/dist/cli.mjs')
const loopbackGuard = join(projectRoot, 'tests/stores/convex/local/loopback.cjs')
const backendVersion = 'precompiled-2026-08-25-7cce8fb'
const packageName = '@indev42/connections'
const cloudPort = 33_320
const sitePort = 33_321
let defaultEnvironment = process.env
let ownedProcess: ChildProcess | undefined

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly timeout?: number },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? defaultEnvironment,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  })
  const commandLine = [command, ...args].join(' ')
  if (result.error !== undefined) {
    throw new Error(`${commandLine} failed to start`, { cause: result.error })
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function runOwned(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly timeout?: number },
): Promise<CommandResult> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? defaultEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    ownedProcess = child
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (data) => (stdout += data.toString()))
    child.stderr.on('data', (data) => (stderr += data.toString()))
    const timeout = setTimeout(() => {
      timedOut = true
      void stopOwnedProcessGroup(child)
    }, options.timeout ?? 120_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      ownedProcess = undefined
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      ownedProcess = undefined
      done({
        status: timedOut ? null : code,
        stdout,
        stderr: timedOut ? `${stderr}\nCommand timed out` : stderr,
      })
    })
  })
}

function requireSuccess(label: string, result: CommandResult): void {
  assert.equal(
    result.status,
    0,
    `${label} failed\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  )
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function filesBelow(root: string): readonly string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(root)
  return files
}

const scratch = mkdtempSync(join(tmpdir(), 'connections-package-'))
defaultEnvironment = isolatedEnvironment(
  scratch,
  {
    CI: '1',
    CONVEX_AGENT_MODE: 'anonymous',
    DISABLE_BEACON: 'true',
    SENTRY_DSN: '',
    NODE_OPTIONS: `--require=${JSON.stringify(loopbackGuard)}`,
  },
  {
    ...process.env,
    [inheritedCredentialCanaryName]: '__connections_package_inherited_credential_canary__',
  },
)
assert.equal(
  defaultEnvironment[inheritedCredentialCanaryName],
  undefined,
  'Inherited credential canary reached the package consumer environment',
)
let requireClosedPorts = false
let cleanupPromise: Promise<void> | undefined
const cleanup = (): Promise<void> => {
  cleanupPromise ??= (async () => {
    if (ownedProcess !== undefined) await stopOwnedProcessGroup(ownedProcess)
    if (requireClosedPorts) {
      assert.equal(await listening(cloudPort), false, 'Owned package-test backend did not stop')
      assert.equal(
        await listening(sitePort),
        false,
        'Owned package-test HTTP listener did not stop',
      )
    }
    rmSync(scratch, { recursive: true, force: true })
    assert.equal(existsSync(scratch), false, 'Package runner scratch directory was not cleaned')
  })()
  return cleanupPromise
}
const exitAfterSignal = (code: number): void => {
  void cleanup().then(
    () => process.exit(code),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
}
const onInterrupt = () => exitAfterSignal(130)
const onTerminate = () => exitAfterSignal(143)
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onTerminate)

let archive = join(scratch, 'connections.tgz')
const unpacked = join(scratch, 'unpacked')
const consumer = join(scratch, 'consumer')

try {
  requireSuccess('package build', run(process.execPath, ['run', 'build'], { cwd: projectRoot }))
  requireSuccess(
    'package archive creation',
    run(process.execPath, ['pm', 'pack', '--ignore-scripts', '--destination', scratch, '--quiet'], {
      cwd: projectRoot,
    }),
  )
  const archives = readdirSync(scratch).filter((path) => path.endsWith('.tgz'))
  assert.equal(archives.length, 1, 'bun pm pack did not create exactly one archive')
  archive = join(scratch, archives[0]!)

  mkdirSync(unpacked)
  requireSuccess(
    'package archive extraction',
    run('tar', ['-xzf', archive, '-C', unpacked], { cwd: scratch }),
  )
  const packagedRoot = join(unpacked, 'package')
  const manifest = readJson(join(packagedRoot, 'package.json'))
  assert.deepEqual(
    Object.keys((manifest.dependencies ?? {}) as Record<string, unknown>),
    ['effect'],
    'effect must be the only direct runtime dependency',
  )
  assert.deepEqual(
    manifest.peerDependencies,
    { convex: '>=1.45.0 <1.46.0' },
    'Convex must declare the supported consumer-provided range',
  )
  assert.deepEqual(
    manifest.peerDependenciesMeta,
    { convex: { optional: true } },
    'Convex must remain optional for consumers that do not import its adapter',
  )

  const exports = manifest.exports as Record<string, unknown>
  for (const entry of [
    '.',
    './providers/api-key',
    './providers/salesforce',
    './providers/shopify',
    './providers/yotpo',
    './providers/zoho',
    './stores/convex',
    './stores/memory',
    './stores/sqlite',
    './stores/postgresql',
    './stores/convex/convex.config.js',
    './stores/convex/*',
    './encryptors/aes-gcm',
    './configuration',
    './package.json',
  ]) {
    assert.ok(entry in exports, `Packed package is missing export ${entry}`)
  }

  for (const path of [
    'LICENSE',
    'dist/stores/convex/component/convex.config.js',
    'dist/stores/convex/component/convex.config.d.ts',
    'dist/stores/convex/component/attempts.js',
    'dist/stores/convex/component/attempts.d.ts',
    'dist/stores/convex/component/connections.js',
    'dist/stores/convex/component/connections.d.ts',
    'dist/stores/convex/component/operations.js',
    'dist/stores/convex/component/operations.d.ts',
    'dist/stores/convex/component/receipts.js',
    'dist/stores/convex/component/receipts.d.ts',
    'dist/stores/convex/component/schema.js',
    'dist/stores/convex/component/schema.d.ts',
    'dist/stores/convex/component/persistence.js',
    'dist/stores/convex/component/persistence.d.ts',
    'dist/stores/convex/component/_generated/api.js',
    'dist/stores/convex/component/_generated/api.d.ts',
    'dist/stores/convex/component/_generated/component.js',
    'dist/stores/convex/component/_generated/component.d.ts',
    'dist/stores/convex/component/_generated/dataModel.js',
    'dist/stores/convex/component/_generated/dataModel.d.ts',
    'dist/stores/convex/component/_generated/server.js',
    'dist/stores/convex/component/_generated/server.d.ts',
    'dist/stores/internal/transition-kernel.js',
    'dist/stores/internal/transition-kernel.d.ts',
    'docs/getting-started.md',
    'docs/reference.md',
    'docs/providers/salesforce.md',
    'docs/providers/zoho.md',
    'docs/stores/convex.md',
    'docs/stores/postgresql.md',
    'skills/connections/SKILL.md',
  ]) {
    assert.equal(existsSync(join(packagedRoot, path)), true, `Packed package is missing ${path}`)
  }
  assert.equal(
    existsSync(join(packagedRoot, 'skills/_artifacts')),
    false,
    'Packed package must not include Intent generation artifacts',
  )
  assert.equal(
    existsSync(join(packagedRoot, 'src')),
    false,
    'Packed package must not include source paths required by consumers',
  )
  for (const path of ['dist/providers/yotpo.mjs', 'dist/providers/yotpo.d.mts']) {
    assert.equal(existsSync(join(packagedRoot, path)), true, `Packed package is missing ${path}`)
  }

  cpSync(fixtureRoot, consumer, { recursive: true })
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'connections-package-consumer',
        private: true,
        type: 'module',
        dependencies: { [packageName]: `file:${archive}` },
        intent: { skills: [packageName] },
      },
      null,
      2,
    ),
  )
  requireSuccess(
    'consumer install without Convex',
    run(process.execPath, ['install', '--ignore-scripts'], { cwd: consumer }),
  )
  const intentList = run('node', [intentCli, 'list', '--json'], { cwd: consumer })
  requireSuccess('Intent package discovery', intentList)
  assert.equal(
    (
      JSON.parse(intentList.stdout) as { readonly skills: readonly { readonly use: string }[] }
    ).skills
      .map(({ use }) => use)
      .includes(`${packageName}#connections`),
    true,
    'Intent did not discover the packaged connections skill',
  )
  const intentLoad = run('node', [intentCli, 'load', `${packageName}#connections`], {
    cwd: consumer,
  })
  requireSuccess('Intent skill load', intentLoad)
  assert.match(intentLoad.stdout, /^# Connections$/m, 'Intent did not load the connections skill')

  requireSuccess(
    'core package runtime import',
    run(process.execPath, ['core.ts'], { cwd: consumer }),
  )
  requireSuccess('SQLite package runtime', run(process.execPath, ['sqlite.ts'], { cwd: consumer }))
  requireSuccess(
    'core package typecheck',
    run('node', [typescriptCli, '--project', 'tsconfig.core.json'], { cwd: consumer }),
  )
  requireSuccess(
    'Promise-first package runtime exports',
    run(
      process.execPath,
      [
        '-e',
        `import { Connections, revealSecret } from '${packageName}'; if (typeof Connections.create !== 'function' || typeof revealSecret !== 'function') throw new Error('Missing Promise-first package exports')`,
      ],
      { cwd: consumer },
    ),
  )

  writeFileSync(
    join(consumer, 'promise-interface.ts'),
    `import { Connections, revealSecret } from '${packageName}'
import { Memory } from '${packageName}/stores/memory'
import { Salesforce, type SalesforceCredentials } from '${packageName}/providers/salesforce'
import { ApiKey } from '${packageName}/providers/api-key'
import { Effect } from 'effect'

const manager = Connections.create({
  store: Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }),
  provider: Salesforce.oauth({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.test/callback',
    scopes: ['api'],
  }),
})
const salesforceClient = Connections.create({
  store: Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }),
  provider: Salesforce.clientCredentials({ loginUrl: 'https://example.my.salesforce.com' }),
})
salesforceClient.setClientCredentials('id', { clientId: 'id', clientSecret: 'secret' })
const clientCredentials: SalesforceCredentials = await salesforceClient.credentials('id')
void clientCredentials
// @ts-expect-error Client credentials have no browser flow.
salesforceClient.startAuthorization('id', { binding: 'binding' })
// @ts-expect-error Source secrets are required.
salesforceClient.setClientCredentials('id', { clientId: 'id' })
// @ts-expect-error A My Domain URL is required.
Salesforce.clientCredentials({})
// @ts-expect-error Use credentials do not contain retained source secrets.
void clientCredentials.clientSecret
const credentials: SalesforceCredentials = await manager.credentials('connection')
const accessToken: string = revealSecret(credentials.accessToken)
const effectOperation = manager.effect.credentials('connection')
const credentialUse = await manager.credentialUse('connection')
void accessToken
void effectOperation
void credentialUse.reportRejected
// @ts-expect-error Browser OAuth cannot enroll API keys.
manager.setApiKey('connection', 'key')
// @ts-expect-error Credential results exclude lifecycle-only refresh tokens.
void credentials.refreshToken
// @ts-expect-error Secrets are redacted until explicitly revealed.
const rawToken: string = credentials.accessToken
void rawToken
const apiKey = Connections.create({ store: Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }), provider: ApiKey.opaque({ id: 'retell' }) })
apiKey.setApiKey('connection', 'key', { replace: true })
// @ts-expect-error Replacement uses a named option, not a positional boolean.
apiKey.setApiKey('connection', 'key', true)
// @ts-expect-error API-key managers cannot start browser OAuth.
apiKey.startAuthorization('connection', { binding: 'binding' })
// @ts-expect-error There is no public namespace option.
Connections.create({ store: Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }), provider: ApiKey.opaque({ id: 'retell' }), namespace: 'old' })
declare const serviceClientId: Effect.Effect<string, never, { readonly configuration: string }>
const serviceProvider = Salesforce.oauth({ clientId: serviceClientId, clientSecret: 'secret', redirectUri: 'https://example.test/callback', scopes: ['api'] })
// @ts-expect-error Arbitrary Effect-service requirements are unsupported.
Connections.create({ store: Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }), provider: serviceProvider })
`,
  )
  writeFileSync(
    join(consumer, 'tsconfig.promise.json'),
    JSON.stringify({ extends: './tsconfig.core.json', include: ['promise-interface.ts'] }, null, 2),
  )
  requireSuccess(
    'Promise-first package typecheck',
    run('node', [typescriptCli, '--project', 'tsconfig.promise.json'], { cwd: consumer }),
  )

  const missingConvexTypes = run('node', [typescriptCli, '--project', 'tsconfig.convex.json'], {
    cwd: consumer,
  })
  assert.notEqual(
    missingConvexTypes.status,
    0,
    'Convex entry unexpectedly typechecked without Convex installed',
  )
  assert.match(
    `${missingConvexTypes.stdout}\n${missingConvexTypes.stderr}`,
    /Cannot find module ['"]convex\/server['"]/,
    'Missing Convex typecheck did not identify the consumer-provided dependency',
  )

  const missingConvexRuntime = run(
    process.execPath,
    ['-e', `await import('${packageName}/stores/convex/convex.config.js')`],
    { cwd: consumer },
  )
  assert.notEqual(
    missingConvexRuntime.status,
    0,
    'Convex component unexpectedly loaded without Convex installed',
  )
  assert.match(
    `${missingConvexRuntime.stdout}\n${missingConvexRuntime.stderr}`,
    /(Cannot find package|Cannot find module|Could not resolve).*['"]convex(?:\/|['"])/is,
    'Missing Convex runtime failure did not identify the consumer-provided dependency',
  )

  const consumerManifest = readJson(join(consumer, 'package.json'))
  consumerManifest.dependencies = {
    ...(consumerManifest.dependencies as Record<string, unknown>),
    convex: '1.45.0',
  }
  consumerManifest.devDependencies = {
    '@neondatabase/serverless': '1.1.0',
    '@types/pg': '8.23.1',
    pg: '8.23.0',
    typescript: '7.0.2',
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify(consumerManifest, null, 2))
  requireSuccess(
    'consumer install with Convex',
    run(process.execPath, ['install', '--ignore-scripts'], { cwd: consumer }),
  )
  requireSuccess(
    'PostgreSQL structural package typecheck',
    run('node', [typescriptCli, '--project', 'tsconfig.postgresql.json'], { cwd: consumer }),
  )
  requireSuccess(
    'Convex package runtime import',
    run(process.execPath, ['full.ts'], { cwd: consumer }),
  )

  const selectionFile = join(scratch, 'anonymous.env')
  writeFileSync(selectionFile, 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n', { mode: 0o600 })
  await assertPortsAvailable([cloudPort, sitePort])
  requireClosedPorts = true
  requireSuccess(
    'anonymous local Convex code generation',
    await runOwned(
      'node',
      [
        convexCli,
        'dev',
        '--once',
        '--typecheck',
        'enable',
        '--local-cloud-port',
        String(cloudPort),
        '--local-site-port',
        String(sitePort),
        '--local-backend-version',
        backendVersion,
        '--env-file',
        selectionFile,
      ],
      { cwd: consumer, timeout: 180_000 },
    ),
  )

  const generatedRoot = join(consumer, 'src/convex/_generated')
  const generatedDeclarations = filesBelow(generatedRoot)
    .filter((path) => path.endsWith('.d.ts') || path.endsWith('.ts'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  assert.match(
    generatedDeclarations,
    /@indev42\/connections\/stores\/convex\/_generated\/component\.js/,
    'Generated declarations did not retain the packaged component subpath',
  )
  writeFileSync(
    join(consumer, 'src/convex/promise-binding.ts'),
    `import { Connections } from '${packageName}'
import { Salesforce } from '${packageName}/providers/salesforce'
import { Convex } from '${packageName}/stores/convex'
import { v } from 'convex/values'
import { action, query } from './_generated/server.js'
import { components } from './_generated/api.js'

const manager = Connections.create({
  store: Convex.store({
    component: components.connections,
    encryptionKey: () => 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  }),
  provider: Salesforce.oauth({
    clientId: () => 'client-id',
    clientSecret: () => 'client-secret',
    redirectUri: () => 'https://example.test/callback',
    scopes: ['api'],
  }),
})

export const readCredentials = action({
  args: { connectionId: v.string() },
  handler: async (ctx, { connectionId }) => {
    const bound = Convex.bind(ctx, manager)
    const credentials = await bound.credentials(connectionId)
    return credentials.instanceUrl
  },
})

export const inspectConnection = query({
  args: { connectionId: v.string() },
  handler: (ctx, { connectionId }) => {
    const bound = Convex.bind(ctx, manager)
    // @ts-expect-error Query bindings only expose non-decrypting inspection.
    bound.credentials(connectionId)
    return bound.inspect(connectionId)
  },
})
`,
  )
  requireSuccess(
    'generated consumer typecheck',
    run('node', [typescriptCli, '--project', 'tsconfig.json'], { cwd: consumer }),
  )
} finally {
  try {
    await cleanup()
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
  }
}
