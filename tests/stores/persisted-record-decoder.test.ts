import { expect, test } from 'vitest'
import {
  decodeConnectionJson,
  decodeReceipt,
} from '../../src/stores/internal/persisted-record-decoder.js'

test('decodes an older authorized record without acquisition metadata', () => {
  const record = decodeConnectionJson(
    JSON.stringify({
      schemaVersion: 1,
      key: { namespace: 'test', providerId: 'provider', connectionId: 'connection' },
      generation: 0,
      revision: 1,
      authorization: { _tag: 'Authorized', credentialExpiresAt: null },
      credentialEnvelope: {
        version: 1,
        algorithm: 'AES-256-GCM',
        keyId: 'key',
        iv: 'iv',
        ciphertext: 'ciphertext',
      },
      credentialOperation: null,
      authorizationAttemptStateDigest: null,
    }),
  )
  expect(record.authorization).toEqual({
    _tag: 'Authorized',
    credentialExpiresAt: null,
    credentialAcquiredAt: null,
  })
})

function failedConnection(
  recovery?: unknown,
  reason = 'ProviderFailure',
  kind = 'refresh',
  replayUntil?: unknown,
) {
  return JSON.stringify({
    schemaVersion: 1,
    key: { namespace: 'test', providerId: 'provider', connectionId: 'connection' },
    generation: 0,
    revision: 4,
    authorization: { _tag: 'Authorized', credentialExpiresAt: 0 },
    credentialEnvelope: {
      version: 1,
      algorithm: 'AES-256-GCM',
      keyId: 'key',
      iv: 'iv',
      ciphertext: 'ciphertext',
    },
    credentialOperation: {
      schemaVersion: 1,
      operationId: 'failed-operation',
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
    },
    authorizationAttemptStateDigest: null,
  })
}

test('preserves old known failures without inventing no-dispatch evidence', () => {
  expect(decodeConnectionJson(failedConnection()).credentialOperation?.phase).toEqual({
    _tag: 'KnownFailure',
    reason: 'ProviderFailure',
    failedAt: 1_100,
  })
})

test('preserves explicit no-dispatch evidence across persistence decoding', () => {
  expect(
    decodeConnectionJson(failedConnection('NotDispatched')).credentialOperation?.phase,
  ).toEqual({
    _tag: 'KnownFailure',
    reason: 'ProviderFailure',
    failedAt: 1_100,
    recovery: 'NotDispatched',
  })
})

test('decodes bounded replay evidence without losing the retained window', () => {
  const recovery = { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 }
  expect(
    decodeConnectionJson(failedConnection(recovery, 'ProviderFailure', 'refresh', 5_000))
      .credentialOperation,
  ).toMatchObject({ replayUntil: 5_000, phase: { recovery } })
})

test.each([
  [
    { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 },
    undefined,
    'ProviderFailure',
    'refresh',
  ],
  [{ _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 }, 6_000, 'ProviderFailure', 'refresh'],
  [{ _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 6_000 }, 5_000, 'ProviderFailure', 'refresh'],
  [{ _tag: 'ReplaySafe', retryUntil: 1_000, retryAt: 1_000 }, 1_000, 'ProviderFailure', 'refresh'],
  [{ _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: -1 }, 5_000, 'ProviderFailure', 'refresh'],
  [{ _tag: 'ReplaySafe', retryUntil: null, retryAt: 1_200 }, 5_000, 'ProviderFailure', 'refresh'],
  [{ _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 }, 5_000, 'ProviderRejected', 'refresh'],
  [
    { _tag: 'ReplaySafe', retryUntil: 5_000, retryAt: 1_200 },
    5_000,
    'ProviderFailure',
    'client-credentials-acquisition',
  ],
])(
  'rejects malformed or mismatched bounded replay evidence %j',
  (recovery, replayUntil, reason, kind) => {
    expect(() =>
      decodeConnectionJson(failedConnection(recovery, String(reason), String(kind), replayUntil)),
    ).toThrow('Invalid persisted record')
  },
)

test.each([
  ['ReplaySafe', 'ProviderFailure', 'refresh'],
  [true, 'ProviderFailure', 'refresh'],
  ['NotDispatched', 'ProviderRejected', 'refresh'],
  ['NotDispatched', 'ProviderFailure', 'authorization-exchange'],
])('rejects invalid recovery evidence %s for %s in %s', (recovery, reason, kind) => {
  expect(() =>
    decodeConnectionJson(failedConnection(recovery, String(reason), String(kind))),
  ).toThrow('Invalid persisted record')
})

test('rejects malformed acquisition metadata', () => {
  expect(() =>
    decodeConnectionJson(
      JSON.stringify({
        schemaVersion: 1,
        key: { namespace: 'test', providerId: 'provider', connectionId: 'connection' },
        generation: 0,
        revision: 1,
        authorization: {
          _tag: 'Authorized',
          credentialExpiresAt: null,
          credentialAcquiredAt: 'not-a-time',
        },
        credentialEnvelope: {
          version: 1,
          algorithm: 'AES-256-GCM',
          keyId: 'key',
          iv: 'iv',
          ciphertext: 'ciphertext',
        },
        credentialOperation: null,
        authorizationAttemptStateDigest: null,
      }),
    ),
  ).toThrow('Invalid persisted record')
})

