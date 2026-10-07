import { expect, test } from 'vitest'
import {
  canonicalStoreInput,
  digestStoreInput,
  verifyStoreConformance,
  type AuthorizationAdmission,
  type AuthorizationAttempt,
  type ConnectionKey,
  type ConnectionStore,
  type CredentialOperationAcquired,
  type CredentialOperationCommandInput,
  type CredentialOperationDispatchReserved,
  type CredentialOperationInterventionMarked,
  type ProtectedCredentialEnvelope,
  type SelfClientExchangeAdmitted,
  type StoreCommandInput,
  type StoreConformanceRunner,
} from '../../../src/stores/index.js'

export interface StoreConformanceTarget<E, R, InspectionError = E, InspectionRequirements = R> {
  readonly store: ConnectionStore<E, R, InspectionError, InspectionRequirements>
  readonly run: StoreConformanceRunner<E, R>
}

export interface CredentialOperationStoreConformanceTarget<
  E,
  R,
  InspectionError = E,
  InspectionRequirements = R,
> extends StoreConformanceTarget<E, R, InspectionError, InspectionRequirements> {
  readonly pruneReceipts: () => void | Promise<void>
}

const protectedVerifier = {
  version: 1,
  algorithm: 'AES-256-GCM',
  keyId: 'test',
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
} as const

async function withRequest<Command extends StoreCommandInput | CredentialOperationCommandInput>(
  command: Command,
  requestId: string,
): Promise<
  Command & { readonly request: { readonly requestId: string; readonly inputDigest: string } }
> {
  return {
    ...command,
    request: {
      requestId,
      inputDigest: await digestStoreInput(command),
    },
  }
}

function attempt(key: ConnectionKey, stateDigest: string, expiresAt = 2_000): AuthorizationAttempt {
  return {
    schemaVersion: 1,
    stateDigest,
    key,
    generation: 0,
    intent: 'enroll',
    bindingDigest: `binding:${stateDigest}`,
    pkceVerifierEnvelope: protectedVerifier,
    createdAt: 1_000,
    expiresAt,
  }
}

function admissionInput(admission: AuthorizationAdmission) {
  return {
    _tag: 'AdmitAuthorizationAttempt' as const,
    admission,
    ownershipFence: `fence:${admission.admissionId}`,
    leaseExpiresAt: admission.admittedAt + 10_000,
    operation: {
      operationId: `exchange:${admission.admissionId}`,
      kind: 'authorization-exchange' as const,
      startedAt: admission.admittedAt,
      recoveryDeadline: admission.admittedAt + 120_000,
      transferLimit: 3,
    },
  }
}

