// Actual owned OS worker loss at controlled checkpoints; still a fake provider.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { DatabaseSync } from 'node:sqlite'
import { FakeDatabase, LEASE } from './store'
import { FakeProvider, initialTokens } from './fakes'
import { ProcessStore } from './process-store'
import type { Policy } from './model'

const scratch = mkdtempSync(join(tmpdir(), 'lifecycle-process-'))
console.log(`Owned scratch: ${scratch}`)
const owned = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>()
let kills = 0
let workers = 0
let cleaning: Promise<void> | undefined
function cleanup() {
  return cleaning ??= (async () => {
    for (const child of owned.keys()) child.kill('SIGKILL')
    await Promise.all(owned.values())
    assert.equal(owned.size, 0)
    rmSync(scratch, { recursive: true, force: true })
    assert.equal(existsSync(scratch), false)
    console.log('CLEANUP VERIFIED: all owned workers reaped; scratch directory absent')
  })()
}
const terminate = (code: number) => { void cleanup().then(() => process.exit(code), (error) => { console.error(error); process.exit(1) }) }
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => terminate(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1)))
const watchdog = setTimeout(() => { console.error('Process demo watchdog expired'); terminate(1) }, 30000)

function worker(directory: string, mode = 'credentials', stop = '') {
  assert.equal(cleaning, undefined, 'Cannot start another worker during cleanup')
  const child = spawn(process.execPath, [fileURLToPath(new URL('./process-worker.ts', import.meta.url)), directory, mode, stop], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  workers++
  let stdout = ''; let stderr = ''
  let reached!: (value: Record<string, unknown>) => void
  let failed!: (error: Error) => void
  const message = new Promise<Record<string, unknown>>((resolve, reject) => { reached = resolve; failed = reject })
  child.stdout!.on('data', (chunk) => {
    stdout += String(chunk)
    const lines = stdout.trim().split('\n')
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (value.checkpoint || value.outcome) reached(value)
      } catch { /* Wait for the rest of a partial line. */ }
    }
  })
  child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => { failed(error); owned.delete(child); resolve({ code: 1, signal: null }) })
    child.once('close', (code, signal) => {
      owned.delete(child)
      if (code !== 0) failed(new Error(`Worker failed: ${code}/${signal}: ${stderr}`))
      else if (!stdout.trim()) failed(new Error('Worker exited without evidence'))
      resolve({ code, signal })
    })
  })
  owned.set(child, exited)
  return { child, message, exited }
}
async function killAt(directory: string, stop: string, mode = 'credentials') {
  const w = worker(directory, mode, stop)
  assert.deepEqual(await w.message, { checkpoint: stop, pid: w.child.pid })
  if (process.env.LIFECYCLE_TEST_ABORT === 'failure') throw new Error('Intentional cleanup failure probe')
  if (process.env.LIFECYCLE_TEST_ABORT === 'signal') {
    process.kill(process.pid, 'SIGTERM')
    await new Promise(() => {})
  }
  assert.ok(w.child.kill('SIGKILL'))
  assert.deepEqual(await w.exited, { code: null, signal: 'SIGKILL' })
  kills++
}
async function finish(directory: string, expected: string, mode = 'credentials') {
  const w = worker(directory, mode)
  const result = await w.message
  assert.equal(result.outcome, expected)
  assert.deepEqual(await w.exited, { code: 0, signal: null })
  return result
}
function fixture(name: string, policy: Policy = { kind: 'strict' }, losses = 0) {
  const directory = join(scratch, name)
  mkdirSync(directory)
  const db = new FakeDatabase(initialTokens())
  const provider = new FakeProvider(policy, () => db.now)
  provider.loseResponses = losses
  new ProcessStore(directory, { db, provider }).close()
  return directory
}
function using<A>(directory: string, body: (adapter: ProcessStore) => A): A {
  const adapter = new ProcessStore(directory)
  try { return body(adapter) } finally { adapter.close() }
}
const state = (directory: string) => using(directory, (a) => ({ snapshot: a.database((db) => db.snapshot()), provider: a.providerState() }))
const advance = (directory: string, ms = LEASE) => using(directory, (a) => a.database((db) => db.advance(ms)))

