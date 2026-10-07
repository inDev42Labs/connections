import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortsAvailable,
  inheritedCredentialCanaryName,
  isolatedEnvironment,
  listening,
  stopOwnedProcessGroup,
} from '../helpers/process-isolation.js'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const worker = resolve(root, 'tests/isolation/worker.ts')
const occupiedPort = 33_420
const signalPort = 33_421
const orphanPort = 33_422
const credentialCanary = '__connections_inherited_credential_canary__'

function runWorker(scratch: string, port: number): ChildProcess {
  return spawn(process.execPath, [worker, scratch, String(port)], {
    cwd: root,
    env: isolatedEnvironment(
      scratch,
      {},
      {
        ...process.env,
        [inheritedCredentialCanaryName]: credentialCanary,
      },
    ),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function completion(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly output: string }> {
  let output = ''
  child.stdout?.on('data', (data) => (output += data.toString()))
  child.stderr?.on('data', (data) => (output += data.toString()))
  return new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => done({ code, output }))
  })
}

async function waitUntil(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(message)
}

await assertPortsAvailable([occupiedPort, signalPort, orphanPort])

const foreign = createServer()
await new Promise<void>((done, reject) => {
  foreign.once('error', reject)
  foreign.listen(occupiedPort, '127.0.0.1', () => done())
})
const occupiedScratch = mkdtempSync(resolve(tmpdir(), 'connections-occupied-port-'))
try {
  const refused = await completion(runWorker(occupiedScratch, occupiedPort))
  assert.notEqual(refused.code, 0, 'Isolation worker accepted an occupied port')
  assert.match(refused.output, /occupied; refusing to touch it/)
  assert.equal(
    await listening(occupiedPort),
    true,
    'Isolation worker disturbed the foreign listener',
  )
  assert.equal(
    existsSync(resolve(occupiedScratch, 'owned.marker')),
    false,
    'Isolation worker created owned state after port refusal',
  )
} finally {
  await new Promise<void>((done) => foreign.close(() => done()))
  rmSync(occupiedScratch, { recursive: true, force: true })
}

const signalScratch = mkdtempSync(resolve(tmpdir(), 'connections-signal-cleanup-'))
const signaled = runWorker(signalScratch, signalPort)
const signaledCompletion = completion(signaled)
try {
  await waitUntil(() => listening(signalPort), 'Isolation worker did not open its owned port')
  assert.equal(signaled.kill('SIGTERM'), true, 'Could not signal the isolation worker')
  const result = await signaledCompletion
  assert.equal(result.code, 143, `Isolation worker exited unexpectedly:\n${result.output}`)
  await waitUntil(
    async () => !(await listening(signalPort)),
    'Signal cleanup left the owned port open',
  )
  assert.equal(existsSync(signalScratch), false, 'Signal cleanup left private state behind')
  assert.equal(
    result.output.includes(credentialCanary),
    false,
    'Isolation output exposed a credential canary',
  )
} finally {
  if (signaled.exitCode === null && signaled.signalCode === null) signaled.kill('SIGKILL')
  rmSync(signalScratch, { recursive: true, force: true })
}

const orphaned = spawn(
  process.execPath,
  [resolve(root, 'tests/isolation/orphan-worker.ts'), 'parent', String(orphanPort)],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
)
try {
  assert.equal((await completion(orphaned)).code, 0, 'Group leader did not exit normally')
  await waitUntil(() => listening(orphanPort), 'Orphaned descendant did not open its test port')
  await stopOwnedProcessGroup(orphaned)
  assert.equal(await listening(orphanPort), false, 'Exited group leader left a live descendant')
} finally {
  await stopOwnedProcessGroup(orphaned)
}

console.log(
  'PASS: occupied-port refusal, private HOME/cache, credential stripping, signal cleanup, and orphaned process-group cleanup.',
)
