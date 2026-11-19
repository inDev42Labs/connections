import { inspect } from 'node:util'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { Connections, revealSecret } from '../../../src/index.js'
import { ApiKey } from '../../../src/providers/api-key/index.js'
import {
  digestStoreInput,
  type CredentialOperationCommandInput,
} from '../../../src/stores/index.js'
import { makePersistedSQLite } from '../../fixtures/persisted-sqlite.js'

async function command<Input extends CredentialOperationCommandInput>(
  input: Input,
  requestId: string,
) {
  return { ...input, request: { requestId, inputDigest: await digestStoreInput(input) } }
}

function failedOperation(
  recovery?: unknown,
  reason = 'ProviderFailure',
  kind = 'refresh',
  replayUntil?: unknown,
) {
  return {
    schemaVersion: 1,
    operationId: 'historical-operation',
    kind,
    generation: 0,
    observedRevision: 1,
    startedAt: 1_000,
    recoveryDeadline: 2_000,
    transferCount: 0,
    transferLimit: 1,
    ...(replayUntil === undefined ? {} : { replayUntil }),
    phase: {
      _tag: 'KnownFailure',
      reason,
      failedAt: 1_100,
      ...(recovery === undefined ? {} : { recovery }),
    },
  }
}

function acquisition(fixture: Awaited<ReturnType<typeof makePersistedSQLite>>, now: number) {
  return {
    _tag: 'AcquireCredentialOperation' as const,
    key: fixture.key,
    expectedGeneration: 0,
    expectedRevision: 4,
    ownershipFence: 'new-owner',
    acquiredAt: now,
    leaseExpiresAt: now + 100,
    proposal: {
      operationId: 'new-operation',
      kind: 'refresh' as const,
      startedAt: now,
      recoveryDeadline: now + 1_000,
      transferLimit: 1,
    },
  }
}

async function expectCorruptRecordRejected(record: Record<string, unknown>) {
  const fixture = await makePersistedSQLite()
  const canary = '__persisted_record_secret_canary__'
  fixture.seedConnection({ ...fixture.authorizedRecord, ...record, diagnostic: canary })
  fixture.reopen()
  const manager = Connections.create({
    provider: ApiKey.opaque({ id: fixture.key.providerId }),
    store: fixture.store,
  })
  const readFailure = await manager
    .credentials(fixture.key.connectionId)
    .catch((error: unknown) => error)
  expect(readFailure).toMatchObject({
    _tag: 'TemporarilyUnavailable',
    cause: { _tag: 'StorageFailure' },
  })
  const mutation = await command(
    {
      _tag: 'RemoveConnection',
      key: fixture.key,
      expectedGeneration: 0,
      expectedRevision: 4,
      removedAt: 3_000,
    },
    'remove-corrupt',
  )
  const mutationFailure = await Effect.runPromise(
    Effect.flip(fixture.store.executeCredentialOperation(mutation)),
  )
  expect(mutationFailure).toMatchObject({ _tag: 'SQLiteStorageFailure', operation: 'execute' })
  const inspectionFailure = await Effect.runPromise(
    Effect.flip(fixture.store.inspectConnection(fixture.key)),
  )
  expect(inspectionFailure).toMatchObject({ _tag: 'SQLiteStorageFailure', operation: 'inspect' })
  expect(
    [
      JSON.stringify(readFailure),
      inspect(readFailure),
      JSON.stringify(mutationFailure),
      inspect(mutationFailure),
      JSON.stringify(inspectionFailure),
    ].join('\n'),
  ).not.toContain(canary)
}

