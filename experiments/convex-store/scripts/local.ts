// Starts ONLY this experiment's anonymous loopback backend, then stops its process group.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../src/convex/_generated/api.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const cloudPort = 33210
const sitePort = 33211
const url = `http://127.0.0.1:${cloudPort}`
const backendVersion = 'precompiled-2026-08-25-7cce8fb'
const fakeKey = Buffer.alloc(32, 42).toString('base64') // Never a real secret.
const cli = resolve(root, 'node_modules/convex/bin/main.js')

// Do not inherit user deployment credentials, project selection, or account config.
const childEnv: NodeJS.ProcessEnv = { ...process.env }
for (const key of Object.keys(childEnv)) if (key.startsWith('CONVEX_')) delete childEnv[key]
delete childEnv.VERCEL
const home = resolve(root, '.local/home')
const cache = resolve(root, '.local/cache')
Object.assign(childEnv, {
  CONVEX_AGENT_MODE: 'anonymous', CI: '1', HOME: home, XDG_CACHE_HOME: cache,
  NODE_OPTIONS: `--require=${JSON.stringify(resolve(root, 'scripts/loopback.cjs'))}`,
})
mkdirSync(home, { recursive: true })
mkdirSync(cache, { recursive: true })
// An explicit env file makes the CLI bypass .env/.env.local deployment selection.
// Agent mode alone is insufficient: deployment keys take precedence over it.
const selectionFile = resolve(root, '.local/anonymous.env')
writeFileSync(selectionFile, 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n', { mode: 0o600 })

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const listening = (port: number) => new Promise<boolean>((done) => {
  const socket = connect({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); done(true) })
  socket.once('error', () => { socket.destroy(); done(false) })
})
assert.equal(await listening(cloudPort), false, 'Port occupied; will not touch another backend')
assert.equal(await listening(sitePort), false, 'Site port occupied; will not touch another backend')
const log = createWriteStream(resolve(root, '.local/convex-dev.log'))
const dev = spawn('node', [cli, 'dev', '--typecheck', 'disable', '--tail-logs', 'disable',
  '--local-cloud-port', String(cloudPort), '--local-site-port', String(sitePort),
  '--local-backend-version', backendVersion, '--env-file', selectionFile,
], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let output = ''
const exited = new Promise<void>((done) => dev.once('exit', () => done()))
const ready = new Promise<void>((done, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Local backend startup timed out; see .local/convex-dev.log`)), 90_000)
  const receive = (data: Buffer) => {
    log.write(data)
    output = (output + data.toString()).slice(-40_000)
    if (output.includes('Convex functions ready!')) { clearTimeout(timeout); done() }
    if (output.includes('Error: Unable to start push')) { clearTimeout(timeout); reject(new Error(output)) }
  }
  dev.stdout.on('data', receive)
  dev.stderr.on('data', receive)
  dev.once('error', (error) => { clearTimeout(timeout); reject(error) })
  dev.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Local CLI exited (${code}): ${output}`)) })
})

