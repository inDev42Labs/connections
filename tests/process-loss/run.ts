import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { Effect } from 'effect'
import {
  digestStoreInput,
  type CompleteCredentialOperationCommand,
  type CompleteSelfClientExchangeCommand,
  type CredentialOperation,
} from '../../src/stores/index.js'
import {
  PROCESS_CONNECTION_KEY,
  PROCESS_CLIENT_CONNECTION_KEY,
  PROCESS_CLIENT_ACCESS_TOKEN,
  PROCESS_CREDENTIAL_FOLLOWER_WAIT,
  PROCESS_INITIAL_TIME,
  PROCESS_OWNERSHIP_LEASE,
  PROCESS_REFRESHED_ACCESS_TOKEN,
  PROCESS_REENROLLED_ACCESS_TOKEN,
  PROCESS_REPLACEMENT_ACCESS_TOKEN,
  PROCESS_SELF_CLIENT_ACK_ACCESS_TOKEN,
  PROCESS_SELF_CLIENT_ACK_CODE,
  PROCESS_SELF_CLIENT_CONNECTION_KEY,
  PROCESS_SELF_CLIENT_FRESH_ACCESS_TOKEN,
  PROCESS_SELF_CLIENT_FRESH_CODE,
  PROCESS_SELF_CLIENT_UNCERTAIN_CODE,
  PROCESS_SECRET_CANARIES,
  SqliteProcessStore,
  initializeSqliteClientCredentialsProcessFixture,
  initializeSqliteProcessFixture,
  readSqliteProviderState,
  type ProcessRefreshOutcome,
  type SqliteCommandEvent,
} from './sqlite-store.js'
import {
  parseWorkerEvidence,
  type CredentialOutcomeTag,
  type ProcessCheckpoint,
  type SafeCredentialCauseTag,
  type WorkerEvidence,
} from './protocol.js'

type WorkerMechanism = 'oauth' | 'client-credentials' | 'self-client'

type WorkerAction =
  | 'credentials'
  | 'enroll-code'
  | 'start-replacement'
  | 'complete-replacement'
  | 'remove'
  | 'start-enrollment'
  | 'complete-enrollment'

interface WorkerExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

interface OwnedWorker {
  readonly child: ChildProcess
  readonly evidence: Promise<WorkerEvidence>
  readonly exit: Promise<WorkerExit>
}

const scratch = mkdtempSync(join(tmpdir(), 'connections-process-loss-'))
const workerPath = fileURLToPath(new URL('./worker.ts', import.meta.url))
const owned = new Map<ChildProcess, Promise<WorkerExit>>()
const fixtureDirectories: string[] = []
const serializedPublicFailures: string[] = []
const workerLogEvidence: unknown[] = []
let cleanupPromise: Promise<void> | undefined
let sigkills = 0
let workers = 0

function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    for (const child of owned.keys()) child.kill('SIGKILL')
    await Promise.all(owned.values())
    assert.equal(owned.size, 0, 'Every owned worker must be reaped')
    rmSync(scratch, { recursive: true, force: true })
    assert.equal(existsSync(scratch), false, 'Owned scratch state must be removed')
    console.log('CLEANUP VERIFIED: all owned workers reaped; scratch directory absent')
  })()
  return cleanupPromise
}

