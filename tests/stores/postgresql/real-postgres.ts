import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect, Redacted } from 'effect'
import pg from 'pg'
import { AesGcm } from '../../../src/encryptors/aes-gcm/index.js'
import {
  digestStoreInput,
  type AuthorizationAdmission,
  type ConnectionKey,
  type StoreCommandInput,
} from '../../../src/stores/index.js'
import {
  PostgreSQL,
  type PostgreSQLClient,
  type PostgreSQLParameter,
  type PostgreSQLPool,
  type PostgreSQLQueryResult,
} from '../../../src/stores/postgresql/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.log('SKIPPED REAL POSTGRESQL CHECK (DATABASE_URL is not set)')
  process.exit(0)
}

const { Pool } = pg
const pool = new Pool({ connectionString: databaseUrl, max: 4 })
const schema = `connections_pg_${crypto.randomUUID().replaceAll('-', '')}`
const encryptor = AesGcm.encryptor({
  key: Effect.succeed(Redacted.make('KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=')),
  keyId: 'real-postgresql-check',
})

async function withRequest<Command extends StoreCommandInput>(
  command: Command,
  requestId: string,
): Promise<
  Command & { readonly request: { readonly requestId: string; readonly inputDigest: string } }
> {
  return {
    ...command,
    request: { requestId, inputDigest: await digestStoreInput(command) },
  }
}

function admissionCommand(admission: AuthorizationAdmission, owner: string) {
  return {
    _tag: 'AdmitAuthorizationAttempt' as const,
    admission,
    ownershipFence: `fence:${owner}`,
    leaseExpiresAt: 3_000,
    operation: {
      operationId: `operation:${owner}`,
      kind: 'authorization-exchange' as const,
      startedAt: admission.admittedAt,
      recoveryDeadline: 10_000,
      transferLimit: 3,
    },
  }
}

interface QueryEvent {
  readonly client: number
  readonly phase: 'start' | 'end'
  readonly sql: string
}

let releaseOwner: () => void = () => undefined
const ownerRelease = new Promise<void>((resolve) => (releaseOwner = resolve))
let markOwnerReached: () => void = () => undefined
const ownerReached = new Promise<void>((resolve) => (markOwnerReached = resolve))
const events: QueryEvent[] = []
const lockCounts = new Map<number, number>()
let gateLocks = false
let nextClient = 0
let ownerClient: number | null = null
let acquired = 0
let released = 0
let runningCommands: readonly Promise<unknown>[] = []

const trackedPool: PostgreSQLPool = {
  connect: async () => {
    const client = await pool.connect()
    const id = ++nextClient
    acquired++
    let didRelease = false
    return {
      query: async (
        sql: string,
        parameters?: PostgreSQLParameter[],
      ): Promise<PostgreSQLQueryResult> => {
        events.push({ client: id, phase: 'start', sql })
        const result = await client.query(sql, parameters)
        events.push({ client: id, phase: 'end', sql })
        if (gateLocks && sql.includes('pg_advisory_xact_lock')) {
          const count = (lockCounts.get(id) ?? 0) + 1
          lockCounts.set(id, count)
          if (count === 2 && ownerClient === null) {
            ownerClient = id
            markOwnerReached()
            await ownerRelease
          }
        }
        return result
      },
      release: (destroy?: boolean) => {
        assert.equal(didRelease, false, 'PostgreSQL client was released twice')
        didRelease = true
        released++
        client.release(destroy)
      },
    } satisfies PostgreSQLClient
  },
}

try {
  await pool.query(`CREATE SCHEMA "${schema}"`)

  const firstBackend = await pool.connect()
  const secondBackend = await pool.connect()
  try {
    const firstPid = (await firstBackend.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid
    const secondPid = (await secondBackend.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid
    assert.notEqual(firstPid, secondPid, 'The real-PostgreSQL check requires independent backends')
  } finally {
    firstBackend.release()
    secondBackend.release()
  }

  const store = PostgreSQL.store({ pool: trackedPool, encryptor, schema })
  const key: ConnectionKey = {
    namespace: 'real-postgresql-advisory-lock',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const attempt = {
    schemaVersion: 1 as const,
    stateDigest: 'state:real-postgresql-advisory-lock',
    key,
    generation: 0,
    intent: 'enroll' as const,
    bindingDigest: 'binding:real-postgresql-advisory-lock',
    pkceVerifierEnvelope: {
      version: 1 as const,
      algorithm: 'AES-256-GCM' as const,
      keyId: 'test',
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
    createdAt: 1_000,
    expiresAt: 10_000,
  }
  await Effect.runPromise(store.readConnection(key))
  await Effect.runPromise(
    store.execute(
      await withRequest(
        { _tag: 'CreateAuthorizationAttempt' as const, attempt },
        'real-postgresql:create',
      ),
    ),
  )

  events.length = 0
  lockCounts.clear()
  gateLocks = true
  const admission = {
    stateDigest: attempt.stateDigest,
    key,
    intent: 'enroll' as const,
    generation: 0,
    admissionId: 'real-postgresql:admission',
    admittedAt: 1_500,
    admissionExpiresAt: 9_000,
  }
  const firstCommand = await withRequest(
    admissionCommand(admission, 'first'),
    'real-postgresql:admit:first',
  )
  const secondCommand = await withRequest(
    admissionCommand(admission, 'second'),
    'real-postgresql:admit:second',
  )

  const first = Effect.runPromise(store.execute(firstCommand))
  await ownerReached
  let secondSettled = false
  const second = Effect.runPromise(store.execute(secondCommand)).finally(() => {
    secondSettled = true
  })
  runningCommands = [first, second]
  await delay(150)

  assert.equal(secondSettled, false, 'The competing transaction did not wait for the held lock')
  const competingClient = Math.max(...events.map(({ client }) => client))
  const competingLockStarts = events.filter(
    ({ client, phase, sql }) =>
      client === competingClient && phase === 'start' && sql.includes('pg_advisory_xact_lock'),
  )
  const competingLockEnds = events.filter(
    ({ client, phase, sql }) =>
      client === competingClient && phase === 'end' && sql.includes('pg_advisory_xact_lock'),
  )
  assert.equal(competingLockStarts.length, 2, 'The competitor did not request locks in fixed order')
  assert.equal(competingLockEnds.length, 1, 'The connection-identity advisory lock did not block')

  releaseOwner()
  const results = await Promise.all([first, second])
  assert.equal(
    results.filter(({ _tag }) => _tag === 'AuthorizationAttemptAdmitted').length,
    1,
    'Exactly one admission must win',
  )
  assert.deepEqual(
    results.filter(({ _tag }) => _tag === 'StoreConflict'),
    [{ _tag: 'StoreConflict', reason: 'ConditionChanged' }],
  )
  assert.equal(released, acquired, 'Every acquired PostgreSQL client must be released')

  console.log(
    'REAL POSTGRESQL CHECK PASSED (independent backends; blocking advisory lock; one winner; client release)',
  )
} finally {
  releaseOwner()
  await Promise.allSettled(runningCommands)
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await pool.end()
  }
}