export function storeConformance<Error, Requirements, InspectionError, InspectionRequirements>(
  name: string,
  makeTarget: () => StoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
): void {
  test(`${name}: uses canonical SHA-256 command input digests`, async () => {
    const input = {
      key: { providerId: 'salesforce', namespace: 'example', connectionId: 'connection' },
      _tag: 'InitializeConnection',
    }

    expect(canonicalStoreInput(input)).toBe(
      '{"_tag":"InitializeConnection","key":{"connectionId":"connection","namespace":"example","providerId":"salesforce"}}',
    )
    await expect(digestStoreInput(input)).resolves.toBe(
      '021ecb87c9e88b94a2c5fef51cc3762e1167e74d83a1af6bcc7ff16eea0c1085',
    )
  })

  test(`${name}: initializes, reads, and replays one immutable command`, async () => {
    const target = makeTarget()
    const report = await verifyStoreConformance(target.store, target.run, `${name}-replay`)

    expect(report.initialResult).toEqual({
      _tag: 'ConnectionInitialized',
      generation: 0,
      revision: 0,
    })
    expect(report.replayedResult).toEqual(report.initialResult)
    expect(report.snapshot).toMatchObject({
      schemaVersion: 1,
      generation: 0,
      revision: 0,
      authorization: { _tag: 'NotAuthorized' },
    })
  })

  test(`${name}: rejects request-ID reuse with a different digest`, async () => {
    const target = makeTarget()
    const report = await verifyStoreConformance(target.store, target.run, `${name}-request-id`)

    expect(report.requestReuse).toEqual({
      _tag: 'StoreConflict',
      reason: 'RequestIdReused',
    })
  })

  test(`${name}: rejects a fresh initialize command after the condition changed`, async () => {
    const target = makeTarget()
    const report = await verifyStoreConformance(target.store, target.run, `${name}-condition`)

    expect(report.changedCondition).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
  })

  test(`${name}: creates and validates a bound authorization attempt idempotently`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:attempt-create`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const authorizationAttempt = attempt(key, 'state:create')
    const command = await withRequest(
      { _tag: 'CreateAuthorizationAttempt' as const, attempt: authorizationAttempt },
      'create-attempt',
    )

    const created = await target.run(target.store.execute(command))
    const replayed = await target.run(target.store.execute(command))
    const validated = await target.run(
      target.store.readAuthorizationAttempt({
        namespace: key.namespace,
        stateDigest: authorizationAttempt.stateDigest,
        bindingDigest: authorizationAttempt.bindingDigest,
        now: 1_500,
      }),
    )
    const wrongBinding = await target.run(
      target.store.readAuthorizationAttempt({
        namespace: key.namespace,
        stateDigest: authorizationAttempt.stateDigest,
        bindingDigest: 'binding:wrong',
        now: 1_500,
      }),
    )

    expect(created).toEqual({
      _tag: 'AuthorizationAttemptCreated',
      generation: 0,
      revision: 1,
    })
    expect(replayed).toEqual(created)
    expect(validated).toEqual(authorizationAttempt)
    expect(wrongBinding).toBeNull()
  })

  test(`${name}: expires attempts and lets a newer page supersede only preparation`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:attempt-supersession`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const first = attempt(key, 'state:first')
    const second = attempt(key, 'state:second', 3_000)

    await target.run(
      target.store.execute(
        await withRequest({ _tag: 'CreateAuthorizationAttempt' as const, attempt: first }, 'first'),
      ),
    )
    await target.run(
      target.store.execute(
        await withRequest(
          { _tag: 'CreateAuthorizationAttempt' as const, attempt: second },
          'second',
        ),
      ),
    )

    expect(
      await target.run(
        target.store.readAuthorizationAttempt({
          namespace: key.namespace,
          stateDigest: first.stateDigest,
          bindingDigest: first.bindingDigest,
          now: 1_500,
        }),
      ),
    ).toBeNull()
    expect(
      await target.run(
        target.store.readAuthorizationAttempt({
          namespace: key.namespace,
          stateDigest: second.stateDigest,
          bindingDigest: second.bindingDigest,
          now: second.expiresAt,
        }),
      ),
    ).toBeNull()
  })

  test(`${name}: rejects admission at the attempt expiration boundary`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:attempt-expired-admission`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const authorizationAttempt = attempt(key, 'state:expired-admission')
    await target.run(
      target.store.execute(
        await withRequest(
          { _tag: 'CreateAuthorizationAttempt' as const, attempt: authorizationAttempt },
          'create',
        ),
      ),
    )
    const admission = {
      stateDigest: authorizationAttempt.stateDigest,
      key,
      intent: 'enroll' as const,
      generation: 0,
      admissionId: 'expired-admission',
      admittedAt: authorizationAttempt.expiresAt,
      admissionExpiresAt: authorizationAttempt.expiresAt + 30_000,
    }

    const result = await target.run(
      target.store.execute(await withRequest(admissionInput(admission), 'admit-expired')),
    )

    expect(result).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
  })

  test(`${name}: admits exactly one callback and rejects reuse`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:attempt-admission`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const authorizationAttempt = attempt(key, 'state:admission')
    await target.run(
      target.store.execute(
        await withRequest(
          { _tag: 'CreateAuthorizationAttempt' as const, attempt: authorizationAttempt },
          'create',
        ),
      ),
    )
    const admission = {
      stateDigest: authorizationAttempt.stateDigest,
      key,
      intent: 'enroll' as const,
      generation: 0,
      admissionId: 'admission-one',
      admittedAt: 1_500,
      admissionExpiresAt: 31_500,
    }
    const first = await withRequest(admissionInput(admission), 'admit-one')
    const second = await withRequest(
      admissionInput({ ...admission, admissionId: 'admission-two' }),
      'admit-two',
    )
    const results = await Promise.all([
      target.run(target.store.execute(first)),
      target.run(target.store.execute(second)),
    ])

    expect(results.filter((result) => result._tag === 'AuthorizationAttemptAdmitted')).toHaveLength(
      1,
    )
    expect(results.filter((result) => result._tag === 'StoreConflict')).toHaveLength(1)
    expect(await target.run(target.store.execute(first))).toEqual(results[0])
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      authorization: { _tag: 'NotAuthorized' },
      credentialEnvelope: null,
      credentialOperation: { kind: 'authorization-exchange' },
    })
    expect(
      await target.run(
        target.store.readAuthorizationAttempt({
          namespace: key.namespace,
          stateDigest: authorizationAttempt.stateDigest,
          bindingDigest: authorizationAttempt.bindingDigest,
          now: 1_600,
        }),
      ),
    ).toBeNull()
  })

  test(`${name}: recovers an admitted attempt only after lease expiry without resetting operation limits`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:attempt-admission-recovery`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const authorizationAttempt = attempt(key, 'state:admission-recovery', 10_000)
    await target.run(
      target.store.execute(
        await withRequest(
          { _tag: 'CreateAuthorizationAttempt' as const, attempt: authorizationAttempt },
          'create',
        ),
      ),
    )
    const firstAdmission = {
      stateDigest: authorizationAttempt.stateDigest,
      key,
      intent: 'enroll' as const,
      generation: 0,
      admissionId: 'admission:first',
      admittedAt: 1_500,
      admissionExpiresAt: 5_000,
    }
    const firstInput = {
      ...admissionInput(firstAdmission),
      leaseExpiresAt: 2_000,
      operation: {
        operationId: 'exchange:original',
        kind: 'authorization-exchange' as const,
        startedAt: firstAdmission.admittedAt,
        recoveryDeadline: 6_000,
        transferLimit: 3,
      },
    }
    const first = await target.run(
      target.store.execute(await withRequest(firstInput, 'admit:first')),
    )
    if (
      first._tag !== 'AuthorizationAttemptAdmitted' ||
      first.operation.phase._tag !== 'OwnedBeforeDispatch'
    ) {
      throw new Error('Expected initial authorization admission')
    }

    const lookup = (now: number) =>
      target.store.readAuthorizationAttempt({
        namespace: key.namespace,
        stateDigest: authorizationAttempt.stateDigest,
        bindingDigest: authorizationAttempt.bindingDigest,
        now,
      })
    expect(await target.run(lookup(firstInput.leaseExpiresAt - 1))).toBeNull()
    expect(await target.run(lookup(firstInput.leaseExpiresAt))).toEqual(authorizationAttempt)

    const secondAdmission = {
      ...firstAdmission,
      admissionId: 'admission:second',
      admittedAt: firstInput.leaseExpiresAt,
      admissionExpiresAt: 7_000,
    }
    const transferInput = {
      ...admissionInput(secondAdmission),
      leaseExpiresAt: 2_500,
      operation: {
        operationId: 'exchange:must-not-replace',
        kind: 'authorization-exchange' as const,
        startedAt: secondAdmission.admittedAt,
        recoveryDeadline: 99_000,
        transferLimit: 99,
      },
    }
    const transferred = await target.run(
      target.store.execute(await withRequest(transferInput, 'admit:second')),
    )

    expect(transferred).toMatchObject({
      _tag: 'AuthorizationAttemptAdmitted',
      operation: {
        operationId: firstInput.operation.operationId,
        observedRevision: first.operation.observedRevision,
        startedAt: firstInput.operation.startedAt,
        recoveryDeadline: firstInput.operation.recoveryDeadline,
        transferCount: 1,
        transferLimit: firstInput.operation.transferLimit,
        phase: {
          _tag: 'OwnedBeforeDispatch',
          ownershipFence: transferInput.ownershipFence,
          leaseExpiresAt: transferInput.leaseExpiresAt,
        },
      },
    })
    expect(await target.run(lookup(transferInput.leaseExpiresAt - 1))).toBeNull()
    expect(await target.run(lookup(transferInput.leaseExpiresAt))).toEqual(authorizationAttempt)
    expect(await target.run(lookup(firstInput.operation.recoveryDeadline))).toBeNull()
  })

  test(`${name}: rejects denial closure at the attempt expiration boundary`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:attempt-expired-close`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const authorizationAttempt = attempt(key, 'state:expired-close')
    await target.run(
      target.store.execute(
        await withRequest(
          { _tag: 'CreateAuthorizationAttempt' as const, attempt: authorizationAttempt },
          'create',
        ),
      ),
    )

    const result = await target.run(
      target.store.execute(
        await withRequest(
          {
            _tag: 'CloseAuthorizationAttempt' as const,
            stateDigest: authorizationAttempt.stateDigest,
            key,
            expectedGeneration: 0,
            closedAt: authorizationAttempt.expiresAt,
            reason: 'ProviderDenied' as const,
          },
          'close-expired',
        ),
      ),
    )

    expect(result).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
  })

  test(`${name}: closes a prepared attempt without authorizing its connection`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:attempt-close`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const authorizationAttempt = attempt(key, 'state:close')
    await target.run(
      target.store.execute(
        await withRequest(
          { _tag: 'CreateAuthorizationAttempt' as const, attempt: authorizationAttempt },
          'create',
        ),
      ),
    )
    const closed = await target.run(
      target.store.execute(
        await withRequest(
          {
            _tag: 'CloseAuthorizationAttempt' as const,
            stateDigest: authorizationAttempt.stateDigest,
            key,
            expectedGeneration: 0,
            closedAt: 1_500,
            reason: 'ProviderDenied' as const,
          },
          'close',
        ),
      ),
    )

    expect(closed).toEqual({
      _tag: 'AuthorizationAttemptClosed',
      generation: 0,
      revision: 2,
    })
    expect((await target.run(target.store.readConnection(key)))?.authorization).toEqual({
      _tag: 'NotAuthorized',
    })
    expect(
      await target.run(
        target.store.readAuthorizationAttempt({
          namespace: key.namespace,
          stateDigest: authorizationAttempt.stateDigest,
          bindingDigest: authorizationAttempt.bindingDigest,
          now: 1_600,
        }),
      ),
    ).toBeNull()
  })
}

async function authorizeConnection<Error, Requirements, InspectionError, InspectionRequirements>(
  target: CredentialOperationStoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
  key: ConnectionKey,
  options: {
    readonly generation?: number
    readonly sequence?: string
    readonly startedAt?: number
    readonly credentialEnvelope?: AuthorizationAttempt['pkceVerifierEnvelope']
    readonly credentialExpiresAt?: number
  } = {},
): Promise<void> {
  const generation = options.generation ?? 0
  const sequence = options.sequence ?? key.connectionId
  const startedAt = options.startedAt ?? 1_000
  const authorizationAttempt = {
    ...attempt(key, `state:${sequence}`, startedAt + 1_000),
    generation,
    createdAt: startedAt,
  }
  await target.run(
    target.store.execute(
      await withRequest(
        { _tag: 'CreateAuthorizationAttempt' as const, attempt: authorizationAttempt },
        `create:${sequence}`,
      ),
    ),
  )
  const admission = {
    stateDigest: authorizationAttempt.stateDigest,
    key,
    intent: 'enroll' as const,
    generation,
    admissionId: `admission:${sequence}`,
    admittedAt: startedAt + 500,
    admissionExpiresAt: startedAt + 30_500,
  }
  const admitted = await target.run(
    target.store.execute(await withRequest(admissionInput(admission), `admit:${sequence}`)),
  )
  if (
    admitted._tag !== 'AuthorizationAttemptAdmitted' ||
    admitted.operation.phase._tag !== 'OwnedBeforeDispatch'
  ) {
    throw new Error('Expected authorization admission')
  }
  const reserved = await target.run(
    target.store.executeCredentialOperation(
      await withRequest(
        {
          _tag: 'ReserveCredentialOperationDispatch' as const,
          key,
          expectedGeneration: admitted.generation,
          expectedRevision: admitted.revision,
          operationId: admitted.operation.operationId,
          ownershipFence: admitted.operation.phase.ownershipFence,
          reservedAt: startedAt + 550,
        },
        `reserve-authorization:${sequence}`,
      ),
    ),
  )
  if (reserved._tag !== 'CredentialOperationDispatchReserved') {
    throw new Error('Expected authorization reservation')
  }
  await target.run(
    target.store.execute(
      await withRequest(
        {
          _tag: 'CompleteAuthorizationAttempt' as const,
          admission,
          expectedRevision: reserved.revision,
          operationId: admitted.operation.operationId,
          ownershipFence: admitted.operation.phase.ownershipFence,
          credentialEnvelope: options.credentialEnvelope ?? protectedVerifier,
          credentialExpiresAt: options.credentialExpiresAt ?? 0,
          completedAt: startedAt + 600,
        },
        `authorize:${sequence}`,
      ),
    ),
  )
}

function acquisitionInput(key: ConnectionKey, revision: number, owner: string, now = 2_000) {
  return {
    _tag: 'AcquireCredentialOperation' as const,
    key,
    expectedGeneration: 0,
    expectedRevision: revision,
    acquiredAt: now,
    ownershipFence: `fence:${owner}`,
    leaseExpiresAt: now + 100,
    proposal: {
      operationId: `operation:${owner}`,
      kind: 'refresh' as const,
      startedAt: now,
      recoveryDeadline: now + 1_000,
      transferLimit: 3,
    },
  }
}

async function acquireRefreshOperation<
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
>(
  target: CredentialOperationStoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
  key: ConnectionKey,
  owner: string,
  options: { readonly transferLimit?: number } = {},
): Promise<CredentialOperationAcquired> {
  await authorizeConnection(target, key)
  const before = await target.run(target.store.readConnection(key))
  if (before === null) throw new Error('Expected an authorized connection')
  const input = acquisitionInput(key, before.revision, owner)
  const acquired = await target.run(
    target.store.executeCredentialOperation(
      await withRequest(
        options.transferLimit === undefined
          ? input
          : {
              ...input,
              proposal: { ...input.proposal, transferLimit: options.transferLimit },
            },
        `acquire:${owner}`,
      ),
    ),
  )
  if (
    acquired._tag !== 'CredentialOperationAcquired' ||
    acquired.operation.phase._tag !== 'OwnedBeforeDispatch'
  ) {
    throw new Error('Expected operation acquisition')
  }
  return acquired
}

async function admitSelfClientExchange<
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
>(
  target: CredentialOperationStoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
  key: ConnectionKey,
  options: {
    readonly intent: 'enroll' | 'replace'
    readonly generation: number
    readonly revision: number
    readonly operationId: string
    readonly ownershipFence: string
    readonly acquiredAt: number
  },
) {
  const command = await withRequest(
    {
      _tag: 'AdmitSelfClientExchange' as const,
      key,
      expectedGeneration: options.generation,
      expectedRevision: options.revision,
      intent: options.intent,
      acquiredAt: options.acquiredAt,
      ownershipFence: options.ownershipFence,
      leaseExpiresAt: options.acquiredAt + 100,
      proposal: {
        operationId: options.operationId,
        startedAt: options.acquiredAt,
        recoveryDeadline: options.acquiredAt + 10_000,
        transferLimit: 2,
      },
    },
    `admit-self-client:${options.operationId}`,
  )
  const result = await target.run(target.store.executeCredentialOperation(command))
  if (result._tag !== 'SelfClientExchangeAdmitted') {
    throw new Error('Expected Self Client exchange admission')
  }
  return { command, result }
}

async function reserveSelfClientDispatch<
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
>(
  target: CredentialOperationStoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
  key: ConnectionKey,
  admission: SelfClientExchangeAdmitted,
  reservedAt: number,
): Promise<CredentialOperationDispatchReserved> {
  const { operation } = admission
  if (operation.kind !== 'self-client-exchange' || operation.phase._tag !== 'OwnedBeforeDispatch') {
    throw new Error('Expected pre-dispatch Self Client ownership')
  }
  const result = await target.run(
    target.store.executeCredentialOperation(
      await withRequest(
        {
          _tag: 'ReserveCredentialOperationDispatch' as const,
          key,
          expectedGeneration: admission.generation,
          expectedRevision: admission.revision,
          operationId: operation.operationId,
          ownershipFence: operation.phase.ownershipFence,
          reservedAt,
        },
        `reserve-self-client:${operation.operationId}`,
      ),
    ),
  )
  if (result._tag !== 'CredentialOperationDispatchReserved') {
    throw new Error('Expected Self Client dispatch reservation')
  }
  return result
}

async function completeSelfClientExchange<
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
>(
  target: CredentialOperationStoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
  key: ConnectionKey,
  admission: SelfClientExchangeAdmitted,
  expectedRevision: number,
  completedAt: number,
  requestId: string,
  envelope: ProtectedCredentialEnvelope = protectedVerifier,
) {
  if (
    admission.operation.kind !== 'self-client-exchange' ||
    admission.operation.phase._tag !== 'OwnedBeforeDispatch'
  ) {
    throw new Error('Expected pre-dispatch Self Client ownership')
  }
  const command = await withRequest(
    {
      _tag: 'CompleteSelfClientExchange' as const,
      key,
      expectedGeneration: admission.generation,
      expectedRevision,
      operationId: admission.operation.operationId,
      ownershipFence: admission.operation.phase.ownershipFence,
      credentialEnvelope: envelope,
      credentialExpiresAt: completedAt + 60_000,
      completedAt,
    },
    requestId,
  )
  return {
    command,
    result: await target.run(target.store.executeCredentialOperation(command)),
  }
}

async function markSelfClientIntervention<
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
>(
  target: CredentialOperationStoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
  key: ConnectionKey,
  admission: SelfClientExchangeAdmitted,
  expectedRevision: number,
  markedAt: number,
) {
  if (
    admission.operation.kind !== 'self-client-exchange' ||
    admission.operation.phase._tag !== 'OwnedBeforeDispatch'
  ) {
    throw new Error('Expected pre-dispatch Self Client ownership')
  }
  const result = await target.run(
    target.store.executeCredentialOperation(
      await withRequest(
        {
          _tag: 'MarkCredentialOperationIntervention' as const,
          key,
          expectedGeneration: admission.generation,
          expectedRevision,
          operationId: admission.operation.operationId,
          ownershipFence: admission.operation.phase.ownershipFence,
          markedAt,
          reason: 'ProviderOutcomeUnknown' as const,
        },
        `intervene-self-client:${admission.operation.operationId}`,
      ),
    ),
  )
  if (result._tag !== 'CredentialOperationInterventionMarked') {
    throw new Error('Expected Self Client intervention marker')
  }
  return result satisfies CredentialOperationInterventionMarked
}

async function reserveRefreshDispatch<Error, Requirements, InspectionError, InspectionRequirements>(
  target: CredentialOperationStoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
  key: ConnectionKey,
  acquired: CredentialOperationAcquired,
): Promise<CredentialOperationDispatchReserved> {
  const { operation } = acquired
  if (operation.phase._tag !== 'OwnedBeforeDispatch') {
    throw new Error('Expected pre-dispatch ownership')
  }
  const reserved = await target.run(
    target.store.executeCredentialOperation(
      await withRequest(
        {
          _tag: 'ReserveCredentialOperationDispatch' as const,
          key,
          expectedGeneration: acquired.generation,
          expectedRevision: acquired.revision,
          operationId: operation.operationId,
          ownershipFence: operation.phase.ownershipFence,
          reservedAt: operation.startedAt + 50,
        },
        `reserve:${operation.operationId}`,
      ),
    ),
  )
  if (reserved._tag !== 'CredentialOperationDispatchReserved') {
    throw new Error('Expected dispatch reservation')
  }
  return reserved
}

export function credentialOperationStoreConformance<
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
>(
  name: string,
  makeTarget: () => CredentialOperationStoreConformanceTarget<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >,
): void {
  test(`${name}: admits and completes a protected Self Client enrollment with immutable receipts`, async () => {
    const target = makeTarget()
    const blockedKey = {
      namespace: `${name}:self-client-browser-conflict`,
      providerId: 'zoho-self-client',
      connectionId: 'connection',
    }
    await target.run(
      target.store.execute(
        await withRequest(
          {
            _tag: 'CreateAuthorizationAttempt' as const,
            attempt: attempt(blockedKey, 'state:self-client-conflict'),
          },
          'self-client:browser-prepared',
        ),
      ),
    )
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'AdmitSelfClientExchange' as const,
              key: blockedKey,
              expectedGeneration: 0,
              expectedRevision: 1,
              intent: 'enroll' as const,
              acquiredAt: 1_100,
              ownershipFence: 'self-client:browser-conflict',
              leaseExpiresAt: 1_200,
              proposal: {
                operationId: 'self-client:browser-conflict',
                startedAt: 1_100,
                recoveryDeadline: 10_000,
                transferLimit: 1,
              },
            },
            'self-client:browser-conflict',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

    const key = {
      namespace: `${name}:self-client-initial`,
      providerId: 'zoho-self-client',
      connectionId: 'connection',
    }
    const { command: admissionCommand, result: admission } = await admitSelfClientExchange(
      target,
      key,
      {
        intent: 'enroll',
        generation: 0,
        revision: 0,
        operationId: 'self-client:initial',
        ownershipFence: 'self-client:initial-fence',
        acquiredAt: 1_000,
      },
    )
    expect(await target.run(target.store.executeCredentialOperation(admissionCommand))).toEqual(
      admission,
    )
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      generation: 0,
      revision: admission.revision,
      authorization: { _tag: 'NotAuthorized' },
      credentialEnvelope: null,
      credentialOperation: {
        kind: 'self-client-exchange',
        intent: 'enroll',
        phase: { _tag: 'OwnedBeforeDispatch' },
      },
    })
    expect(
      await target.run(
        target.store.execute(
          await withRequest(
            {
              _tag: 'CreateAuthorizationAttempt' as const,
              attempt: attempt(key, 'state:self-client-after-admission'),
            },
            'self-client:browser-after-admission',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

    const reservation = await reserveSelfClientDispatch(target, key, admission, 1_010)
    const completion = await completeSelfClientExchange(
      target,
      key,
      admission,
      reservation.revision,
      1_020,
      'self-client:complete-initial',
    )
    expect(completion.result).toEqual({
      _tag: 'SelfClientExchangeCompleted',
      generation: 0,
      revision: reservation.revision + 1,
    })
    expect(await target.run(target.store.executeCredentialOperation(completion.command))).toEqual(
      completion.result,
    )
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      generation: 0,
      revision: reservation.revision + 1,
      authorization: { _tag: 'Authorized', credentialExpiresAt: 61_020 },
      credentialEnvelope: protectedVerifier,
      credentialOperation: null,
    })
  })

  test(`${name}: Self Client admission fences concurrent refresh and removal mutations`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:self-client-refresh-race`,
      providerId: 'zoho-self-client',
      connectionId: 'connection',
    }
    const enrollment = await admitSelfClientExchange(target, key, {
      intent: 'enroll',
      generation: 0,
      revision: 0,
      operationId: 'self-client:race-enroll',
      ownershipFence: 'self-client:race-enroll-fence',
      acquiredAt: 1_000,
    })
    const enrollmentReservation = await reserveSelfClientDispatch(
      target,
      key,
      enrollment.result,
      1_010,
    )
    await completeSelfClientExchange(
      target,
      key,
      enrollment.result,
      enrollmentReservation.revision,
      1_020,
      'self-client:race-enrollment-complete',
    )
    const beforeRace = await target.run(target.store.readConnection(key))
    if (beforeRace === null) throw new Error('Expected enrolled Self Client connection')
    const [replacement, refresh] = await Promise.all([
      target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'AdmitSelfClientExchange' as const,
              key,
              expectedGeneration: beforeRace.generation,
              expectedRevision: beforeRace.revision,
              intent: 'replace' as const,
              acquiredAt: 2_000,
              ownershipFence: 'self-client:refresh-race-fence',
              leaseExpiresAt: 2_100,
              proposal: {
                operationId: 'self-client:refresh-race-replacement',
                startedAt: 2_000,
                recoveryDeadline: 12_000,
                transferLimit: 1,
              },
            },
            'self-client:refresh-race-admit',
          ),
        ),
      ),
      target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            acquisitionInput(key, beforeRace.revision, 'self-client-race', 2_000),
            'self-client:refresh-race-refresh',
          ),
        ),
      ),
    ])
    expect([replacement._tag, refresh._tag].filter((tag) => tag !== 'StoreConflict')).toHaveLength(
      1,
    )
    expect([replacement._tag, refresh._tag].filter((tag) => tag === 'StoreConflict')).toHaveLength(
      1,
    )

    const removalKey = {
      namespace: `${name}:self-client-removal-race`,
      providerId: 'zoho-self-client',
      connectionId: 'connection',
    }
    const initial = await admitSelfClientExchange(target, removalKey, {
      intent: 'enroll',
      generation: 0,
      revision: 0,
      operationId: 'self-client:removal-enroll',
      ownershipFence: 'self-client:removal-enroll-fence',
      acquiredAt: 3_000,
    })
    const initialReservation = await reserveSelfClientDispatch(
      target,
      removalKey,
      initial.result,
      3_010,
    )
    await completeSelfClientExchange(
      target,
      removalKey,
      initial.result,
      initialReservation.revision,
      3_020,
      'self-client:removal-enrollment-complete',
    )
    const beforeRemovalRace = await target.run(target.store.readConnection(removalKey))
    if (beforeRemovalRace === null) throw new Error('Expected enrolled Self Client connection')
    const [replacementAtRemoval, removal] = await Promise.all([
      target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'AdmitSelfClientExchange' as const,
              key: removalKey,
              expectedGeneration: beforeRemovalRace.generation,
              expectedRevision: beforeRemovalRace.revision,
              intent: 'replace' as const,
              acquiredAt: 4_000,
              ownershipFence: 'self-client:removal-race-fence',
              leaseExpiresAt: 4_100,
              proposal: {
                operationId: 'self-client:removal-race-replacement',
                startedAt: 4_000,
                recoveryDeadline: 14_000,
                transferLimit: 1,
              },
            },
            'self-client:removal-race-admit',
          ),
        ),
      ),
      target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'RemoveConnection' as const,
              key: removalKey,
              expectedGeneration: beforeRemovalRace.generation,
              expectedRevision: beforeRemovalRace.revision,
              removedAt: 4_000,
            },
            'self-client:removal-race-remove',
          ),
        ),
      ),
    ])
    expect(
      [replacementAtRemoval._tag, removal._tag].filter((tag) => tag !== 'StoreConflict'),
    ).toHaveLength(1)
    expect(
      [replacementAtRemoval._tag, removal._tag].filter((tag) => tag === 'StoreConflict'),
    ).toHaveLength(1)
  })

  test(`${name}: a fresh explicitly authorized code supersedes uncertain enrollment and replacement without late commits`, async () => {
    const target = makeTarget()
    const initialKey = {
      namespace: `${name}:self-client-unknown-enrollment`,
      providerId: 'zoho-self-client',
      connectionId: 'connection',
    }
    const uncertainEnrollment = await admitSelfClientExchange(target, initialKey, {
      intent: 'enroll',
      generation: 0,
      revision: 0,
      operationId: 'self-client:old-enrollment',
      ownershipFence: 'self-client:old-enrollment-fence',
      acquiredAt: 1_000,
    })
    const oldEnrollmentReservation = await reserveSelfClientDispatch(
      target,
      initialKey,
      uncertainEnrollment.result,
      1_010,
    )
    const enrollmentIntervention = await markSelfClientIntervention(
      target,
      initialKey,
      uncertainEnrollment.result,
      oldEnrollmentReservation.revision,
      1_020,
    )
    expect(enrollmentIntervention._tag).toBe('CredentialOperationInterventionMarked')
    expect(await target.run(target.store.readConnection(initialKey))).toMatchObject({
      authorization: { _tag: 'NotAuthorized' },
      credentialOperation: {
        kind: 'self-client-exchange',
        intent: 'enroll',
        phase: { _tag: 'InterventionRequired', reason: 'ProviderOutcomeUnknown' },
      },
    })
    const freshEnrollment = await admitSelfClientExchange(target, initialKey, {
      intent: 'enroll',
      generation: 0,
      revision: enrollmentIntervention.revision,
      operationId: 'self-client:fresh-enrollment',
      ownershipFence: 'self-client:fresh-enrollment-fence',
      acquiredAt: 1_030,
    })
    expect(
      (
        await completeSelfClientExchange(
          target,
          initialKey,
          uncertainEnrollment.result,
          oldEnrollmentReservation.revision,
          1_040,
          'self-client:late-enrollment',
          { ...protectedVerifier, ciphertext: 'OLD-ENROLLMENT-RESULT' },
        )
      ).result,
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const freshEnrollmentReservation = await reserveSelfClientDispatch(
      target,
      initialKey,
      freshEnrollment.result,
      1_050,
    )
    expect(
      (
        await completeSelfClientExchange(
          target,
          initialKey,
          freshEnrollment.result,
          freshEnrollmentReservation.revision,
          1_060,
          'self-client:fresh-enrollment-complete',
        )
      ).result._tag,
    ).toBe('SelfClientExchangeCompleted')
    expect(await target.run(target.store.readConnection(initialKey))).toMatchObject({
      authorization: { _tag: 'Authorized' },
      credentialEnvelope: protectedVerifier,
      credentialOperation: null,
    })

    const replacementKey = {
      namespace: `${name}:self-client-unknown-replacement`,
      providerId: 'zoho-self-client',
      connectionId: 'connection',
    }
    const originalEnrollment = await admitSelfClientExchange(target, replacementKey, {
      intent: 'enroll',
      generation: 0,
      revision: 0,
      operationId: 'self-client:replacement-enrollment',
      ownershipFence: 'self-client:replacement-enrollment-fence',
      acquiredAt: 2_000,
    })
    const originalReservation = await reserveSelfClientDispatch(
      target,
      replacementKey,
      originalEnrollment.result,
      2_010,
    )
    const originalCompletion = await completeSelfClientExchange(
      target,
      replacementKey,
      originalEnrollment.result,
      originalReservation.revision,
      2_020,
      'self-client:replacement-enrollment-complete',
    )
    expect(originalCompletion.result._tag).toBe('SelfClientExchangeCompleted')
    const beforeReplacement = await target.run(target.store.readConnection(replacementKey))
    if (beforeReplacement === null) throw new Error('Expected enrolled Self Client connection')
    const uncertainReplacement = await admitSelfClientExchange(target, replacementKey, {
      intent: 'replace',
      generation: beforeReplacement.generation,
      revision: beforeReplacement.revision,
      operationId: 'self-client:old-replacement',
      ownershipFence: 'self-client:old-replacement-fence',
      acquiredAt: 2_100,
    })
    const oldReplacementReservation = await reserveSelfClientDispatch(
      target,
      replacementKey,
      uncertainReplacement.result,
      2_110,
    )
    const replacementIntervention = await markSelfClientIntervention(
      target,
      replacementKey,
      uncertainReplacement.result,
      oldReplacementReservation.revision,
      2_120,
    )
    expect(await target.run(target.store.readConnection(replacementKey))).toMatchObject({
      authorization: { _tag: 'Authorized' },
      credentialOperation: {
        kind: 'self-client-exchange',
        intent: 'replace',
        phase: { _tag: 'InterventionRequired', reason: 'ProviderOutcomeUnknown' },
      },
    })
    const freshReplacement = await admitSelfClientExchange(target, replacementKey, {
      intent: 'replace',
      generation: beforeReplacement.generation,
      revision: replacementIntervention.revision,
      operationId: 'self-client:fresh-replacement',
      ownershipFence: 'self-client:fresh-replacement-fence',
      acquiredAt: 2_130,
    })
    expect(
      (
        await completeSelfClientExchange(
          target,
          replacementKey,
          uncertainReplacement.result,
          oldReplacementReservation.revision,
          2_140,
          'self-client:late-replacement',
          { ...protectedVerifier, ciphertext: 'OLD-REPLACEMENT-RESULT' },
        )
      ).result,
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const freshReplacementReservation = await reserveSelfClientDispatch(
      target,
      replacementKey,
      freshReplacement.result,
      2_150,
    )
    expect(
      (
        await completeSelfClientExchange(
          target,
          replacementKey,
          freshReplacement.result,
          freshReplacementReservation.revision,
          2_160,
          'self-client:fresh-replacement-complete',
        )
      ).result,
    ).toEqual({
      _tag: 'SelfClientExchangeCompleted',
      generation: beforeReplacement.generation + 1,
      revision: freshReplacementReservation.revision + 1,
    })
    expect(await target.run(target.store.readConnection(replacementKey))).toMatchObject({
      generation: beforeReplacement.generation + 1,
      credentialEnvelope: protectedVerifier,
      credentialOperation: null,
    })
  })

  test(`${name}: records Self Client provider failure through the shared failure command before fresh admission`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:self-client-known-failure`,
      providerId: 'zoho-self-client',
      connectionId: 'connection',
    }
    const admission = await admitSelfClientExchange(target, key, {
      intent: 'enroll',
      generation: 0,
      revision: 0,
      operationId: 'self-client:rejected-code',
      ownershipFence: 'self-client:rejected-code-fence',
      acquiredAt: 1_000,
    })
    const reservation = await reserveSelfClientDispatch(target, key, admission.result, 1_010)
    const operation = admission.result.operation
    if (
      operation.kind !== 'self-client-exchange' ||
      operation.phase._tag !== 'OwnedBeforeDispatch'
    ) {
      throw new Error('Expected pre-dispatch Self Client ownership')
    }
    const failure = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(
          {
            _tag: 'RecordCredentialOperationFailure' as const,
            key,
            expectedGeneration: admission.result.generation,
            expectedRevision: reservation.revision,
            operationId: operation.operationId,
            ownershipFence: operation.phase.ownershipFence,
            failedAt: 1_020,
            reason: 'ProviderRejected' as const,
          },
          'self-client:rejected-code-failure',
        ),
      ),
    )
    expect(failure).toMatchObject({ _tag: 'CredentialOperationFailed', reason: 'ProviderRejected' })
    if (failure._tag !== 'CredentialOperationFailed') {
      throw new Error('Expected Self Client provider failure to be recorded')
    }
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      authorization: { _tag: 'NotAuthorized' },
      credentialOperation: {
        kind: 'self-client-exchange',
        phase: { _tag: 'KnownFailure', reason: 'ProviderRejected' },
      },
    })
    const fresh = await admitSelfClientExchange(target, key, {
      intent: 'enroll',
      generation: failure.generation,
      revision: failure.revision,
      operationId: 'self-client:fresh-after-rejection',
      ownershipFence: 'self-client:fresh-after-rejection-fence',
      acquiredAt: 1_030,
    })
    expect(fresh.result.operation.operationId).toBe('self-client:fresh-after-rejection')
  })

  test(`${name}: saves static credentials atomically with explicit intent and immutable receipts`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:static-save`,
      providerId: 'retell',
      connectionId: 'connection',
    }
    const enrollmentInput = {
      _tag: 'SaveCredential' as const,
      key,
      expectedGeneration: 0,
      expectedRevision: 0,
      intent: 'enroll' as const,
      credentialEnvelope: protectedVerifier,
      credentialExpiresAt: null,
    }

    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            { ...enrollmentInput, intent: 'replace' as const },
            'static:replace-missing',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

    const enrollment = await withRequest(enrollmentInput, 'static:enroll')
    const enrolled = await target.run(target.store.executeCredentialOperation(enrollment))
    expect(enrolled).toEqual({ _tag: 'CredentialSaved', generation: 0, revision: 1 })
    expect(await target.run(target.store.executeCredentialOperation(enrollment))).toEqual(enrolled)
    expect(
      await target.run(
        target.store.executeCredentialOperation({
          ...enrollment,
          request: {
            ...enrollment.request,
            inputDigest: `${enrollment.request.inputDigest}:changed`,
          },
        }),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'RequestIdReused' })
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(enrollmentInput, 'static:fresh-enroll'),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      generation: 0,
      revision: 1,
      authorization: { _tag: 'Authorized', credentialExpiresAt: null },
      credentialEnvelope: protectedVerifier,
      credentialOperation: null,
    })

    const replacementEnvelope = {
      ...protectedVerifier,
      ciphertext: 'BBBBBBBBBBBBBBBBBBBBBB==',
    }
    const replacement = await withRequest(
      {
        _tag: 'SaveCredential' as const,
        key,
        expectedGeneration: 0,
        expectedRevision: 1,
        intent: 'replace' as const,
        credentialEnvelope: replacementEnvelope,
        credentialExpiresAt: null,
      },
      'static:replace',
    )
    const replaced = await target.run(target.store.executeCredentialOperation(replacement))
    expect(replaced).toEqual({ _tag: 'CredentialSaved', generation: 1, revision: 2 })
    expect(await target.run(target.store.executeCredentialOperation(replacement))).toEqual(replaced)
    expect(await target.run(target.store.executeCredentialOperation(enrollment))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      generation: 1,
      revision: 2,
      authorization: { _tag: 'Authorized', credentialExpiresAt: null },
      credentialEnvelope: replacementEnvelope,
      credentialOperation: null,
    })
  })

  test(`${name}: generation and revision fences prevent stale static writes from restoring keys`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:static-fencing`,
      providerId: 'retell',
      connectionId: 'connection',
    }
    const enroll = await withRequest(
      {
        _tag: 'SaveCredential' as const,
        key,
        expectedGeneration: 0,
        expectedRevision: 0,
        intent: 'enroll' as const,
        credentialEnvelope: protectedVerifier,
        credentialExpiresAt: null,
      },
      'static-fencing:enroll',
    )
    const enrolled = await target.run(target.store.executeCredentialOperation(enroll))
    if (enrolled._tag !== 'CredentialSaved') throw new Error('Expected static enrollment')

    const staleReplacementInput = {
      _tag: 'SaveCredential' as const,
      key,
      expectedGeneration: enrolled.generation,
      expectedRevision: enrolled.revision,
      intent: 'replace' as const,
      credentialEnvelope: {
        ...protectedVerifier,
        ciphertext: 'BBBBBBBBBBBBBBBBBBBBBB==',
      },
      credentialExpiresAt: null,
    }
    const removal = await withRequest(
      {
        _tag: 'RemoveConnection' as const,
        key,
        expectedGeneration: enrolled.generation,
        expectedRevision: enrolled.revision,
        removedAt: 2_000,
      },
      'static-fencing:remove',
    )
    const removed = await target.run(target.store.executeCredentialOperation(removal))
    if (removed._tag !== 'ConnectionRemoved') throw new Error('Expected static removal')

    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(staleReplacementInput, 'static-fencing:stale-after-remove'),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

    const reenrollmentEnvelope = {
      ...protectedVerifier,
      ciphertext: 'CCCCCCCCCCCCCCCCCCCCCC==',
    }
    const reenrollment = await withRequest(
      {
        _tag: 'SaveCredential' as const,
        key,
        expectedGeneration: removed.generation,
        expectedRevision: removed.revision,
        intent: 'enroll' as const,
        credentialEnvelope: reenrollmentEnvelope,
        credentialExpiresAt: null,
      },
      'static-fencing:reenroll',
    )
    const reenrolled = await target.run(target.store.executeCredentialOperation(reenrollment))
    if (reenrolled._tag !== 'CredentialSaved') throw new Error('Expected static reenrollment')

    expect(await target.run(target.store.executeCredentialOperation(removal))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(staleReplacementInput, 'static-fencing:stale-after-reenroll'),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      generation: reenrolled.generation,
      revision: reenrolled.revision,
      authorization: { _tag: 'Authorized', credentialExpiresAt: null },
      credentialEnvelope: reenrollmentEnvelope,
      credentialOperation: null,
    })
  })

  test(`${name}: acquires one owner and transfers without resetting fixed operation limits`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:operation-acquisition`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    await authorizeConnection(target, key)
    const before = await target.run(target.store.readConnection(key))
    if (before === null) throw new Error('Expected an authorized connection')
    const first = await withRequest(
      acquisitionInput(key, before.revision, 'first'),
      'acquire:first',
    )
    const competing = await withRequest(
      acquisitionInput(key, before.revision, 'competing'),
      'acquire:competing',
    )

    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              ...acquisitionInput(key, before.revision, 'wrong-generation'),
              expectedGeneration: 1,
            },
            'acquire:wrong-generation',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const acquired = await target.run(target.store.executeCredentialOperation(first))
    expect(await target.run(target.store.executeCredentialOperation(first))).toEqual(acquired)
    expect(await target.run(target.store.executeCredentialOperation(competing))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
    expect(
      await target.run(
        target.store.executeCredentialOperation({
          ...first,
          request: { ...first.request, inputDigest: `${first.request.inputDigest}:changed` },
        }),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'RequestIdReused' })
    if (acquired._tag !== 'CredentialOperationAcquired') {
      throw new Error('Expected operation acquisition')
    }

    const transferInput = {
      ...acquisitionInput(key, acquired.revision, 'transfer', first.leaseExpiresAt),
      proposal: {
        operationId: 'operation:must-not-replace',
        kind: 'refresh' as const,
        startedAt: first.leaseExpiresAt,
        recoveryDeadline: first.leaseExpiresAt + 99_000,
        transferLimit: 99,
      },
    }
    const transferred = await target.run(
      target.store.executeCredentialOperation(await withRequest(transferInput, 'acquire:transfer')),
    )

    expect(transferred).toMatchObject({
      _tag: 'CredentialOperationAcquired',
      operation: {
        operationId: first.proposal.operationId,
        startedAt: first.proposal.startedAt,
        recoveryDeadline: first.proposal.recoveryDeadline,
        transferCount: 1,
        transferLimit: first.proposal.transferLimit,
        phase: {
          _tag: 'OwnedBeforeDispatch',
          ownershipFence: transferInput.ownershipFence,
        },
      },
    })
  })

  test.each([undefined, 'NotDispatched'] as const)(
    `${name}: only evidenced pre-dispatch failures admit one fresh recovery owner, evidence: %s`,
    async (recovery) => {
      const target = makeTarget()
      const key = {
        namespace: `${name}:failure-recovery:${recovery}`,
        providerId: 'salesforce',
        connectionId: 'connection',
      }
      const acquired = await acquireRefreshOperation(target, key, 'original')
      if (acquired.operation.phase._tag !== 'OwnedBeforeDispatch')
        throw new Error('Expected ownership')
      const reserved = await reserveRefreshDispatch(target, key, acquired)
      const failureInput = {
        _tag: 'RecordCredentialOperationFailure' as const,
        key,
        expectedGeneration: reserved.generation,
        expectedRevision: reserved.revision,
        operationId: acquired.operation.operationId,
        ownershipFence: acquired.operation.phase.ownershipFence,
        failedAt: 2_060,
        reason: 'ProviderFailure' as const,
        ...(recovery === undefined ? {} : { recovery }),
      }
      const command = await withRequest(failureInput, 'record-failure')
      const failed = await target.run(target.store.executeCredentialOperation(command))
      if (failed._tag !== 'CredentialOperationFailed') throw new Error('Expected failure recording')
      expect(await target.run(target.store.executeCredentialOperation(command))).toEqual(failed)
      // The original operation's recovery deadline has elapsed. No-dispatch evidence
      // justifies a fresh attempt, not transfer of possibly dispatched work.
      const results = await Promise.all(
        ['first-retry', 'second-retry'].map(async (owner) =>
          target.run(
            target.store.executeCredentialOperation(
              await withRequest(acquisitionInput(key, failed.revision, owner, 200_000), owner),
            ),
          ),
        ),
      )
      expect(
        results.filter((result) => result._tag === 'CredentialOperationAcquired'),
      ).toHaveLength(recovery === 'NotDispatched' ? 1 : 0)
      expect(results.filter((result) => result._tag === 'StoreConflict')).toHaveLength(
        recovery === 'NotDispatched' ? 1 : 2,
      )
      const saved = await target.run(target.store.readConnection(key))
      expect(saved?.credentialOperation?.phase._tag).toBe(
        recovery === 'NotDispatched' ? 'OwnedBeforeDispatch' : 'KnownFailure',
      )
      const staleFailure = await withRequest(failureInput, 'stale-failure')
      expect(await target.run(target.store.executeCredentialOperation(staleFailure))).toEqual({
        _tag: 'StoreConflict',
        reason: 'ConditionChanged',
      })
      expect(await target.run(target.store.readConnection(key))).toEqual(saved)
    },
  )

  test(`${name}: bounded replay evidence survives ownership changes and cannot be extended by later failures`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:bounded-replay`,
      providerId: 'shopify',
      connectionId: 'connection',
    }
    const acquired = await acquireRefreshOperation(target, key, 'first')
    if (acquired.operation.phase._tag !== 'OwnedBeforeDispatch') throw new Error('Expected owner')
    const reserved = await reserveRefreshDispatch(target, key, acquired)
    const failed = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(
          {
            _tag: 'RecordCredentialOperationFailure' as const,
            key,
            expectedGeneration: reserved.generation,
            expectedRevision: reserved.revision,
            operationId: acquired.operation.operationId,
            ownershipFence: acquired.operation.phase.ownershipFence,
            failedAt: 2_060,
            reason: 'ProviderFailure',
            recovery: { _tag: 'ReplaySafe', retryUntil: 10_000, retryAt: 5_000 },
          },
          'record-replay',
        ),
      ),
    )
    if (failed._tag !== 'CredentialOperationFailed') throw new Error('Expected failure recording')
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      credentialOperation: {
        replayUntil: 10_000,
        phase: {
          _tag: 'KnownFailure',
          recovery: { _tag: 'ReplaySafe', retryUntil: 10_000, retryAt: 5_000 },
        },
      },
    })
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(acquisitionInput(key, failed.revision, 'early', 4_999), 'early'),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const retried = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(acquisitionInput(key, failed.revision, 'retry', 5_000), 'retry'),
      ),
    )
    if (
      retried._tag !== 'CredentialOperationAcquired' ||
      retried.operation.phase._tag !== 'OwnedBeforeDispatch'
    )
      throw new Error('Expected recovery owner')
    expect(retried.operation).toMatchObject({ replayUntil: 10_000, startedAt: 5_000 })
    const secondReservation = await reserveRefreshDispatch(target, key, retried)
    const secondFailure = {
      _tag: 'RecordCredentialOperationFailure' as const,
      key,
      expectedGeneration: secondReservation.generation,
      expectedRevision: secondReservation.revision,
      operationId: retried.operation.operationId,
      ownershipFence: retried.operation.phase.ownershipFence,
      failedAt: 5_060,
      reason: 'ProviderFailure' as const,
    }
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              ...secondFailure,
              recovery: { _tag: 'ReplaySafe', retryUntil: 20_000, retryAt: 5_060 },
            },
            'extend',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const notDispatched = await target.run(
      target.store.executeCredentialOperation(
        await withRequest({ ...secondFailure, recovery: 'NotDispatched' }, 'local-failure'),
      ),
    )
    if (notDispatched._tag !== 'CredentialOperationFailed')
      throw new Error('Expected local failure recording')
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      credentialOperation: { replayUntil: 10_000, phase: { recovery: 'NotDispatched' } },
    })
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            acquisitionInput(key, notDispatched.revision, 'expired', 10_000),
            'expired',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const marked = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(
          {
            _tag: 'MarkCredentialOperationIntervention' as const,
            key,
            expectedGeneration: notDispatched.generation,
            expectedRevision: notDispatched.revision,
            operationId: retried.operation.operationId,
            ownershipFence: null,
            markedAt: 10_000,
            reason: 'ProviderOutcomeUnknown',
          },
          'expired-intervention',
        ),
      ),
    )
    expect(marked._tag).toBe('CredentialOperationInterventionMarked')
  })

  test(`${name}: rejects recovery evidence attached to authorization rejection`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:invalid-recovery-evidence`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const acquired = await acquireRefreshOperation(target, key, 'invalid-evidence')
    if (acquired.operation.phase._tag !== 'OwnedBeforeDispatch')
      throw new Error('Expected ownership')
    const reserved = await reserveRefreshDispatch(target, key, acquired)
    const before = await target.run(target.store.readConnection(key))
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'RecordCredentialOperationFailure' as const,
              key,
              expectedGeneration: reserved.generation,
              expectedRevision: reserved.revision,
              operationId: acquired.operation.operationId,
              ownershipFence: acquired.operation.phase.ownershipFence,
              failedAt: 2_060,
              reason: 'ProviderRejected',
              recovery: 'NotDispatched',
            },
            'invalid-evidence',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    expect(await target.run(target.store.readConnection(key))).toEqual(before)
  })

  test(`${name}: records known failures only for the matching dispatch owner`, async () => {
    for (const reason of ['ProviderRejected', 'ProviderFailure'] as const) {
      const target = makeTarget()
      const key = {
        namespace: `${name}:operation-failure:${reason}`,
        providerId: 'salesforce',
        connectionId: 'connection',
      }
      const acquired = await acquireRefreshOperation(target, key, `failure:${reason}`)
      const { operation } = acquired
      if (operation.phase._tag !== 'OwnedBeforeDispatch') {
        throw new Error('Expected pre-dispatch ownership')
      }
      const failureAt = operation.startedAt + 60
      const failureInput = {
        _tag: 'RecordCredentialOperationFailure' as const,
        key,
        expectedGeneration: acquired.generation,
        expectedRevision: acquired.revision,
        operationId: operation.operationId,
        ownershipFence: operation.phase.ownershipFence,
        failedAt: failureAt,
        reason,
      }

      expect(
        await target.run(
          target.store.executeCredentialOperation(
            await withRequest(failureInput, `fail-before-dispatch:${reason}`),
          ),
        ),
      ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

      const reserved = await reserveRefreshDispatch(target, key, acquired)
      const dispatchFailureInput = {
        ...failureInput,
        expectedRevision: reserved.revision,
      }
      expect(
        await target.run(
          target.store.executeCredentialOperation(
            await withRequest(
              { ...dispatchFailureInput, ownershipFence: 'fence:stale' },
              `fail-stale-owner:${reason}`,
            ),
          ),
        ),
      ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

      const command = await withRequest(dispatchFailureInput, `fail:${reason}`)
      const failed = await target.run(target.store.executeCredentialOperation(command))
      expect(failed).toEqual({
        _tag: 'CredentialOperationFailed',
        generation: reserved.generation,
        revision: reserved.revision + 1,
        reason,
      })
      expect(await target.run(target.store.executeCredentialOperation(command))).toEqual(failed)
      expect(await target.run(target.store.readConnection(key))).toMatchObject({
        credentialOperation: {
          operationId: operation.operationId,
          phase: { _tag: 'KnownFailure', reason, failedAt: failureAt },
        },
      })

      if (failed._tag !== 'CredentialOperationFailed') {
        throw new Error('Expected known failure')
      }
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'RemoveConnection' as const,
              key,
              expectedGeneration: failed.generation,
              expectedRevision: failed.revision,
              removedAt: failureAt + 1,
            },
            `remove-after-failure:${reason}`,
          ),
        ),
      )
      expect(await target.run(target.store.executeCredentialOperation(command))).toEqual({
        _tag: 'StoreConflict',
        reason: 'ConditionChanged',
      })
    }
  })

  test(`${name}: marks provider-result intervention only for the matching dispatch owner`, async () => {
    for (const reason of ['ProviderOutcomeUnknown', 'KnownResponseNotPersisted'] as const) {
      const target = makeTarget()
      const key = {
        namespace: `${name}:operation-intervention:${reason}`,
        providerId: 'salesforce',
        connectionId: 'connection',
      }
      const acquired = await acquireRefreshOperation(target, key, `intervention:${reason}`)
      const { operation } = acquired
      if (operation.phase._tag !== 'OwnedBeforeDispatch') {
        throw new Error('Expected pre-dispatch ownership')
      }
      const markedAt = operation.startedAt + 60
      const interventionInput = {
        _tag: 'MarkCredentialOperationIntervention' as const,
        key,
        expectedGeneration: acquired.generation,
        expectedRevision: acquired.revision,
        operationId: operation.operationId,
        ownershipFence: operation.phase.ownershipFence,
        markedAt,
        reason,
      }

      expect(
        await target.run(
          target.store.executeCredentialOperation(
            await withRequest(interventionInput, `intervene-before-dispatch:${reason}`),
          ),
        ),
      ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

      const reserved = await reserveRefreshDispatch(target, key, acquired)
      const dispatchInterventionInput = {
        ...interventionInput,
        expectedRevision: reserved.revision,
      }
      expect(
        await target.run(
          target.store.executeCredentialOperation(
            await withRequest(
              { ...dispatchInterventionInput, ownershipFence: 'fence:stale' },
              `intervene-stale-owner:${reason}`,
            ),
          ),
        ),
      ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

      const command = await withRequest(dispatchInterventionInput, `intervene:${reason}`)
      const marked = await target.run(target.store.executeCredentialOperation(command))
      expect(marked).toEqual({
        _tag: 'CredentialOperationInterventionMarked',
        generation: reserved.generation,
        revision: reserved.revision + 1,
      })
      expect(await target.run(target.store.executeCredentialOperation(command))).toEqual(marked)
      expect(await target.run(target.store.readConnection(key))).toMatchObject({
        credentialOperation: {
          operationId: operation.operationId,
          phase: { _tag: 'InterventionRequired', reason, markedAt },
        },
      })

      if (marked._tag !== 'CredentialOperationInterventionMarked') {
        throw new Error('Expected intervention')
      }
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'RemoveConnection' as const,
              key,
              expectedGeneration: marked.generation,
              expectedRevision: marked.revision,
              removedAt: markedAt + 1,
            },
            `remove-after-intervention:${reason}`,
          ),
        ),
      )
      expect(await target.run(target.store.executeCredentialOperation(command))).toEqual({
        _tag: 'StoreConflict',
        reason: 'ConditionChanged',
      })
    }
  })

  test(`${name}: marks an expired dispatch owner only at the lease boundary`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:operation-expired-dispatch-owner`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const acquired = await acquireRefreshOperation(target, key, 'expired-dispatch-owner')
    const { operation } = acquired
    if (operation.phase._tag !== 'OwnedBeforeDispatch') {
      throw new Error('Expected pre-dispatch ownership')
    }
    const reserved = await reserveRefreshDispatch(target, key, acquired)
    const interventionInput = {
      _tag: 'MarkCredentialOperationIntervention' as const,
      key,
      expectedGeneration: reserved.generation,
      expectedRevision: reserved.revision,
      operationId: operation.operationId,
      ownershipFence: null,
      markedAt: operation.phase.leaseExpiresAt,
      reason: 'DispatchOwnerExpired' as const,
    }

    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            { ...interventionInput, markedAt: operation.phase.leaseExpiresAt - 1 },
            'intervene:dispatch-owner-not-expired',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

    const command = await withRequest(interventionInput, 'intervene:dispatch-owner-expired')
    const marked = await target.run(target.store.executeCredentialOperation(command))
    expect(marked).toEqual({
      _tag: 'CredentialOperationInterventionMarked',
      generation: reserved.generation,
      revision: reserved.revision + 1,
    })
    expect(await target.run(target.store.executeCredentialOperation(command))).toEqual(marked)
    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      credentialOperation: {
        phase: {
          _tag: 'InterventionRequired',
          reason: 'DispatchOwnerExpired',
          markedAt: operation.phase.leaseExpiresAt,
        },
      },
    })
  })

  test(`${name}: marks exhausted recovery only at the deadline or transfer limit`, async () => {
    const beforeDeadlineTarget = makeTarget()
    const deadlineKey = {
      namespace: `${name}:operation-recovery-deadline`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const deadlineAcquired = await acquireRefreshOperation(
      beforeDeadlineTarget,
      deadlineKey,
      'recovery-deadline',
    )
    const deadlineOperation = deadlineAcquired.operation
    if (deadlineOperation.phase._tag !== 'OwnedBeforeDispatch') {
      throw new Error('Expected pre-dispatch ownership')
    }
    const deadlineInput = {
      _tag: 'MarkCredentialOperationIntervention' as const,
      key: deadlineKey,
      expectedGeneration: deadlineAcquired.generation,
      expectedRevision: deadlineAcquired.revision,
      operationId: deadlineOperation.operationId,
      ownershipFence: null,
      markedAt: deadlineOperation.recoveryDeadline,
      reason: 'RecoveryLimitExceeded' as const,
    }

    expect(
      await beforeDeadlineTarget.run(
        beforeDeadlineTarget.store.executeCredentialOperation(
          await withRequest(
            { ...deadlineInput, markedAt: deadlineOperation.recoveryDeadline - 1 },
            'intervene:recovery-not-exhausted',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const deadlineCommand = await withRequest(deadlineInput, 'intervene:recovery-deadline')
    const deadlineMarked = await beforeDeadlineTarget.run(
      beforeDeadlineTarget.store.executeCredentialOperation(deadlineCommand),
    )
    expect(deadlineMarked).toEqual({
      _tag: 'CredentialOperationInterventionMarked',
      generation: deadlineAcquired.generation,
      revision: deadlineAcquired.revision + 1,
    })
    expect(
      await beforeDeadlineTarget.run(
        beforeDeadlineTarget.store.executeCredentialOperation(deadlineCommand),
      ),
    ).toEqual(deadlineMarked)

    const transferTarget = makeTarget()
    const transferKey = {
      namespace: `${name}:operation-recovery-transfer-limit`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const transferAcquired = await acquireRefreshOperation(
      transferTarget,
      transferKey,
      'recovery-transfer-limit',
      { transferLimit: 0 },
    )
    const transferOperation = transferAcquired.operation
    if (transferOperation.phase._tag !== 'OwnedBeforeDispatch') {
      throw new Error('Expected pre-dispatch ownership')
    }
    expect(transferOperation).toMatchObject({ transferCount: 0, transferLimit: 0 })
    const transferCommand = await withRequest(
      {
        _tag: 'MarkCredentialOperationIntervention' as const,
        key: transferKey,
        expectedGeneration: transferAcquired.generation,
        expectedRevision: transferAcquired.revision,
        operationId: transferOperation.operationId,
        ownershipFence: null,
        markedAt: transferOperation.startedAt + 1,
        reason: 'RecoveryLimitExceeded' as const,
      },
      'intervene:recovery-transfer-limit',
    )
    const transferMarked = await transferTarget.run(
      transferTarget.store.executeCredentialOperation(transferCommand),
    )
    expect(transferMarked).toEqual({
      _tag: 'CredentialOperationInterventionMarked',
      generation: transferAcquired.generation,
      revision: transferAcquired.revision + 1,
    })
    expect(
      await transferTarget.run(transferTarget.store.executeCredentialOperation(transferCommand)),
    ).toEqual(transferMarked)
  })

  test(`${name}: fences dispatch and completion and keeps completion receipts immutable`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:operation-completion`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    await authorizeConnection(target, key)
    const before = await target.run(target.store.readConnection(key))
    if (before === null) throw new Error('Expected an authorized connection')
    const acquisition = await withRequest(
      acquisitionInput(key, before.revision, 'owner'),
      'acquire',
    )
    const acquired = await target.run(target.store.executeCredentialOperation(acquisition))
    if (acquired._tag !== 'CredentialOperationAcquired') {
      throw new Error('Expected operation acquisition')
    }
    const operation = acquired.operation
    if (operation.phase._tag !== 'OwnedBeforeDispatch') {
      throw new Error('Expected pre-dispatch ownership')
    }
    const reservationInput = {
      _tag: 'ReserveCredentialOperationDispatch' as const,
      key,
      expectedGeneration: acquired.generation,
      expectedRevision: acquired.revision,
      operationId: operation.operationId,
      ownershipFence: operation.phase.ownershipFence,
      reservedAt: 2_050,
    }
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            { ...reservationInput, expectedRevision: acquired.revision - 1 },
            'reserve:stale-revision',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const reservation = await withRequest(reservationInput, 'reserve')
    const reserved = await target.run(target.store.executeCredentialOperation(reservation))
    if (reserved._tag !== 'CredentialOperationDispatchReserved') {
      throw new Error('Expected dispatch reservation')
    }

    const completionInput = {
      _tag: 'CompleteCredentialOperation' as const,
      key,
      expectedGeneration: reserved.generation,
      expectedRevision: reserved.revision,
      operationId: operation.operationId,
      ownershipFence: operation.phase.ownershipFence,
      credentialEnvelope: { ...protectedVerifier, ciphertext: 'BBBBBBBBBBBBBBBBBBBBBB==' },
      credentialExpiresAt: 10_000,
      completedAt: 2_100,
    }
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            { ...completionInput, ownershipFence: 'fence:stale' },
            'complete:stale-owner',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const completion = await withRequest(completionInput, 'complete')
    const completed = await target.run(target.store.executeCredentialOperation(completion))

    if (completed._tag !== 'CredentialOperationCompleted') {
      throw new Error('Expected operation completion')
    }
    expect(await target.run(target.store.executeCredentialOperation(completion))).toEqual(completed)
    expect(
      await target.run(
        target.store.executeCredentialOperation({
          ...completion,
          request: {
            ...completion.request,
            inputDigest: `${completion.request.inputDigest}:changed`,
          },
        }),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'RequestIdReused' })
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(completionInput, 'complete:fresh-stale'),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    const removed = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(
          {
            _tag: 'RemoveConnection' as const,
            key,
            expectedGeneration: completed.generation,
            expectedRevision: completed.revision,
            removedAt: 2_200,
          },
          'remove-after-completion',
        ),
      ),
    )
    expect(removed).toMatchObject({ _tag: 'ConnectionRemoved' })
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'RemoveConnection' as const,
              key,
              expectedGeneration: completed.generation,
              expectedRevision: completed.revision,
              removedAt: 2_200,
            },
            'remove-after-completion',
          ),
        ),
      ),
    ).toEqual(removed)
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'RemoveConnection' as const,
              key,
              expectedGeneration: completed.generation,
              expectedRevision: completed.revision,
              removedAt: 2_200,
            },
            'remove-after-completion:fresh',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    expect(await target.run(target.store.executeCredentialOperation(completion))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
  })

  test(`${name}: removal invalidates a prepared initial browser enrollment`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:remove-initial-browser`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const prepared = attempt(key, 'state:removed-enrollment')
    await target.run(
      target.store.execute(
        await withRequest(
          { _tag: 'CreateAuthorizationAttempt' as const, attempt: prepared },
          'prepare',
        ),
      ),
    )
    const removal = await withRequest(
      {
        _tag: 'RemoveConnection' as const,
        key,
        expectedGeneration: 0,
        expectedRevision: 1,
        removedAt: 1_500,
      },
      'remove',
    )
    const removed = await target.run(target.store.executeCredentialOperation(removal))
    expect(removed).toEqual({ _tag: 'ConnectionRemoved', generation: 1, revision: 2 })
    expect(await target.run(target.store.executeCredentialOperation(removal))).toEqual(removed)
    expect(
      await target.run(
        target.store.readAuthorizationAttempt({
          namespace: key.namespace,
          stateDigest: prepared.stateDigest,
          bindingDigest: prepared.bindingDigest,
          now: 1_600,
        }),
      ),
    ).toBeNull()
    expect(
      await target.run(
        target.store.execute(
          await withRequest(
            admissionInput({
              stateDigest: prepared.stateDigest,
              key,
              intent: 'enroll',
              generation: 0,
              admissionId: 'stale-admission',
              admittedAt: 1_600,
              admissionExpiresAt: 31_600,
            }),
            'stale-admission',
          ),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    await authorizeConnection(target, key, { generation: 1, sequence: 'fresh', startedAt: 3_000 })
    const fresh = await target.run(target.store.readConnection(key))
    expect(fresh).toMatchObject({ generation: 1, authorization: { _tag: 'Authorized' } })
    expect(await target.run(target.store.executeCredentialOperation(removal))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
    expect(await target.run(target.store.readConnection(key))).toEqual(fresh)
  })

  test.each([false, true])(
    `${name}: removal fences initial Self Client enrollment before and after dispatch, dispatched: %s`,
    async (dispatched) => {
      const target = makeTarget()
      const key = {
        namespace: `${name}:remove-initial-self-client:${dispatched}`,
        providerId: 'zoho',
        connectionId: 'connection',
      }
      const { result: admitted } = await admitSelfClientExchange(target, key, {
        intent: 'enroll',
        generation: 0,
        revision: 0,
        operationId: 'removed-exchange',
        ownershipFence: 'removed-fence',
        acquiredAt: 1_000,
      })
      const revision = dispatched
        ? (await reserveSelfClientDispatch(target, key, admitted, 1_010)).revision
        : admitted.revision
      const removed = await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'RemoveConnection' as const,
              key,
              expectedGeneration: admitted.generation,
              expectedRevision: revision,
              removedAt: 1_020,
            },
            'remove',
          ),
        ),
      )
      expect(removed).toEqual({
        _tag: 'ConnectionRemoved',
        generation: 1,
        revision: revision + 1,
      })
      expect(await target.run(target.store.readConnection(key))).toMatchObject({
        authorization: { _tag: 'NotAuthorized' },
        credentialEnvelope: null,
        credentialOperation: null,
      })
      const late = await completeSelfClientExchange(target, key, admitted, revision, 1_030, 'late')
      expect(late.result).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
      const fresh = await admitSelfClientExchange(target, key, {
        intent: 'enroll',
        generation: 1,
        revision: revision + 1,
        operationId: 'fresh-exchange',
        ownershipFence: 'fresh-fence',
        acquiredAt: 2_000,
      })
      const reserved = await reserveSelfClientDispatch(target, key, fresh.result, 2_010)
      const completed = await completeSelfClientExchange(
        target,
        key,
        fresh.result,
        reserved.revision,
        2_020,
        'fresh-completion',
      )
      expect(completed.result._tag).toBe('SelfClientExchangeCompleted')
      const saved = await target.run(target.store.readConnection(key))
      expect(saved).toMatchObject({ generation: 1, authorization: { _tag: 'Authorized' } })
      expect(await target.run(target.store.executeCredentialOperation(late.command))).toEqual({
        _tag: 'StoreConflict',
        reason: 'ConditionChanged',
      })
      expect(await target.run(target.store.readConnection(key))).toEqual(saved)
    },
  )

  test(`${name}: removal tombstone fences stale work across deliberate reenrollment`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:removal-tombstone`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    await authorizeConnection(target, key)
    const authorized = await target.run(target.store.readConnection(key))
    if (authorized === null) throw new Error('Expected an authorized connection')

    const acquired = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(acquisitionInput(key, authorized.revision, 'removed-owner'), 'acquire'),
      ),
    )
    if (
      acquired._tag !== 'CredentialOperationAcquired' ||
      acquired.operation.phase._tag !== 'OwnedBeforeDispatch'
    ) {
      throw new Error('Expected operation acquisition')
    }
    const reserved = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(
          {
            _tag: 'ReserveCredentialOperationDispatch' as const,
            key,
            expectedGeneration: acquired.generation,
            expectedRevision: acquired.revision,
            operationId: acquired.operation.operationId,
            ownershipFence: acquired.operation.phase.ownershipFence,
            reservedAt: 2_050,
          },
          'reserve',
        ),
      ),
    )
    if (reserved._tag !== 'CredentialOperationDispatchReserved') {
      throw new Error('Expected dispatch reservation')
    }
    const lateCompletionInput = {
      _tag: 'CompleteCredentialOperation' as const,
      key,
      expectedGeneration: reserved.generation,
      expectedRevision: reserved.revision,
      operationId: acquired.operation.operationId,
      ownershipFence: acquired.operation.phase.ownershipFence,
      credentialEnvelope: { ...protectedVerifier, ciphertext: 'BBBBBBBBBBBBBBBBBBBBBB==' },
      credentialExpiresAt: 10_000,
      completedAt: 2_100,
    }
    const removal = await withRequest(
      {
        _tag: 'RemoveConnection' as const,
        key,
        expectedGeneration: reserved.generation,
        expectedRevision: reserved.revision,
        removedAt: 2_100,
      },
      'remove',
    )
    const removed = await target.run(target.store.executeCredentialOperation(removal))
    if (removed._tag !== 'ConnectionRemoved') throw new Error('Expected connection removal')

    expect(await target.run(target.store.readConnection(key))).toMatchObject({
      generation: removed.generation,
      revision: removed.revision,
      authorization: { _tag: 'NotAuthorized' },
      credentialEnvelope: null,
      credentialOperation: null,
    })
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(lateCompletionInput, 'late-completion:removed'),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })

    const reenrolledEnvelope = {
      ...protectedVerifier,
      ciphertext: 'CCCCCCCCCCCCCCCCCCCCCC==',
    }
    await authorizeConnection(target, key, {
      generation: removed.generation,
      sequence: 'reenrollment',
      startedAt: 3_000,
      credentialEnvelope: reenrolledEnvelope,
      credentialExpiresAt: 20_000,
    })
    const reenrolled = await target.run(target.store.readConnection(key))
    expect(reenrolled).toMatchObject({
      generation: removed.generation,
      authorization: { _tag: 'Authorized', credentialExpiresAt: 20_000 },
      credentialEnvelope: reenrolledEnvelope,
      credentialOperation: null,
    })

    expect(await target.run(target.store.executeCredentialOperation(removal))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
    expect(
      await target.run(
        target.store.executeCredentialOperation(
          await withRequest(lateCompletionInput, 'late-completion:reenrolled'),
        ),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    expect(await target.run(target.store.readConnection(key))).toEqual(reenrolled)
  })

  test(`${name}: pruned receipts cannot replay acquisition, reservation, completion, admission, or removal`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:operation-pruning`,
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const authorizationAttempt = attempt(key, 'state:pruning')
    await target.run(
      target.store.execute(
        await withRequest(
          { _tag: 'CreateAuthorizationAttempt' as const, attempt: authorizationAttempt },
          'prune:create',
        ),
      ),
    )
    const admission = {
      stateDigest: authorizationAttempt.stateDigest,
      key,
      intent: 'enroll' as const,
      generation: 0,
      admissionId: 'prune:admission',
      admittedAt: 1_500,
      admissionExpiresAt: 31_500,
    }
    const admissionCommand = await withRequest(admissionInput(admission), 'prune:admit')
    const admitted = await target.run(target.store.execute(admissionCommand))
    if (
      admitted._tag !== 'AuthorizationAttemptAdmitted' ||
      admitted.operation.phase._tag !== 'OwnedBeforeDispatch'
    ) {
      throw new Error('Expected authorization admission')
    }
    const authorizationReservation = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(
          {
            _tag: 'ReserveCredentialOperationDispatch' as const,
            key,
            expectedGeneration: admitted.generation,
            expectedRevision: admitted.revision,
            operationId: admitted.operation.operationId,
            ownershipFence: admitted.operation.phase.ownershipFence,
            reservedAt: 1_550,
          },
          'prune:authorize-reserve',
        ),
      ),
    )
    if (authorizationReservation._tag !== 'CredentialOperationDispatchReserved') {
      throw new Error('Expected authorization reservation')
    }
    await target.run(
      target.store.execute(
        await withRequest(
          {
            _tag: 'CompleteAuthorizationAttempt' as const,
            admission,
            expectedRevision: authorizationReservation.revision,
            operationId: admitted.operation.operationId,
            ownershipFence: admitted.operation.phase.ownershipFence,
            credentialEnvelope: protectedVerifier,
            credentialExpiresAt: 0,
            completedAt: 1_600,
          },
          'prune:authorize',
        ),
      ),
    )
    const authorized = await target.run(target.store.readConnection(key))
    if (authorized === null) throw new Error('Expected an authorized connection')
    const acquisition = await withRequest(
      acquisitionInput(key, authorized.revision, 'pruning'),
      'prune:acquire',
    )
    const acquired = await target.run(target.store.executeCredentialOperation(acquisition))
    if (
      acquired._tag !== 'CredentialOperationAcquired' ||
      acquired.operation.phase._tag !== 'OwnedBeforeDispatch'
    ) {
      throw new Error('Expected operation acquisition')
    }
    const reservation = await withRequest(
      {
        _tag: 'ReserveCredentialOperationDispatch' as const,
        key,
        expectedGeneration: acquired.generation,
        expectedRevision: acquired.revision,
        operationId: acquired.operation.operationId,
        ownershipFence: acquired.operation.phase.ownershipFence,
        reservedAt: 2_050,
      },
      'prune:reserve',
    )
    const reserved = await target.run(target.store.executeCredentialOperation(reservation))
    if (reserved._tag !== 'CredentialOperationDispatchReserved') {
      throw new Error('Expected dispatch reservation')
    }
    const completion = await withRequest(
      {
        _tag: 'CompleteCredentialOperation' as const,
        key,
        expectedGeneration: reserved.generation,
        expectedRevision: reserved.revision,
        operationId: acquired.operation.operationId,
        ownershipFence: acquired.operation.phase.ownershipFence,
        credentialEnvelope: protectedVerifier,
        credentialExpiresAt: 10_000,
        completedAt: 2_100,
      },
      'prune:complete',
    )
    const completed = await target.run(target.store.executeCredentialOperation(completion))
    if (completed._tag !== 'CredentialOperationCompleted') {
      throw new Error('Expected operation completion')
    }
    const removal = await withRequest(
      {
        _tag: 'RemoveConnection' as const,
        key,
        expectedGeneration: completed.generation,
        expectedRevision: completed.revision,
        removedAt: 2_200,
      },
      'prune:remove',
    )
    await target.run(target.store.executeCredentialOperation(removal))
    await target.pruneReceipts()

    expect(await target.run(target.store.execute(admissionCommand))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
    for (const command of [acquisition, reservation, completion, removal]) {
      expect(await target.run(target.store.executeCredentialOperation(command))).toEqual({
        _tag: 'StoreConflict',
        reason: 'ConditionChanged',
      })
    }
  })

  test(`${name}: conditionally invalidates only the observed credential revision`, async () => {
    const target = makeTarget()
    const key = {
      namespace: `${name}:credential-invalidation`,
      providerId: 'client-credentials',
      connectionId: 'connection',
    }
    const saved = await target.run(
      target.store.executeCredentialOperation(
        await withRequest(
          {
            _tag: 'SaveCredential' as const,
            key,
            expectedGeneration: 0,
            expectedRevision: 0,
            intent: 'enroll' as const,
            credentialEnvelope: protectedVerifier,
            credentialExpiresAt: null,
            credentialAcquiredAt: 1_000,
          },
          'save',
        ),
      ),
    )
    if (saved._tag !== 'CredentialSaved') throw new Error('Expected saved credential')

    const invalidation = await withRequest(
      {
        _tag: 'InvalidateCredential' as const,
        key,
        expectedGeneration: saved.generation,
        expectedRevision: saved.revision,
      },
      'invalidate',
    )
    expect(await target.run(target.store.executeCredentialOperation(invalidation))).toEqual({
      _tag: 'CredentialInvalidated',
      generation: saved.generation,
      revision: saved.revision + 1,
    })
    expect(await target.run(target.store.executeCredentialOperation(invalidation))).toEqual({
      _tag: 'CredentialInvalidated',
      generation: saved.generation,
      revision: saved.revision + 1,
    })

    const staleRevision = await withRequest(
      {
        _tag: 'InvalidateCredential' as const,
        key,
        expectedGeneration: saved.generation,
        expectedRevision: saved.revision,
      },
      'stale-invalidate-revision',
    )
    expect(await target.run(target.store.executeCredentialOperation(staleRevision))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
    const staleGeneration = await withRequest(
      {
        _tag: 'InvalidateCredential' as const,
        key,
        expectedGeneration: saved.generation + 1,
        expectedRevision: saved.revision + 1,
      },
      'stale-invalidate-generation',
    )
    expect(await target.run(target.store.executeCredentialOperation(staleGeneration))).toEqual({
      _tag: 'StoreConflict',
      reason: 'ConditionChanged',
    })
    expect(
      await target.run(
        target.store.executeCredentialOperation({
          ...invalidation,
          request: {
            ...invalidation.request,
            inputDigest: `${invalidation.request.inputDigest}:conflict`,
          },
        }),
      ),
    ).toEqual({ _tag: 'StoreConflict', reason: 'RequestIdReused' })
    const snapshot = await target.run(target.store.readConnection(key))
    expect(snapshot?.authorization).toMatchObject({
      _tag: 'Authorized',
      credentialExpiresAt: 0,
      credentialAcquiredAt: 1_000,
    })
  })

  test(`${name}: replacement supersedes pending, failed, and intervention-required acquisition`, async () => {
    for (const terminal of ['pending', 'failed', 'intervention'] as const) {
      const target = makeTarget()
      const key = {
        namespace: `${name}:replacement-${terminal}`,
        providerId: 'client-credentials',
        connectionId: 'connection',
      }
      const saved = await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              _tag: 'SaveCredential' as const,
              key,
              expectedGeneration: 0,
              expectedRevision: 0,
              intent: 'enroll' as const,
              credentialEnvelope: protectedVerifier,
              credentialExpiresAt: null,
              credentialAcquiredAt: null,
            },
            `save:${terminal}`,
          ),
        ),
      )
      if (saved._tag !== 'CredentialSaved') throw new Error('Expected source credential enrollment')
      const acquisition = acquisitionInput(key, saved.revision, terminal)
      const acquired = await target.run(
        target.store.executeCredentialOperation(
          await withRequest(
            {
              ...acquisition,
              proposal: {
                ...acquisition.proposal,
                kind: 'client-credentials-acquisition' as const,
              },
            },
            `acquire:${terminal}`,
          ),
        ),
      )
      if (
        acquired._tag !== 'CredentialOperationAcquired' ||
        acquired.operation.phase._tag !== 'OwnedBeforeDispatch'
      ) {
        throw new Error('Expected acquisition ownership')
      }

      let replacementRevision = acquired.revision
      if (terminal !== 'pending') {
        const reserved = await reserveRefreshDispatch(target, key, acquired)
        const terminalResult = await target.run(
          target.store.executeCredentialOperation(
            await withRequest(
              terminal === 'failed'
                ? {
                    _tag: 'RecordCredentialOperationFailure' as const,
                    key,
                    expectedGeneration: reserved.generation,
                    expectedRevision: reserved.revision,
                    operationId: acquired.operation.operationId,
                    ownershipFence: acquired.operation.phase.ownershipFence,
                    failedAt: 2_100,
                    reason: 'ProviderFailure' as const,
                  }
                : {
                    _tag: 'MarkCredentialOperationIntervention' as const,
                    key,
                    expectedGeneration: reserved.generation,
                    expectedRevision: reserved.revision,
                    operationId: acquired.operation.operationId,
                    ownershipFence: acquired.operation.phase.ownershipFence,
                    markedAt: 2_100,
                    reason: 'ProviderOutcomeUnknown' as const,
                  },
              `terminal:${terminal}`,
            ),
          ),
        )
        if (
          terminalResult._tag !== 'CredentialOperationFailed' &&
          terminalResult._tag !== 'CredentialOperationInterventionMarked'
        ) {
          throw new Error('Expected terminal acquisition state')
        }
        replacementRevision = terminalResult.revision
      }

      const replacement = await withRequest(
        {
          _tag: 'SaveCredential' as const,
          key,
          expectedGeneration: saved.generation,
          expectedRevision: replacementRevision,
          intent: 'replace' as const,
          credentialEnvelope: { ...protectedVerifier, ciphertext: `replacement:${terminal}` },
          credentialExpiresAt: null,
          credentialAcquiredAt: null,
        },
        `replace:${terminal}`,
      )
      expect(await target.run(target.store.executeCredentialOperation(replacement))).toEqual({
        _tag: 'CredentialSaved',
        generation: saved.generation + 1,
        revision: replacementRevision + 1,
      })
      expect(await target.run(target.store.executeCredentialOperation(replacement))).toEqual({
        _tag: 'CredentialSaved',
        generation: saved.generation + 1,
        revision: replacementRevision + 1,
      })
      expect(await target.run(target.store.readConnection(key))).toMatchObject({
        generation: saved.generation + 1,
        revision: replacementRevision + 1,
        credentialOperation: null,
      })
    }
  })
}
