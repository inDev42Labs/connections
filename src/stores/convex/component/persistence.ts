// eslint-disable-next-line no-restricted-imports -- This is the sole Convex bridge to shared store contracts.
import type {
  AuthorizationAttemptLookup,
  ConnectionKey,
  CredentialOperationCommand,
  StoreCommand,
  StoreCommandResult,
} from '../../../core/contracts/store.js'
// eslint-disable-next-line no-restricted-imports -- This bridge deliberately executes the shared lifecycle kernel.
import {
  projectAuthorizationAttempt,
  projectConnectionInspection,
  transitionCredentialOperation,
  transitionStoreCommand,
  type StoredAuthorizationAttempt,
  type StoredCommand,
  type StoredConnection,
  type StoredReceipt,
  type StoreTransition,
  type TransitionRecords,
} from '../../internal/transition-kernel.js'
import type { Doc } from './_generated/dataModel.js'
import type { MutationCtx, QueryCtx } from './_generated/server.js'
import { pruneExpiredPreparedAttempts, saveReceipt } from './receipts.js'

function storageKey(key: ConnectionKey): string {
  return JSON.stringify([key.namespace, key.providerId, key.connectionId])
}

function commandKey(command: StoredCommand): ConnectionKey {
  switch (command._tag) {
    case 'InitializeConnection':
    case 'CloseAuthorizationAttempt':
    case 'SaveCredential':
    case 'AdmitSelfClientExchange':
    case 'CompleteSelfClientExchange':
    case 'AcquireCredentialOperation':
    case 'ReserveCredentialOperationDispatch':
    case 'CompleteCredentialOperation':
    case 'RecordCredentialOperationFailure':
    case 'MarkCredentialOperationIntervention':
    case 'InvalidateCredential':
    case 'RemoveConnection':
      return command.key
    case 'CreateAuthorizationAttempt':
      return command.attempt.key
    case 'AdmitAuthorizationAttempt':
    case 'CompleteAuthorizationAttempt':
      return command.admission.key
  }
}

async function connectionRow(ctx: QueryCtx | MutationCtx, key: ConnectionKey) {
  return ctx.db
    .query('connections')
    .withIndex('by_storage_key', (query) => query.eq('storageKey', storageKey(key)))
    .unique()
}

async function attemptRow(ctx: QueryCtx | MutationCtx, namespace: string, stateDigest: string) {
  return ctx.db
    .query('attempts')
    .withIndex('by_namespace_state', (query) =>
      query.eq('key.namespace', namespace).eq('stateDigest', stateDigest),
    )
    .unique()
}

function connectionRecord(row: Doc<'connections'> | null): StoredConnection | null {
  if (row === null) return null
  const {
    _creationTime,
    _id,
    storageKey: _storageKey,
    authorization,
    credentialEnvelope,
    ...stored
  } = row
  if (authorization._tag === 'NotAuthorized' && credentialEnvelope === null) {
    return { ...stored, authorization, credentialEnvelope }
  }
  if (authorization._tag === 'Authorized' && credentialEnvelope !== null) {
    return {
      ...stored,
      authorization: {
        ...authorization,
        credentialAcquiredAt: authorization.credentialAcquiredAt ?? null,
      },
      credentialEnvelope,
    }
  }
  throw new TypeError('Invalid persisted connection')
}

function attemptRecord(row: Doc<'attempts'> | null): StoredAuthorizationAttempt | null {
  if (row === null) return null
  const {
    _creationTime,
    _id,
    storageKey: _storageKey,
    retentionState: _retentionState,
    state,
    closedAt,
    ...attempt
  } = row
  return { attempt, state, closedAt }
}

function receiptRecord(row: Doc<'receipts'> | null): StoredReceipt | null {
  return row === null
    ? null
    : {
        commandKind: row.commandKind,
        inputDigest: row.inputDigest,
        result: row.result,
      }
}

export async function readConnection(
  ctx: QueryCtx | MutationCtx,
  key: ConnectionKey,
): Promise<StoredConnection | null> {
  return connectionRecord(await connectionRow(ctx, key))
}