function terminate(code: number): void {
  void cleanup().then(
    () => process.exit(code),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
}

const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const
const signalHandlers = Object.entries(signalCodes).map(([signal, code]) => {
  const typedSignal = signal as keyof typeof signalCodes
  const handler = () => terminate(code)
  process.on(typedSignal, handler)
  return { signal: typedSignal, handler }
})
const watchdog = setTimeout(() => {
  console.error('Process-loss watchdog expired')
  terminate(1)
}, 30_000)

function startWorker(
  directory: string,
  now: number,
  options?: {
    readonly action?: WorkerAction
    readonly checkpoint?: ProcessCheckpoint
    readonly callbackState?: string
    readonly clockAdvance?: number
    readonly mechanism?: WorkerMechanism
    readonly selfClientCode?: string
  },
): OwnedWorker {
  assert.equal(cleanupPromise, undefined, 'Cannot start workers after cleanup begins')
  const child = spawn(
    process.execPath,
    [
      workerPath,
      directory,
      options?.action ?? 'credentials',
      options?.checkpoint ?? 'none',
      String(now),
      options?.callbackState ?? '',
      String(options?.clockAdvance ?? 0),
      options?.mechanism ?? 'oauth',
      options?.selfClientCode ?? '',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  workers++

  let stdout = ''
  let stderr = ''
  let settled = false
  let resolveEvidence: (evidence: WorkerEvidence) => void = () => undefined
  let rejectEvidence: (error: Error) => void = () => undefined
  const evidence = new Promise<WorkerEvidence>((resolve, reject) => {
    resolveEvidence = resolve
    rejectEvidence = reject
  })

  const acceptLine = (line: string): void => {
    if (line.length === 0) return
    try {
      const parsed = parseWorkerEvidence(JSON.parse(line))
      if (parsed === undefined || settled) {
        workerLogEvidence.push(line)
        return
      }
      settled = true
      resolveEvidence(parsed)
      if ('outcome' in parsed && parsed.outcome === 'credentials') {
        // The unwrapped access token is the intended public credential sink. Keep only its
        // process metadata in the log scan; every other exact protocol field remains scanned.
        workerLogEvidence.push({ outcome: parsed.outcome, pid: parsed.pid })
      } else {
        workerLogEvidence.push(line)
      }
      if (
        'outcome' in parsed &&
        (parsed.outcome === 'credential-failure' ||
          parsed.outcome === 'authorization-failure' ||
          parsed.outcome === 'removal-failure')
      ) {
        serializedPublicFailures.push(line)
      }
    } catch {
      workerLogEvidence.push(line)
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline < 0) break
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
      acceptLine(line)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const exit = new Promise<WorkerExit>((resolve) => {
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        rejectEvidence(error)
      }
    })
    child.once('close', (code, signal) => {
      acceptLine(stdout.trim())
      workerLogEvidence.push(stderr)
      owned.delete(child)
      if (!settled) {
        settled = true
        rejectEvidence(
          new Error(
            `Worker exited without evidence (${String(code)}/${String(signal)}): ${stderr.trim()}`,
          ),
        )
      }
      resolve({ code, signal })
    })
  })
  owned.set(child, exit)
  return { child, evidence, exit }
}

async function killWorker(worker: OwnedWorker, checkpoint: ProcessCheckpoint): Promise<void> {
  const evidence = await worker.evidence
  assert.deepEqual(evidence, { checkpoint, pid: worker.child.pid })
  assert.equal(worker.child.kill('SIGKILL'), true)
  assert.deepEqual(await worker.exit, { code: null, signal: 'SIGKILL' })
  sigkills++
}

async function killAt(
  directory: string,
  checkpoint: ProcessCheckpoint,
  now: number,
  options?: {
    readonly action?: WorkerAction
    readonly callbackState?: string
    readonly clockAdvance?: number
    readonly mechanism?: WorkerMechanism
    readonly selfClientCode?: string
  },
): Promise<void> {
  const worker = startWorker(directory, now, { ...options, checkpoint })
  await killWorker(worker, checkpoint)
}

async function finish(
  directory: string,
  now: number,
  options?: {
    readonly action?: WorkerAction
    readonly callbackState?: string
    readonly clockAdvance?: number
    readonly mechanism?: WorkerMechanism
    readonly selfClientCode?: string
  },
): Promise<WorkerEvidence> {
  const worker = startWorker(directory, now, options)
  const evidence = await worker.evidence
  assert.deepEqual(await worker.exit, { code: 0, signal: null })
  return evidence
}

async function fixture(
  name: string,
  options: {
    readonly refreshOutcome?: ProcessRefreshOutcome
    readonly mechanism?: WorkerMechanism
  } = {},
): Promise<string> {
  const directory = join(scratch, name)
  mkdirSync(directory)
  if (options.mechanism === 'client-credentials') {
    await initializeSqliteClientCredentialsProcessFixture(directory, options)
  } else {
    await initializeSqliteProcessFixture(directory, options)
  }
  fixtureDirectories.push(directory)
  return directory
}

function usingStore<Value>(directory: string, use: (store: SqliteProcessStore) => Value): Value {
  const store = new SqliteProcessStore(directory)
  try {
    return use(store)
  } finally {
    store.close()
  }
}

function snapshot(directory: string, key = PROCESS_CONNECTION_KEY) {
  return usingStore(directory, (store) => store.unsafeReadConnection(key))
}

function commandEvents(directory: string): readonly SqliteCommandEvent[] {
  return usingStore(directory, (store) => store.commandEvents())
}

function withoutCredentialEnvelopes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCredentialEnvelopes)
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'credentialEnvelope' && key !== 'pkceVerifierEnvelope')
      .map(([key, entry]) => [key, withoutCredentialEnvelopes(entry)]),
  )
}

function assertSecretCanariesAbsent(...observations: ReadonlyArray<unknown>): void {
  const renderings = observations.flatMap((observation) => {
    const json = JSON.stringify(observation)
    return [json, inspect(observation, { depth: null, getters: false })].filter(
      (rendering): rendering is string => rendering !== undefined,
    )
  })
  for (const canary of PROCESS_SECRET_CANARIES) {
    assert.equal(
      renderings.some((rendering) => rendering.includes(canary.value)),
      false,
      `${canary.label} must not appear in process-loss public or non-envelope evidence`,
    )
  }
}

function assertProcessEvidenceSecretSafe(): void {
  const processMetadata = fixtureDirectories.map((directory) => ({
    directory,
    connection: withoutCredentialEnvelopes(snapshot(directory)),
    commandEvents: withoutCredentialEnvelopes(commandEvents(directory)),
    provider: readSqliteProviderState(directory),
  }))
  assert.ok(serializedPublicFailures.length >= 4, 'Expected serialized public failure evidence')
  assertSecretCanariesAbsent(serializedPublicFailures, workerLogEvidence, processMetadata)
}

function requireOperation(directory: string, key = PROCESS_CONNECTION_KEY): CredentialOperation {
  const operation = snapshot(directory, key)?.credentialOperation
  assert.ok(operation, 'Expected a retained credential operation')
  return operation
}