test('decodes client-credentials acquisition operations and invalidation receipts', () => {
  const operation = {
    schemaVersion: 1,
    operationId: 'acquisition',
    kind: 'client-credentials-acquisition',
    generation: 0,
    observedRevision: 1,
    startedAt: 1_000,
    recoveryDeadline: 2_000,
    transferCount: 0,
    transferLimit: 1,
    phase: { _tag: 'OwnedBeforeDispatch', ownershipFence: 'owner', leaseExpiresAt: 1_100 },
  }
  const connection = decodeConnectionJson(
    JSON.stringify({
      schemaVersion: 1,
      key: { namespace: 'test', providerId: 'provider', connectionId: 'connection' },
      generation: 0,
      revision: 2,
      authorization: { _tag: 'Authorized', credentialExpiresAt: null, credentialAcquiredAt: null },
      credentialEnvelope: {
        version: 1,
        algorithm: 'AES-256-GCM',
        keyId: 'key',
        iv: 'iv',
        ciphertext: 'ciphertext',
      },
      credentialOperation: operation,
      authorizationAttemptStateDigest: null,
    }),
  )
  expect(connection.credentialOperation).toEqual(operation)
  expect(
    decodeReceipt(
      'InvalidateCredential',
      'digest',
      JSON.stringify({
        _tag: 'CredentialInvalidated',
        generation: 0,
        revision: 3,
      }),
    ),
  ).toEqual({
    commandKind: 'InvalidateCredential',
    inputDigest: 'digest',
    result: { _tag: 'CredentialInvalidated', generation: 0, revision: 3 },
  })
})

test('decodes Self Client operation intent and dedicated command receipts', () => {
  const connection = decodeConnectionJson(
    JSON.stringify({
      schemaVersion: 1,
      key: { namespace: 'test', providerId: 'zoho-self-client', connectionId: 'connection' },
      generation: 0,
      revision: 1,
      authorization: { _tag: 'NotAuthorized' },
      credentialEnvelope: null,
      credentialOperation: {
        schemaVersion: 1,
        operationId: 'self-client-exchange',
        kind: 'self-client-exchange',
        intent: 'enroll',
        generation: 0,
        observedRevision: 0,
        startedAt: 1_000,
        recoveryDeadline: 2_000,
        transferCount: 0,
        transferLimit: 1,
        phase: { _tag: 'InterventionRequired', reason: 'ProviderOutcomeUnknown', markedAt: 1_500 },
      },
      authorizationAttemptStateDigest: null,
    }),
  )
  expect(connection.credentialOperation).toMatchObject({
    kind: 'self-client-exchange',
    intent: 'enroll',
    phase: { _tag: 'InterventionRequired', reason: 'ProviderOutcomeUnknown' },
  })
  expect(
    decodeReceipt(
      'AdmitSelfClientExchange',
      'digest',
      JSON.stringify({
        _tag: 'SelfClientExchangeAdmitted',
        generation: 0,
        revision: 1,
        operation: connection.credentialOperation,
      }),
    ),
  ).toMatchObject({
    commandKind: 'AdmitSelfClientExchange',
    result: { _tag: 'SelfClientExchangeAdmitted', revision: 1 },
  })
  expect(
    decodeReceipt(
      'CompleteSelfClientExchange',
      'completion-digest',
      JSON.stringify({ _tag: 'SelfClientExchangeCompleted', generation: 0, revision: 3 }),
    ),
  ).toEqual({
    commandKind: 'CompleteSelfClientExchange',
    inputDigest: 'completion-digest',
    result: { _tag: 'SelfClientExchangeCompleted', generation: 0, revision: 3 },
  })
})

test('rejects Self Client operations without a valid intent', () => {
  expect(() =>
    decodeConnectionJson(
      JSON.stringify({
        schemaVersion: 1,
        key: { namespace: 'test', providerId: 'zoho-self-client', connectionId: 'connection' },
        generation: 0,
        revision: 1,
        authorization: { _tag: 'NotAuthorized' },
        credentialEnvelope: null,
        credentialOperation: {
          schemaVersion: 1,
          operationId: 'self-client-exchange',
          kind: 'self-client-exchange',
          generation: 0,
          observedRevision: 0,
          startedAt: 1_000,
          recoveryDeadline: 2_000,
          transferCount: 0,
          transferLimit: 1,
          phase: { _tag: 'OwnedBeforeDispatch', ownershipFence: 'owner', leaseExpiresAt: 1_100 },
        },
        authorizationAttemptStateDigest: null,
      }),
    ),
  ).toThrow('Invalid persisted record')
})

test('rejects malformed client-credentials operation and receipt metadata', () => {
  expect(() =>
    decodeConnectionJson(
      JSON.stringify({
        schemaVersion: 1,
        key: { namespace: 'test', providerId: 'provider', connectionId: 'connection' },
        generation: 0,
        revision: 2,
        authorization: { _tag: 'Authorized', credentialExpiresAt: null },
        credentialEnvelope: {
          version: 1,
          algorithm: 'AES-256-GCM',
          keyId: 'key',
          iv: 'iv',
          ciphertext: 'ciphertext',
        },
        credentialOperation: {
          schemaVersion: 1,
          operationId: 'bad',
          kind: 'client-credentials-acquisition',
          generation: 0,
          observedRevision: 1,
          startedAt: 1_000,
          recoveryDeadline: 2_000,
          transferCount: 2,
          transferLimit: 1,
          phase: { _tag: 'OwnedBeforeDispatch', ownershipFence: 'owner', leaseExpiresAt: 1_100 },
        },
        authorizationAttemptStateDigest: null,
      }),
    ),
  ).toThrow('Invalid persisted record')
  expect(() =>
    decodeReceipt(
      'InvalidateCredential',
      'digest',
      JSON.stringify({
        _tag: 'CredentialSaved',
        generation: 0,
        revision: 3,
      }),
    ),
  ).toThrow('Invalid persisted record')
})