export async function inspectConnection(ctx: QueryCtx, key: ConnectionKey) {
  return projectConnectionInspection(await readConnection(ctx, key))
}

export async function readAuthorizationAttempt(ctx: QueryCtx, lookup: AuthorizationAttemptLookup) {
  const stored = attemptRecord(await attemptRow(ctx, lookup.namespace, lookup.stateDigest))
  return projectAuthorizationAttempt(
    stored,
    stored === null ? null : await readConnection(ctx, stored.attempt.key),
    lookup,
  )
}

export async function executeStoreCommand(
  ctx: MutationCtx,
  command: StoreCommand,
): Promise<StoreCommandResult> {
  const records = await transitionRecords(ctx, command)
  return commit(ctx, command, transitionStoreCommand(command, records))
}

export async function executeCredentialOperation(
  ctx: MutationCtx,
  command: CredentialOperationCommand,
): Promise<StoreCommandResult> {
  const records = await transitionRecords(ctx, command)
  return commit(ctx, command, transitionCredentialOperation(command, records))
}

async function transitionRecords(
  ctx: MutationCtx,
  command: StoredCommand,
): Promise<TransitionRecords> {
  const key = commandKey(command)
  const receiptRow = await ctx.db
    .query('receipts')
    .withIndex('by_namespace_request', (query) =>
      query.eq('namespace', key.namespace).eq('requestId', command.request.requestId),
    )
    .unique()
  if (command._tag === 'CreateAuthorizationAttempt' && receiptRow === null) {
    await pruneExpiredPreparedAttempts(ctx, command.attempt.createdAt)
  }
  const connection = await readConnection(ctx, key)
  let attempt: StoredAuthorizationAttempt | null = null
  switch (command._tag) {
    case 'CreateAuthorizationAttempt':
      attempt = attemptRecord(
        await attemptRow(ctx, command.attempt.key.namespace, command.attempt.stateDigest),
      )
      break
    case 'AdmitAuthorizationAttempt':
    case 'CompleteAuthorizationAttempt':
      attempt = attemptRecord(
        await attemptRow(ctx, command.admission.key.namespace, command.admission.stateDigest),
      )
      break
    case 'CloseAuthorizationAttempt':
      attempt = attemptRecord(await attemptRow(ctx, command.key.namespace, command.stateDigest))
      break
  }
  const selectedAttempt =
    connection?.authorizationAttemptStateDigest === null || connection === null
      ? null
      : attemptRecord(
          await attemptRow(ctx, key.namespace, connection.authorizationAttemptStateDigest),
        )
  return { connection, attempt, selectedAttempt, receipt: receiptRecord(receiptRow) }
}

async function commit(
  ctx: MutationCtx,
  command: StoredCommand,
  transition: StoreTransition,
): Promise<StoreCommandResult> {
  const { writes } = transition
  if (writes.connection !== undefined) await writeConnection(ctx, writes.connection)
  for (const stored of writes.attempts ?? []) await writeAttempt(ctx, stored)
  if (writes.receipt !== undefined) {
    const key = commandKey(command)
    await saveReceipt(ctx, {
      namespace: key.namespace,
      requestId: command.request.requestId,
      ...writes.receipt,
    })
  }
  return transition.result
}

async function writeConnection(ctx: MutationCtx, stored: StoredConnection): Promise<void> {
  const row = await connectionRow(ctx, stored.key)
  const value = { storageKey: storageKey(stored.key), ...stored }
  if (row === null) await ctx.db.insert('connections', value)
  else await ctx.db.patch(row._id, value)
}

async function writeAttempt(ctx: MutationCtx, stored: StoredAuthorizationAttempt): Promise<void> {
  const row = await attemptRow(ctx, stored.attempt.key.namespace, stored.attempt.stateDigest)
  const value = {
    ...stored.attempt,
    storageKey: storageKey(stored.attempt.key),
    state: stored.state,
    retentionState: stored.state._tag,
    closedAt: stored.closedAt,
  }
  if (row === null) await ctx.db.insert('attempts', value)
  else await ctx.db.patch(row._id, value)
}