const commands = new Set<ReturnType<typeof spawn>>()
const command = (args: string[]) => new Promise<void>((done, reject) => {
  const child = spawn('node', [cli, ...args, '--env-file', selectionFile], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  commands.add(child)
  child.once('exit', () => commands.delete(child))
  let text = ''
  child.stdout.on('data', (data) => { text += data.toString() })
  child.stderr.on('data', (data) => { text += data.toString() })
  child.once('error', reject)
  child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Local CLI command failed: ${text}`)))
})

async function smoke() {
  const client = new ConvexHttpClient(url)
  const id = `local-${crypto.randomUUID()}`
  const storageKey = JSON.stringify(['fake-salesforce', id])
  assert.deepEqual(await client.action(api.actions.runtimeProbe, {}), { timer: true, interrupted: true, finalized: true, childFinalized: true })
  console.log('PASS: Effect timers, interruption, and cleanup in the default Convex action runtime.')

  await client.action(api.actions.seed, { id })
  const before = await client.query(api.fixtures.read, { key: storageKey })
  assert.ok(before)
  assert.equal(before.envelope.iv.byteLength, 12)
  assert.ok(!new TextDecoder().decode(before.envelope.ciphertext).includes('FAKE-refresh'))
  const results = await Promise.all(Array.from({ length: 8 }, () => client.action(api.actions.credentialsProbe, { id })))
  assert.deepEqual(results, Array.from({ length: 8 }, () => ({ usable: true, redacted: true })))
  assert.equal(await client.query(api.fixtures.providerCalls, { key: storageKey }), 1)
  assert.equal(await client.query(api.fixtures.providerRequests, { key: storageKey }), 1)
  const after = await client.query(api.fixtures.read, { key: storageKey })
  assert.ok(after)
  assert.equal(after.version, 2)
  assert.equal(after.owner, null)
  assert.notDeepEqual(after.envelope.iv, before.envelope.iv)
  console.log('PASS: eight action invocations → one local HTTP refresh, encrypted replacement, no returned secrets.')

  assert.deepEqual(await client.query(api.facadeProbes.inspect, { id }), {
    savedAuthorization: true, credentialWorkPending: false,
  })
  assert.deepEqual(await client.query(api.facadeProbes.inspect, { id: `${id}-missing` }), {
    savedAuthorization: false, credentialWorkPending: false,
  })
  const ackId = `${id}-ack`
  const ackKey = JSON.stringify(['fake-salesforce', ackId])
  assert.deepEqual(await client.action(api.facadeProbes.acknowledgement, { id: ackId }), {
    usable: true, encryptions: 1, completions: 2, identicalWrites: true, disposed: true, finalized: true,
  })
  assert.equal(await client.query(api.fixtures.providerRequests, { key: ackKey }), 1)
  assert.equal(await client.query(api.fixtures.providerCalls, { key: ackKey }), 1)
  assert.deepEqual(await client.query(api.facadeProbes.inspect, { id: ackId }), {
    savedAuthorization: true, credentialWorkPending: false,
  })
  console.log('PASS: query-only key-free inspection; scoped Promise facade; AFTER APPLY ack loss → same encrypted write, one HTTP refresh.')

  const secondId = `${id}-independent`
  await client.action(api.actions.seed, { id: secondId })
  assert.deepEqual(await client.action(api.actions.credentialsProbe, { id: secondId }), { usable: true, redacted: true })
  assert.equal(await client.query(api.fixtures.providerCalls, { key: JSON.stringify(['fake-salesforce', secondId]) }), 1)
  assert.equal(await client.query(api.fixtures.providerCalls, { key: storageKey }), 1)

  const claimId = `${id}-claims`
  const claimKey = JSON.stringify(['fake-salesforce', claimId])
  await client.action(api.actions.seed, { id: claimId })
  // ConvexHttpClient queues mutations by default. Explicitly bypass that queue
  // so this checks the backend's OCC, not client-side serialization.
  const claims = await Promise.all(Array.from({ length: 12 }, (_, index) => client.mutation(api.fixtures.claim, {
    key: claimKey, expectedVersion: 0, owner: `owner-${index}`, leaseMs: 5_000,
  }, { skipQueue: true })))
  assert.equal(claims.filter((claim) => claim.claimed).length, 1)
  const winner = claims.findIndex((claim) => claim.claimed)
  const claim = claims[winner]
  assert.ok(claim.claimed)
  const claimRow = await client.query(api.fixtures.read, { key: claimKey })
  assert.ok(claimRow)
  const completion = { key: claimKey, owner: `owner-${winner}`, fence: claim.fence, writeId: 'completion-1', envelope: claimRow.envelope, expiresAt: 0 }
  assert.equal((await client.mutation(api.fixtures.complete, completion)).status, 'committed')
  assert.equal((await client.mutation(api.fixtures.complete, completion)).status, 'already-applied')
  const next = await client.mutation(api.fixtures.claim, { key: claimKey, expectedVersion: 2, owner: 'new', leaseMs: 5_000 })
  assert.ok(next.claimed)
  assert.equal((await client.mutation(api.fixtures.complete, { ...completion, writeId: 'late' })).status, 'conflict')
  assert.equal(await client.mutation(api.fixtures.renew, { key: claimKey, owner: completion.owner, fence: claim.fence, leaseMs: 5_000 }), false)
  console.log('PASS: twelve unqueued mutations → one atomic claim; idempotent completion and stale-owner rejection.')

  const leaseId = `${id}-lease`
  const leaseKey = JSON.stringify(['fake-salesforce', leaseId])
  await client.action(api.actions.seed, { id: leaseId })
  const expired = await client.mutation(api.fixtures.claim, { key: leaseKey, expectedVersion: 0, owner: 'old', leaseMs: 20 })
  assert.ok(expired.claimed)
  await delay(50)
  assert.equal(await client.mutation(api.fixtures.renew, { key: leaseKey, owner: 'old', fence: expired.fence, leaseMs: 20 }), false)
  const transfer = await client.mutation(api.fixtures.claim, { key: leaseKey, expectedVersion: 1, owner: 'replacement', leaseMs: 5_000 })
  assert.ok(transfer.claimed && transfer.fence > expired.fence)
  // This is a storage-capability check, not permission to repeat an OAuth exchange.
  assert.equal((await client.mutation(api.fixtures.complete, { ...completion, key: leaseKey, owner: 'old', fence: expired.fence })).status, 'conflict')

  await client.mutation(api.fixtures.saveAttempt, { id, envelope: before.envelope, binding: 'session-A', expiresAt: Date.now() + 60_000 })
  assert.equal(await client.mutation(api.fixtures.consumeAttempt, { id, binding: 'wrong' }), null)
  const consumed = await Promise.all(Array.from({ length: 8 }, () => client.mutation(api.fixtures.consumeAttempt,
    { id, binding: 'session-A' }, { skipQueue: true })))
  assert.equal(consumed.filter((value) => value !== null).length, 1)
  await client.mutation(api.fixtures.saveAttempt, { id: `${id}-expired`, envelope: before.envelope, binding: 'session-A', expiresAt: 0 })
  assert.equal(await client.mutation(api.fixtures.consumeAttempt, { id: `${id}-expired`, binding: 'session-A' }), null)
  console.log('PASS: storage lease expiry/transfer and session-bound, expiring, single-use attempts.')
}

let stopping: Promise<void> | undefined
const stop = () => stopping ??= (async () => {
  for (const child of commands) child.kill('SIGTERM')
  if (dev.pid !== undefined) {
    try { process.kill(-dev.pid, 'SIGINT') } catch { /* already stopped */ }
    await Promise.race([exited, delay(5_000)])
    // Stop owned children even if the CLI exited before them.
    try { process.kill(-dev.pid, 'SIGTERM') } catch { /* process group is gone */ }
  }
  log.end()
  for (let i = 0; i < 50 && (await listening(cloudPort) || await listening(sitePort)); i++) await delay(100)
  if (dev.pid !== undefined && (await listening(cloudPort) || await listening(sitePort))) {
    try { process.kill(-dev.pid, 'SIGKILL') } catch { /* already stopped */ }
    await delay(250)
  }
  assert.equal(await listening(cloudPort), false, 'Local backend did not stop')
  assert.equal(await listening(sitePort), false, 'Local HTTP server did not stop')
  console.log('Stopped the experiment backend and HTTP listener.')
})()
const onSignal = (code: number) => { void stop().then(() => process.exit(code), (error) => { console.error(error); process.exit(1) }) }
const onInterrupt = () => onSignal(130)
const onTerminate = () => onSignal(143)
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onTerminate)
const watchdog = setTimeout(() => { console.error('Local experiment exceeded its two-minute deadline'); onSignal(1) }, 120_000)
try {
  await ready
  console.log(`Local-only backend ready: ${url} (${backendVersion}).`)
  await command(['env', 'set', 'CONNECTIONS_TEST_KEY', fakeKey])
  await smoke()
  console.log('ALL LOCAL CONVEX CHECKS PASSED. No cloud project or deployment was created.')
} finally {
  await stop()
  clearTimeout(watchdog)
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onTerminate)
}