describe('persisted credential compatibility through SQLite', () => {
  test('reads credentials saved before acquisition metadata existed after reopening the database', async () => {
    const fixture = await makePersistedSQLite()
    fixture.seedConnection(fixture.authorizedRecord)
    fixture.reopen()
    const manager = Connections.create({
      provider: ApiKey.opaque({ id: fixture.key.providerId }),
      store: fixture.store,
    })

    expect(revealSecret((await manager.credentials(fixture.key.connectionId)).apiKey)).toBe(
      'saved-key',
    )
    expect(await manager.inspect(fixture.key.connectionId)).toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
  })

  test.each([
    ['retains legacy failures without inventing no-dispatch evidence', undefined, 'StoreConflict'],
    [
      'permits one recovery owner after a failure proven to precede dispatch',
      'NotDispatched',
      'CredentialOperationAcquired',
    ],
  ] as const)('%s after reopening', async (_name, recovery, expected) => {
    const fixture = await makePersistedSQLite()
    fixture.seedConnection({
      ...fixture.authorizedRecord,
      authorization: { _tag: 'Authorized', credentialExpiresAt: 0 },
      credentialOperation: failedOperation(recovery),
    })
    fixture.reopen()
    const result = await Effect.runPromise(
      fixture.store.executeCredentialOperation(
        await command(acquisition(fixture, 200_000), 'recover'),
      ),
    )
    expect(result._tag).toBe(expected)
    // A competing owner still observing the old record cannot acquire it.
    const competitor = await Effect.runPromise(
      fixture.store.executeCredentialOperation(
        await command(acquisition(fixture, 200_000), 'compete'),
      ),
    )
    expect(competitor).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
  })

  test.each([
    ['before the saved retry time', 1_199, 'StoreConflict'],
    ['at the saved retry time', 1_200, 'CredentialOperationAcquired'],
    ['within the saved replay window', 4_999, 'CredentialOperationAcquired'],
    ['at the replay window expiry', 5_000, 'StoreConflict'],
  ] as const)('permits bounded recovery only %s after reopening', async (_name, now, expected) => {
    const fixture = await makePersistedSQLite()
    fixture.seedConnection({
      ...fixture.authorizedRecord,
      authorization: { _tag: 'Authorized', credentialExpiresAt: 0 },
      credentialOperation: failedOperation(
        { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 },
        'ProviderFailure',
        'refresh',
        5_000,
      ),
    })
    fixture.reopen()

    const result = await Effect.runPromise(
      fixture.store.executeCredentialOperation(await command(acquisition(fixture, now), 'recover')),
    )
    expect(result._tag).toBe(expected)
  })

  test.each([
    [
      'missing replay window',
      { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 },
      undefined,
      'ProviderFailure',
      'refresh',
    ],
    [
      'mismatched replay window',
      { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 },
      6_000,
      'ProviderFailure',
      'refresh',
    ],
    [
      'retry after expiry',
      { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 6_000 },
      5_000,
      'ProviderFailure',
      'refresh',
    ],
    [
      'window predating failure',
      { _tag: 'ReplaySafe', retryUntil: 1_000, retryAt: 1_000 },
      1_000,
      'ProviderFailure',
      'refresh',
    ],
    [
      'negative retry time',
      { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: -1 },
      5_000,
      'ProviderFailure',
      'refresh',
    ],
    [
      'invalid window time',
      { _tag: 'ReplaySafe', retryUntil: null, retryAt: 1_200 },
      5_000,
      'ProviderFailure',
      'refresh',
    ],
    [
      'replay evidence on rejection',
      { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 },
      5_000,
      'ProviderRejected',
      'refresh',
    ],
    [
      'replay evidence on client credentials',
      { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 },
      5_000,
      'ProviderFailure',
      'client-credentials-acquisition',
    ],
    ['unstructured replay evidence', 'ReplaySafe', undefined, 'ProviderFailure', 'refresh'],
    ['boolean recovery evidence', true, undefined, 'ProviderFailure', 'refresh'],
    [
      'no-dispatch evidence on rejection',
      'NotDispatched',
      undefined,
      'ProviderRejected',
      'refresh',
    ],
    [
      'no-dispatch evidence on a code exchange',
      'NotDispatched',
      undefined,
      'ProviderFailure',
      'authorization-exchange',
    ],
  ] as const)(
    'fails safely instead of recovering corrupt saved evidence: %s',
    async (_name, recovery, replayUntil, reason, kind) => {
      expect.hasAssertions()
      await expectCorruptRecordRejected({
        credentialOperation: failedOperation(recovery, reason, kind, replayUntil),
      })
    },
  )

  test('rejects invalid saved acquisition times without returning or modifying credentials', async () => {
    expect.hasAssertions()
    await expectCorruptRecordRejected({
      authorization: {
        _tag: 'Authorized',
        credentialExpiresAt: null,
        credentialAcquiredAt: 'not-a-time',
      },
    })
  })

  test('resumes saved client-credentials ownership after its lease expires', async () => {
    const fixture = await makePersistedSQLite()
    fixture.seedConnection({
      ...fixture.authorizedRecord,
      credentialOperation: {
        ...failedOperation(),
        kind: 'client-credentials-acquisition',
        phase: { _tag: 'OwnedBeforeDispatch', ownershipFence: 'old-owner', leaseExpiresAt: 1_100 },
      },
    })
    fixture.reopen()
    const proposal = acquisition(fixture, 1_100)
    const acquired = await Effect.runPromise(
      fixture.store.executeCredentialOperation(
        await command(
          {
            ...proposal,
            proposal: { ...proposal.proposal, kind: 'client-credentials-acquisition' },
          },
          'transfer',
        ),
      ),
    )
    expect(acquired._tag).toBe('CredentialOperationAcquired')
    if (acquired._tag !== 'CredentialOperationAcquired')
      throw new Error('Expected transferred acquisition')
    fixture.reopen()
    const reserved = await Effect.runPromise(
      fixture.store.executeCredentialOperation(
        await command(
          {
            _tag: 'ReserveCredentialOperationDispatch',
            key: fixture.key,
            expectedGeneration: acquired.generation,
            expectedRevision: acquired.revision,
            operationId: acquired.operation.operationId,
            ownershipFence: 'new-owner',
            reservedAt: 1_101,
          },
          'reserve',
        ),
      ),
    )
    expect(reserved._tag).toBe('CredentialOperationDispatchReserved')
  })

  test('replays saved invalidation receipts without invalidating a newer credential', async () => {
    const fixture = await makePersistedSQLite()
    fixture.seedConnection(fixture.authorizedRecord)
    const invalidation = await command(
      {
        _tag: 'InvalidateCredential',
        key: fixture.key,
        expectedGeneration: 0,
        expectedRevision: 4,
      },
      'invalidate',
    )
    const invalidated = await Effect.runPromise(
      fixture.store.executeCredentialOperation(invalidation),
    )
    expect(invalidated._tag).toBe('CredentialInvalidated')
    fixture.reopen()
    expect(await Effect.runPromise(fixture.store.executeCredentialOperation(invalidation))).toEqual(
      invalidated,
    )

    const manager = Connections.create({
      store: fixture.store,
      provider: ApiKey.opaque({ id: fixture.key.providerId }),
    })
    await manager.setApiKey(fixture.key.connectionId, 'replacement-key', { replace: true })
    fixture.reopen()
    expect(await Effect.runPromise(fixture.store.executeCredentialOperation(invalidation))).toEqual(
      {
        _tag: 'StoreConflict',
        reason: 'ConditionChanged',
      },
    )
    const recreated = Connections.create({
      store: fixture.store,
      provider: ApiKey.opaque({ id: fixture.key.providerId }),
    })
    expect(revealSecret((await recreated.credentials(fixture.key.connectionId)).apiKey)).toBe(
      'replacement-key',
    )
  })

  test('retains Self Client enrollment intent and replays admission and completion after reopening', async () => {
    const fixture = await makePersistedSQLite()
    const admission = await command(
      {
        _tag: 'AdmitSelfClientExchange',
        key: fixture.key,
        expectedGeneration: 0,
        expectedRevision: 0,
        intent: 'enroll',
        acquiredAt: 1_000,
        ownershipFence: 'owner',
        leaseExpiresAt: 1_100,
        proposal: {
          operationId: 'self-client',
          startedAt: 1_000,
          recoveryDeadline: 2_000,
          transferLimit: 1,
        },
      },
      'admit',
    )
    const admitted = await Effect.runPromise(fixture.store.executeCredentialOperation(admission))
    expect(admitted._tag).toBe('SelfClientExchangeAdmitted')
    if (admitted._tag !== 'SelfClientExchangeAdmitted')
      throw new Error('Expected Self Client admission')
    fixture.reopen()
    expect(await Effect.runPromise(fixture.store.executeCredentialOperation(admission))).toEqual(
      admitted,
    )
    const reserved = await Effect.runPromise(
      fixture.store.executeCredentialOperation(
        await command(
          {
            _tag: 'ReserveCredentialOperationDispatch',
            key: fixture.key,
            expectedGeneration: admitted.generation,
            expectedRevision: admitted.revision,
            operationId: admitted.operation.operationId,
            ownershipFence: 'owner',
            reservedAt: 1_010,
          },
          'reserve',
        ),
      ),
    )
    if (reserved._tag !== 'CredentialOperationDispatchReserved')
      throw new Error('Expected dispatch reservation')
    const completion = await command(
      {
        _tag: 'CompleteSelfClientExchange',
        key: fixture.key,
        expectedGeneration: reserved.generation,
        expectedRevision: reserved.revision,
        operationId: admitted.operation.operationId,
        ownershipFence: 'owner',
        credentialEnvelope: fixture.authorizedRecord.credentialEnvelope,
        credentialExpiresAt: null,
        completedAt: 1_020,
      },
      'complete',
    )
    const completed = await Effect.runPromise(fixture.store.executeCredentialOperation(completion))
    expect(completed._tag).toBe('SelfClientExchangeCompleted')
    fixture.reopen()
    expect(await Effect.runPromise(fixture.store.executeCredentialOperation(completion))).toEqual(
      completed,
    )
    expect(await Effect.runPromise(fixture.store.inspectConnection(fixture.key))).toMatchObject({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
  })

  test('rejects saved Self Client work without an enrollment or replacement intent', async () => {
    expect.hasAssertions()
    await expectCorruptRecordRejected({
      authorization: { _tag: 'NotAuthorized' },
      credentialEnvelope: null,
      credentialOperation: {
        ...failedOperation(),
        kind: 'self-client-exchange',
        phase: { _tag: 'OwnedBeforeDispatch', ownershipFence: 'owner', leaseExpiresAt: 1_100 },
      },
    })
  })

  test('rejects a saved acquisition that has exceeded its ownership-transfer limit', async () => {
    expect.hasAssertions()
    await expectCorruptRecordRejected({
      credentialOperation: {
        ...failedOperation(),
        kind: 'client-credentials-acquisition',
        transferCount: 2,
        phase: { _tag: 'OwnedBeforeDispatch', ownershipFence: 'owner', leaseExpiresAt: 1_100 },
      },
    })
  })

  test('rejects a corrupt command receipt instead of acknowledging a different operation', async () => {
    const fixture = await makePersistedSQLite()
    fixture.seedConnection(fixture.authorizedRecord)
    const invalidation = await command(
      {
        _tag: 'InvalidateCredential',
        key: fixture.key,
        expectedGeneration: 0,
        expectedRevision: 4,
      },
      'invalidate',
    )
    const invalidated = await Effect.runPromise(
      fixture.store.executeCredentialOperation(invalidation),
    )
    if (invalidated._tag !== 'CredentialInvalidated') throw new Error('Expected invalidation')
    fixture.corruptReceiptResult('invalidate', { ...invalidated, _tag: 'CredentialSaved' })
    fixture.reopen()

    await expect(
      Effect.runPromise(fixture.store.executeCredentialOperation(invalidation)),
    ).rejects.toMatchObject({
      _tag: 'SQLiteStorageFailure',
      operation: 'execute',
    })
  })
})