try {
  {
    const directory = fixture('read-only')
    const auditors = ['credentials', 'provider'].map((name) => {
      const db = new DatabaseSync(join(directory, `${name}.sqlite`))
      db.exec('CREATE TABLE writes (n INTEGER); CREATE TRIGGER record_write AFTER UPDATE ON state BEGIN INSERT INTO writes VALUES (1); END')
      return db
    })
    try {
      using(directory, (adapter) => {
        Effect.runSync(adapter.client().inspect())
        Effect.runSync(adapter.client().read())
        adapter.providerState()
        adapter.provider().refresh(initialTokens()) // Construct, do not execute.
      })
      for (const db of auditors) assert.equal(db.prepare('SELECT count(*) AS n FROM writes').get()!.n, 0,
        'Reading state or constructing work must not issue UPDATE statements')
    } finally { for (const db of auditors) db.close() }
    console.log('PASS SQLite read-only queries: inspection/state reads issue no writes')
  }
  for (const checkpoint of ['claimed', 'provider-committed', 'response', 'staged']) {
    const directory = fixture(checkpoint, { kind: 'strict' }, checkpoint === 'provider-committed' ? 1 : 0)
    // Constructing an Effect must not read/mutate the database or invoke the provider.
    using(directory, (a) => {
      const before = a.database((db) => db.exportState())
      a.client().remove('not-run', 0)
      a.provider().refresh(initialTokens())
      assert.deepEqual(a.database((db) => db.exportState()), before)
      assert.equal(a.providerState().calls, 0)
    })
    await killAt(directory, checkpoint)
    const before = state(directory)
    assert.equal(before.snapshot.operation?.sends, checkpoint === 'claimed' ? 0 : 1)
    assert.equal(before.provider.processed, checkpoint === 'claimed' ? 0 : 1)
    assert.equal(before.snapshot.operation?.staged !== null, checkpoint === 'staged')
    if (checkpoint === 'provider-committed') {
      assert.equal(before.provider.loseResponses, 0)
      assert.equal(before.provider.valid, 'FAKE-refresh-1')
      assert.equal(before.snapshot.tokens?.refresh, 'FAKE-refresh-0')
    }
    advance(directory)
    const recoverable = checkpoint === 'claimed' || checkpoint === 'staged'
    const result = await finish(directory, recoverable ? 'ok' : 'attention')
    const after = state(directory)
    assert.equal(after.provider.calls, 1)
    assert.equal(after.provider.processed, 1)
    if (recoverable) {
      assert.equal(result.access, 'FAKE-access-1')
      assert.equal(after.snapshot.operation?.done, true)
    } else assert.equal(after.snapshot.operation?.attention, true)
    console.log(`PASS SIGKILL ${checkpoint}: ${recoverable ? 'fresh process recovered' : 'attention, no replay'}; calls=processed=1`)
  }
  for (const losses of [2, 9]) {
    const directory = fixture(`reusable-${losses}`, { kind: 'reusable' }, losses)
    await killAt(directory, 'provider-committed')
    const original = state(directory).snapshot.operation!
    advance(directory)
    await killAt(directory, 'provider-committed')
    advance(directory)
    await finish(directory, losses === 2 ? 'ok' : 'unknown')
    if (losses === 9) {
      for (let i = 0; i < 2; i++) { advance(directory); await finish(directory, 'attention') }
    }
    const final = state(directory)
    assert.equal(final.snapshot.operation?.id, original.id)
    assert.equal(final.snapshot.operation?.firstSend, 100)
    assert.equal(final.snapshot.operation?.maxSends, 3)
    assert.equal(final.snapshot.operation?.sends, 3)
    assert.deepEqual(final.snapshot.operation?.policy, { kind: 'reusable' })
    assert.equal(final.provider.calls, 3)
    assert.equal(final.provider.processed, 3)
    assert.equal(final.snapshot.operation?.done, losses === 2)
    console.log(`PASS reusable ${losses === 2 ? 'recovery' : 'exhaustion'}: original id=${original.id}, firstSend=100, maxSends=sends=calls=3 across workers`)
  }
  {
    const directory = fixture('receipts')
    await killAt(directory, 'receipt-seeded', 'receipt-seed')
    await finish(directory, 'receipts-ok', 'receipt-check')
    const final = state(directory)
    assert.equal(final.provider.calls, 0)
    assert.equal(final.provider.exchanges, 0)
    console.log('PASS serialized receipts/reservations/history: stale writes fenced; removal retry preserves reenrollment; generation=3')
  }
  // Ensure adapter defects remain defects rather than modeled unknown/attention.
  const closed = new ProcessStore(fixture('defect'))
  closed.close()
  closed.client().read() // Construction remains lazy even with disposed resources.
  closed.provider().refresh(initialTokens())
  assert.equal(Effect.runSyncExit(Effect.result(closed.client().read()))._tag, 'Failure')
  console.log(`ALL PROCESS CHECKS PASSED (${kills} SIGKILLs; ${workers} OS workers; controlled checkpoints; fake provider).`)
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