function assertCredentials(
  evidence: WorkerEvidence,
  accessToken = PROCESS_REFRESHED_ACCESS_TOKEN,
): void {
  assert.deepEqual(evidence, {
    outcome: 'credentials',
    accessToken,
    pid: evidence.pid,
  })
}

function assertCredentialFailure(
  evidence: WorkerEvidence,
  outcome: CredentialOutcomeTag,
  cause?: SafeCredentialCauseTag,
): void {
  assert.deepEqual(evidence, {
    outcome: 'credential-failure',
    failure:
      cause === undefined
        ? { _tag: outcome }
        : {
            _tag: outcome,
            cause: { _tag: cause },
          },
    pid: evidence.pid,
  })
}

function assertAuthorizationFailure(
  evidence: WorkerEvidence,
  reason: Extract<WorkerEvidence, { readonly outcome: 'authorization-failure' }>['reason'],
): void {
  assert.deepEqual(evidence, {
    outcome: 'authorization-failure',
    reason,
    pid: evidence.pid,
  })
}

function assertIntervention(
  evidence: WorkerEvidence,
  cause: 'ProviderOutcomeUnknown' | 'Conflict' = 'ProviderOutcomeUnknown',
): void {
  assertCredentialFailure(evidence, 'InterventionRequired', cause)
}

function assertProviderState(
  directory: string,
  expected: {
    readonly refresh?: number
    readonly authorization?: number
  },
): void {
  assert.deepEqual(readSqliteProviderState(directory), {
    calls: expected.refresh ?? 0,
    processed: expected.refresh ?? 0,
    authorizationCalls: expected.authorization ?? 0,
    authorizationProcessed: expected.authorization ?? 0,
  })
}

async function startReplacement(directory: string, now: number): Promise<string> {
  const evidence = await finish(directory, now, { action: 'start-replacement' })
  assert.equal('outcome' in evidence ? evidence.outcome : undefined, 'authorization-start')
  if (!('outcome' in evidence) || evidence.outcome !== 'authorization-start') {
    throw new Error('Expected replacement authorization preparation')
  }
  assert.ok(evidence.state)
  return evidence.state
}

async function completeReplacement(
  directory: string,
  now: number,
  callbackState: string,
): Promise<WorkerEvidence> {
  return finish(directory, now, { action: 'complete-replacement', callbackState })
}

async function startEnrollment(directory: string, now: number): Promise<string> {
  const evidence = await finish(directory, now, { action: 'start-enrollment' })
  assert.equal('outcome' in evidence ? evidence.outcome : undefined, 'authorization-start')
  if (!('outcome' in evidence) || evidence.outcome !== 'authorization-start') {
    throw new Error('Expected enrollment authorization preparation')
  }
  assert.ok(evidence.state)
  return evidence.state
}

async function completeEnrollment(
  directory: string,
  now: number,
  callbackState: string,
): Promise<WorkerEvidence> {
  return finish(directory, now, { action: 'complete-enrollment', callbackState })
}

async function assertStaleCompletionFenced(
  directory: string,
  dispatchedSnapshot: NonNullable<ReturnType<typeof snapshot>>,
  requestLabel = 'late',
): Promise<void> {
  const operation = dispatchedSnapshot.credentialOperation
  assert.equal(operation?.phase._tag, 'DispatchPossible')
  if (operation?.phase._tag !== 'DispatchPossible') throw new Error('Expected dispatch evidence')

  const credentialEnvelope = dispatchedSnapshot.credentialEnvelope
  if (credentialEnvelope === null) throw new Error('Expected retained authorization')
  const input = {
    _tag: 'CompleteCredentialOperation' as const,
    key: PROCESS_CONNECTION_KEY,
    expectedGeneration: dispatchedSnapshot.generation,
    expectedRevision: dispatchedSnapshot.revision,
    operationId: operation.operationId,
    ownershipFence: operation.phase.ownershipFence,
    credentialEnvelope,
    credentialExpiresAt: null,
    completedAt: PROCESS_INITIAL_TIME,
  }
  const command: CompleteCredentialOperationCommand = {
    ...input,
    request: {
      requestId: `stale-completion-${requestLabel}-${operation.operationId}`,
      inputDigest: await digestStoreInput(input),
    },
  }
  const store = new SqliteProcessStore(directory)
  try {
    const before = await Effect.runPromise(store.readConnection(PROCESS_CONNECTION_KEY))
    const result = await Effect.runPromise(store.executeCredentialOperation(command))
    const after = await Effect.runPromise(store.readConnection(PROCESS_CONNECTION_KEY))
    assert.deepEqual(result, { _tag: 'StoreConflict', reason: 'ConditionChanged' })
    assert.deepEqual(after, before, 'A stale completion must not mutate intervention state')
  } finally {
    store.close()
  }
}

async function assertStaleSelfClientCompletionFenced(
  directory: string,
  dispatchedSnapshot: NonNullable<ReturnType<typeof snapshot>>,
  completedSnapshot: NonNullable<ReturnType<typeof snapshot>>,
): Promise<void> {
  const operation = dispatchedSnapshot.credentialOperation
  if (operation?.kind !== 'self-client-exchange' || operation.phase._tag !== 'DispatchPossible') {
    throw new Error('Expected a possibly dispatched Self Client exchange')
  }
  const credentialEnvelope = completedSnapshot.credentialEnvelope
  if (credentialEnvelope === null) throw new Error('Expected retained Self Client credentials')
  const input = {
    _tag: 'CompleteSelfClientExchange' as const,
    key: PROCESS_SELF_CLIENT_CONNECTION_KEY,
    expectedGeneration: dispatchedSnapshot.generation,
    expectedRevision: dispatchedSnapshot.revision,
    operationId: operation.operationId,
    ownershipFence: operation.phase.ownershipFence,
    credentialEnvelope,
    credentialExpiresAt: null,
    completedAt: PROCESS_INITIAL_TIME,
  }
  const command: CompleteSelfClientExchangeCommand = {
    ...input,
    request: {
      requestId: `stale-self-client-completion-${operation.operationId}`,
      inputDigest: await digestStoreInput(input),
    },
  }
  const store = new SqliteProcessStore(directory)
  try {
    const before = await Effect.runPromise(store.readConnection(PROCESS_SELF_CLIENT_CONNECTION_KEY))
    const result = await Effect.runPromise(store.executeCredentialOperation(command))
    const after = await Effect.runPromise(store.readConnection(PROCESS_SELF_CLIENT_CONNECTION_KEY))
    assert.deepEqual(result, { _tag: 'StoreConflict', reason: 'ConditionChanged' })
    assert.deepEqual(after, before, 'Stale Self Client completion must not alter fresh credentials')
  } finally {
    store.close()
  }
}

async function runMatrix(): Promise<void> {
  {
    const directory = await fixture('pre-dispatch-transfer')
    await killAt(directory, 'pre-dispatch', PROCESS_INITIAL_TIME)
    const original = requireOperation(directory)
    assert.equal(original.phase._tag, 'OwnedBeforeDispatch')
    assert.equal(original.transferCount, 0)
    assert.equal(original.transferLimit, 3)
    assert.equal(original.recoveryDeadline, PROCESS_INITIAL_TIME + 120_000)

    const evidence = await finish(directory, PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE)
    assertCredentials(evidence)
    const acquisitions = commandEvents(directory)
      .filter(({ command }) => command._tag === 'AcquireCredentialOperation')
      .map(({ result }) => {
        assert.equal(result._tag, 'CredentialOperationAcquired')
        if (result._tag !== 'CredentialOperationAcquired') throw new Error('Expected acquisition')
        return result.operation
      })
    assert.equal(acquisitions.length, 2)
    assert.deepEqual(
      acquisitions.map(
        ({ operationId, startedAt, recoveryDeadline, transferCount, transferLimit }) => ({
          operationId,
          startedAt,
          recoveryDeadline,
          transferCount,
          transferLimit,
        }),
      ),
      [
        {
          operationId: original.operationId,
          startedAt: PROCESS_INITIAL_TIME,
          recoveryDeadline: PROCESS_INITIAL_TIME + 120_000,
          transferCount: 0,
          transferLimit: 3,
        },
        {
          operationId: original.operationId,
          startedAt: PROCESS_INITIAL_TIME,
          recoveryDeadline: PROCESS_INITIAL_TIME + 120_000,
          transferCount: 1,
          transferLimit: 3,
        },
      ],
    )
    assertProviderState(directory, { refresh: 1 })
    console.log('PASS pre-dispatch: fresh worker transferred ownership with fixed limits')
  }

  {
    const directory = await fixture('dispatch-possible')
    await killAt(directory, 'dispatch-possible', PROCESS_INITIAL_TIME)
    const dispatched = snapshot(directory)
    assert.equal(dispatched?.credentialOperation?.phase._tag, 'DispatchPossible')
    assertProviderState(directory, {})

    const evidence = await finish(directory, PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE)
    assertIntervention(evidence)
    assert.equal(requireOperation(directory).phase._tag, 'InterventionRequired')
    assert.equal(
      commandEvents(directory).filter(
        ({ command }) => command._tag === 'AcquireCredentialOperation',
      ).length,
      1,
      'Dispatch evidence must forbid ownership transfer',
    )
    assertProviderState(directory, {})
    if (dispatched === null) throw new Error('Expected dispatched snapshot')
    await assertStaleCompletionFenced(directory, dispatched)
    console.log(
      'PASS dispatch-possible: InterventionRequired/ProviderOutcomeUnknown without transfer or replay',
    )
  }

  {
    const directory = await fixture('response-received')
    await killAt(directory, 'response-received', PROCESS_INITIAL_TIME)
    const dispatched = snapshot(directory)
    assert.equal(dispatched?.credentialOperation?.phase._tag, 'DispatchPossible')
    assertProviderState(directory, { refresh: 1 })

    const evidence = await finish(directory, PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE)
    assertIntervention(evidence)
    assert.equal(
      commandEvents(directory).filter(
        ({ command }) => command._tag === 'AcquireCredentialOperation',
      ).length,
      1,
      'A received response must forbid ownership transfer',
    )
    assertProviderState(directory, { refresh: 1 })
    if (dispatched === null) throw new Error('Expected dispatched snapshot')
    await assertStaleCompletionFenced(directory, dispatched)
    console.log('PASS response-received: intervention retained the single provider effect')
  }

  {
    const directory = await fixture('completion-acknowledgement')
    await killAt(directory, 'completion-acknowledgement', PROCESS_INITIAL_TIME)
    const committed = snapshot(directory)
    assert.ok(committed)
    assert.equal(committed.credentialOperation, null)
    assertProviderState(directory, { refresh: 1 })

    const completionEvent = commandEvents(directory).findLast(
      ({ command }) => command._tag === 'CompleteCredentialOperation',
    )
    assert.ok(completionEvent)
    assert.equal(completionEvent.command._tag, 'CompleteCredentialOperation')
    if (completionEvent.command._tag !== 'CompleteCredentialOperation') {
      throw new Error('Expected completion command evidence')
    }
    const store = new SqliteProcessStore(directory)
    try {
      const replayed = await Effect.runPromise(
        store.executeCredentialOperation(completionEvent.command),
      )
      assert.deepEqual(replayed, completionEvent.result)
      assert.deepEqual(
        await Effect.runPromise(store.readConnection(PROCESS_CONNECTION_KEY)),
        committed,
      )
    } finally {
      store.close()
    }

    assertCredentials(await finish(directory, PROCESS_INITIAL_TIME))
    assertProviderState(directory, { refresh: 1 })
    console.log('PASS completion-acknowledgement: committed result and receipt recovered')
  }

  {
    const directory = await fixture('known-provider-rejection', {
      refreshOutcome: 'provider-rejected',
    })
    assertCredentialFailure(await finish(directory, PROCESS_INITIAL_TIME), 'AuthorizationRequired')
    const knownFailure = requireOperation(directory)
    assert.deepEqual(knownFailure.phase, {
      _tag: 'KnownFailure',
      reason: 'ProviderRejected',
      failedAt: PROCESS_INITIAL_TIME,
    })
    assertProviderState(directory, { refresh: 1 })

    assertCredentialFailure(await finish(directory, PROCESS_INITIAL_TIME), 'AuthorizationRequired')
    assert.deepEqual(requireOperation(directory), knownFailure)
    assertProviderState(directory, { refresh: 1 })
    console.log('PASS known provider rejection: AuthorizationRequired without replay')
  }

  {
    const directory = await fixture('pre-dispatch-budget')
    for (let owner = 0; owner <= 3; owner++) {
      await killAt(
        directory,
        'pre-dispatch',
        PROCESS_INITIAL_TIME + owner * PROCESS_OWNERSHIP_LEASE,
      )
      const retained = requireOperation(directory)
      assert.equal(retained.startedAt, PROCESS_INITIAL_TIME)
      assert.equal(retained.recoveryDeadline, PROCESS_INITIAL_TIME + 120_000)
      assert.equal(retained.transferCount, owner)
      assert.equal(retained.transferLimit, 3)
    }

    assertIntervention(await finish(directory, PROCESS_INITIAL_TIME + 120_000), 'Conflict')
    const exhausted = requireOperation(directory)
    assert.equal(exhausted.transferCount, 3)
    assert.deepEqual(exhausted.phase, {
      _tag: 'InterventionRequired',
      reason: 'RecoveryLimitExceeded',
      markedAt: PROCESS_INITIAL_TIME + 120_000,
    })
    assertProviderState(directory, {})
    console.log('PASS pre-dispatch budget: deadline and three-transfer limit stayed fixed')
  }

  {
    const directory = await fixture('superseded-replacement-callback')
    const staleState = await startReplacement(directory, PROCESS_INITIAL_TIME)
    const winningState = await startReplacement(directory, PROCESS_INITIAL_TIME)

    const completed = await completeReplacement(directory, PROCESS_INITIAL_TIME, winningState)
    assert.deepEqual(completed, {
      outcome: 'authorization-completed',
      connectionId: PROCESS_CONNECTION_KEY.connectionId,
      pid: completed.pid,
    })
    const replacement = snapshot(directory)
    assert.ok(replacement)
    assert.equal(replacement.generation, 1)
    assert.equal(replacement.credentialOperation, null)
    assertProviderState(directory, { authorization: 1 })
    assertCredentials(
      await finish(directory, PROCESS_INITIAL_TIME),
      PROCESS_REPLACEMENT_ACCESS_TOKEN,
    )

    assertAuthorizationFailure(
      await completeReplacement(directory, PROCESS_INITIAL_TIME, staleState),
      'InvalidAttempt',
    )
    assert.deepEqual(snapshot(directory), replacement)
    assertProviderState(directory, { authorization: 1 })
    assert.equal(
      commandEvents(directory).filter(
        ({ command }) => command._tag === 'CompleteAuthorizationAttempt',
      ).length,
      1,
      'Only the winning replacement may complete',
    )
    console.log('PASS stale replacement callback: no dispatch or replacement overwrite')
  }

  {
    const directory = await fixture('replacement-during-unresolved-refresh')
    const replacementState = await startReplacement(directory, PROCESS_INITIAL_TIME)
    const refresh = startWorker(directory, PROCESS_INITIAL_TIME, {
      checkpoint: 'dispatch-possible',
    })
    const checkpoint = await refresh.evidence
    assert.deepEqual(checkpoint, {
      checkpoint: 'dispatch-possible',
      pid: refresh.child.pid,
    })
    const unresolved = snapshot(directory)
    assert.equal(unresolved?.credentialOperation?.kind, 'refresh')
    assert.equal(unresolved?.credentialOperation?.phase._tag, 'DispatchPossible')
    assert.equal(unresolved?.credentialOperation?.startedAt, PROCESS_INITIAL_TIME)
    assert.equal(unresolved?.credentialOperation?.recoveryDeadline, PROCESS_INITIAL_TIME + 120_000)

    assertCredentialFailure(
      await finish(directory, PROCESS_INITIAL_TIME, {
        clockAdvance: PROCESS_CREDENTIAL_FOLLOWER_WAIT,
      }),
      'TemporarilyUnavailable',
    )
    assertAuthorizationFailure(
      await completeReplacement(directory, PROCESS_INITIAL_TIME, replacementState),
      'Pending',
    )
    assert.deepEqual(snapshot(directory), unresolved)
    assertProviderState(directory, {})
    const rejectedAdmission = commandEvents(directory).findLast(
      ({ command }) => command._tag === 'AdmitAuthorizationAttempt',
    )
    assert.deepEqual(rejectedAdmission?.result, {
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })

    await killWorker(refresh, 'dispatch-possible')
    assertIntervention(await finish(directory, PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE))
    assertProviderState(directory, {})
    console.log('PASS unresolved refresh: TemporarilyUnavailable; admission did not overlap')
  }

  {
    const directory = await fixture('unknown-replacement-outcome')
    const replacementState = await startReplacement(directory, PROCESS_INITIAL_TIME)
    await killAt(directory, 'replacement-response-received', PROCESS_INITIAL_TIME, {
      action: 'complete-replacement',
      callbackState: replacementState,
    })
    const dispatched = requireOperation(directory)
    assert.equal(dispatched.kind, 'authorization-exchange')
    assert.equal(dispatched.phase._tag, 'DispatchPossible')
    assert.equal(dispatched.startedAt, PROCESS_INITIAL_TIME)
    assert.equal(dispatched.recoveryDeadline, PROCESS_INITIAL_TIME + 120_000)
    assert.equal(dispatched.transferCount, 0)
    assert.equal(dispatched.transferLimit, 3)
    assertProviderState(directory, { authorization: 1 })

    assertIntervention(await finish(directory, PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE))
    const intervention = requireOperation(directory)
    assert.deepEqual(intervention.phase, {
      _tag: 'InterventionRequired',
      reason: 'DispatchOwnerExpired',
      markedAt: PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE,
    })
    assert.equal(intervention.startedAt, PROCESS_INITIAL_TIME)
    assert.equal(intervention.recoveryDeadline, PROCESS_INITIAL_TIME + 120_000)

    const expiredAt = PROCESS_INITIAL_TIME + 10 * 60_000
    assertAuthorizationFailure(
      await completeReplacement(directory, expiredAt, replacementState),
      'InvalidAttempt',
    )
    assertIntervention(await finish(directory, expiredAt))
    assert.deepEqual(requireOperation(directory), intervention)
    assertProviderState(directory, { authorization: 1 })
    assert.equal(
      commandEvents(directory).filter(({ command }) => command._tag === 'AdmitAuthorizationAttempt')
        .length,
      1,
      'Worker loss and expiry must not readmit the replacement callback',
    )
    assert.equal(
      commandEvents(directory).filter(
        ({ command }) => command._tag === 'CompleteAuthorizationAttempt',
      ).length,
      0,
      'An unknown replacement outcome must not be persisted as completed',
    )
    console.log('PASS unknown replacement: intervention survived worker loss and expiry; no replay')
  }

  {
    const directory = await fixture('removal-worker-loss-reenrollment')
    const staleCallback = await startReplacement(directory, PROCESS_INITIAL_TIME)
    const refresh = startWorker(directory, PROCESS_INITIAL_TIME, {
      checkpoint: 'response-received',
    })
    await killWorker(refresh, 'response-received')
    const dispatched = snapshot(directory)
    assert.ok(dispatched)
    assert.equal(dispatched.credentialOperation?.kind, 'refresh')
    assert.equal(dispatched.credentialOperation?.phase._tag, 'DispatchPossible')
    assertProviderState(directory, { refresh: 1 })

    await killAt(directory, 'removal-acknowledgement', PROCESS_INITIAL_TIME, {
      action: 'remove',
    })
    const removed = snapshot(directory)
    assert.ok(removed)
    assert.equal(removed.generation, 1)
    assert.deepEqual(removed.authorization, { _tag: 'NotAuthorized' })
    assert.equal(removed.credentialEnvelope, null)
    assert.equal(removed.credentialOperation, null)
    assertProviderState(directory, { refresh: 1 })
    await assertStaleCompletionFenced(directory, dispatched, 'after-removal')
    assertCredentialFailure(await finish(directory, PROCESS_INITIAL_TIME), 'AuthorizationRequired')

    const removalEvent = commandEvents(directory).findLast(
      ({ command }) => command._tag === 'RemoveConnection',
    )
    assert.ok(removalEvent)
    assert.equal(removalEvent.command._tag, 'RemoveConnection')
    if (removalEvent.command._tag !== 'RemoveConnection') {
      throw new Error('Expected retained removal command evidence')
    }
    assert.deepEqual(removalEvent.result, {
      _tag: 'ConnectionRemoved',
      generation: removed.generation,
      revision: removed.revision,
    })

    const enrollmentState = await startEnrollment(directory, PROCESS_INITIAL_TIME)
    const enrolled = await completeEnrollment(directory, PROCESS_INITIAL_TIME, enrollmentState)
    assert.deepEqual(enrolled, {
      outcome: 'authorization-completed',
      connectionId: PROCESS_CONNECTION_KEY.connectionId,
      pid: enrolled.pid,
    })
    assertCredentials(
      await finish(directory, PROCESS_INITIAL_TIME),
      PROCESS_REENROLLED_ACCESS_TOKEN,
    )
    const reenrolled = snapshot(directory)
    assert.ok(reenrolled)
    assert.equal(reenrolled.generation, removed.generation)
    assert.deepEqual(reenrolled.authorization, {
      _tag: 'Authorized',
      credentialExpiresAt: null,
      credentialAcquiredAt: null,
    })
    assert.equal(reenrolled.credentialOperation, null)
    assertProviderState(directory, { refresh: 1, authorization: 1 })

    assertAuthorizationFailure(
      await completeReplacement(directory, PROCESS_INITIAL_TIME, staleCallback),
      'InvalidAttempt',
    )
    const store = new SqliteProcessStore(directory)
    try {
      const removalReplay = await Effect.runPromise(
        store.executeCredentialOperation(removalEvent.command),
      )
      assert.deepEqual(removalReplay, { _tag: 'StoreConflict', reason: 'ConditionChanged' })
      assert.deepEqual(
        await Effect.runPromise(store.readConnection(PROCESS_CONNECTION_KEY)),
        reenrolled,
        'An old removal retry must not delete deliberate later enrollment',
      )
    } finally {
      store.close()
    }
    await assertStaleCompletionFenced(directory, dispatched, 'after-reenrollment')
    assert.deepEqual(snapshot(directory), reenrolled)
    assertProviderState(directory, { refresh: 1, authorization: 1 })
    console.log(
      'PASS removal worker loss: AuthorizationRequired before reenrollment; stale work remained fenced',
    )
  }

  {
    const mechanism = 'client-credentials' as const
    const directory = await fixture('client-pre-dispatch-transfer', { mechanism })
    await killAt(directory, 'pre-dispatch', PROCESS_INITIAL_TIME, { mechanism })
    const original = requireOperation(directory, PROCESS_CLIENT_CONNECTION_KEY)
    assert.equal(original.kind, 'client-credentials-acquisition')
    assert.equal(original.phase._tag, 'OwnedBeforeDispatch')
    assertCredentials(
      await finish(directory, PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE, { mechanism }),
      PROCESS_CLIENT_ACCESS_TOKEN,
    )
    assertProviderState(directory, { refresh: 1 })

    const dispatchDirectory = await fixture('client-dispatch-possible', { mechanism })
    await killAt(dispatchDirectory, 'dispatch-possible', PROCESS_INITIAL_TIME, { mechanism })
    assert.equal(
      requireOperation(dispatchDirectory, PROCESS_CLIENT_CONNECTION_KEY).phase._tag,
      'DispatchPossible',
    )
    assertIntervention(
      await finish(dispatchDirectory, PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE, {
        mechanism,
      }),
    )
    assertProviderState(dispatchDirectory, {})

    const responseDirectory = await fixture('client-response-received', { mechanism })
    await killAt(responseDirectory, 'response-received', PROCESS_INITIAL_TIME, { mechanism })
    assertIntervention(
      await finish(responseDirectory, PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE, {
        mechanism,
      }),
    )
    assertProviderState(responseDirectory, { refresh: 1 })

    const acknowledgementDirectory = await fixture('client-completion-acknowledgement', {
      mechanism,
    })
    await killAt(acknowledgementDirectory, 'completion-acknowledgement', PROCESS_INITIAL_TIME, {
      mechanism,
    })
    assert.equal(
      snapshot(acknowledgementDirectory, PROCESS_CLIENT_CONNECTION_KEY)?.credentialOperation,
      null,
    )
    assertCredentials(
      await finish(acknowledgementDirectory, PROCESS_INITIAL_TIME, { mechanism }),
      PROCESS_CLIENT_ACCESS_TOKEN,
    )
    assertProviderState(acknowledgementDirectory, { refresh: 1 })

    const rejectedDirectory = await fixture('client-known-provider-rejection', {
      mechanism,
      refreshOutcome: 'provider-rejected',
    })
    assertCredentialFailure(
      await finish(rejectedDirectory, PROCESS_INITIAL_TIME, { mechanism }),
      'AuthorizationRequired',
    )
    assertCredentialFailure(
      await finish(rejectedDirectory, PROCESS_INITIAL_TIME, { mechanism }),
      'AuthorizationRequired',
    )
    assertProviderState(rejectedDirectory, { refresh: 1 })
    assert.equal(
      requireOperation(rejectedDirectory, PROCESS_CLIENT_CONNECTION_KEY).kind,
      'client-credentials-acquisition',
    )
    console.log(
      'PASS client credentials process loss: transfer, no replay, receipt recovery, rejection',
    )
  }

  {
    const directory = await fixture('self-client-fresh-code-supersedes-uncertain')
    await killAt(directory, 'self-client-response-received', PROCESS_INITIAL_TIME, {
      action: 'enroll-code',
      mechanism: 'self-client',
      selfClientCode: PROCESS_SELF_CLIENT_UNCERTAIN_CODE,
    })
    const dispatched = snapshot(directory, PROCESS_SELF_CLIENT_CONNECTION_KEY)
    assert.ok(dispatched)
    assert.equal(dispatched.credentialOperation?.kind, 'self-client-exchange')
    assert.equal(dispatched.credentialOperation?.phase._tag, 'DispatchPossible')
    assertProviderState(directory, { authorization: 1 })

    const recoveryTime = PROCESS_INITIAL_TIME + PROCESS_OWNERSHIP_LEASE
    assertIntervention(await finish(directory, recoveryTime, { mechanism: 'self-client' }))
    const intervention = snapshot(directory, PROCESS_SELF_CLIENT_CONNECTION_KEY)
    assert.equal(intervention?.credentialOperation?.phase._tag, 'InterventionRequired')
    assertProviderState(directory, { authorization: 1 })

    const freshApproval = await finish(directory, recoveryTime, {
      action: 'enroll-code',
      mechanism: 'self-client',
      selfClientCode: PROCESS_SELF_CLIENT_FRESH_CODE,
    })
    assert.deepEqual(freshApproval, {
      outcome: 'self-client-enrolled',
      approved: true,
      pid: freshApproval.pid,
    })
    const completed = snapshot(directory, PROCESS_SELF_CLIENT_CONNECTION_KEY)
    assert.ok(completed)
    assert.equal(completed.authorization._tag, 'Authorized')
    assert.equal(completed.credentialOperation, null)
    assertCredentials(
      await finish(directory, recoveryTime, { mechanism: 'self-client' }),
      PROCESS_SELF_CLIENT_FRESH_ACCESS_TOKEN,
    )
    assertProviderState(directory, { authorization: 2 })
    await assertStaleSelfClientCompletionFenced(directory, dispatched, completed)
    assertProviderState(directory, { authorization: 2 })

    const events = commandEvents(directory)
    assert.equal(
      events.filter(({ command }) => command._tag === 'AdmitSelfClientExchange').length,
      2,
      'Only the uncertain and explicitly approved fresh codes may be admitted',
    )
    assert.equal(
      events.filter(
        ({ command, result }) =>
          command._tag === 'CompleteSelfClientExchange' &&
          result._tag === 'SelfClientExchangeCompleted',
      ).length,
      1,
      'The stale completion must not commit over the fresh enrollment',
    )
    console.log(
      'PASS Self Client response loss: dispatch evidence required intervention; approved fresh code superseded it and fenced stale completion',
    )
  }

  {
    const directory = await fixture('self-client-completion-acknowledgement')
    await killAt(directory, 'completion-acknowledgement', PROCESS_INITIAL_TIME, {
      action: 'enroll-code',
      mechanism: 'self-client',
      selfClientCode: PROCESS_SELF_CLIENT_ACK_CODE,
    })
    const completed = snapshot(directory, PROCESS_SELF_CLIENT_CONNECTION_KEY)
    assert.ok(completed)
    assert.equal(completed.authorization._tag, 'Authorized')
    assert.equal(completed.credentialOperation, null)
    assertProviderState(directory, { authorization: 1 })

    const completionEvent = commandEvents(directory).findLast(
      ({ command }) => command._tag === 'CompleteSelfClientExchange',
    )
    assert.ok(completionEvent)
    assert.equal(completionEvent.command._tag, 'CompleteSelfClientExchange')
    if (completionEvent.command._tag !== 'CompleteSelfClientExchange') {
      throw new Error('Expected retained Self Client completion command evidence')
    }
    const store = new SqliteProcessStore(directory)
    try {
      const replayed = await Effect.runPromise(
        store.executeCredentialOperation(completionEvent.command),
      )
      assert.deepEqual(replayed, completionEvent.result)
      assert.deepEqual(
        await Effect.runPromise(store.readConnection(PROCESS_SELF_CLIENT_CONNECTION_KEY)),
        completed,
      )
    } finally {
      store.close()
    }

    assertCredentials(
      await finish(directory, PROCESS_INITIAL_TIME, { mechanism: 'self-client' }),
      PROCESS_SELF_CLIENT_ACK_ACCESS_TOKEN,
    )
    assertProviderState(directory, { authorization: 1 })
    console.log(
      'PASS Self Client completion acknowledgement loss: saved receipt recovered without exchange replay',
    )
  }

  assertProcessEvidenceSecretSafe()
  console.log('PASS secret safety: serialized failures and non-envelope process evidence are clean')
  console.log(
    `ALL PROCESS-LOSS CHECKS PASSED (${sigkills} SIGKILLs; ${workers} OS workers; Bun SQLite; unchanged production workflow).`,
  )
}

let failure: unknown
try {
  await runMatrix()
} catch (error) {
  failure = error
} finally {
  clearTimeout(watchdog)
  for (const { signal, handler } of signalHandlers) process.off(signal, handler)
  await cleanup()
}
if (failure !== undefined) throw failure
