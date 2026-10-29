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
  transitionRecordKeys,
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
  const { key } = transitionRecordKeys(command)
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
  const selection = transitionRecordKeys(command, connection)
  const attempt =
    selection.attempt === null
      ? null
      : attemptRecord(
          await attemptRow(ctx, selection.attempt.namespace, selection.attempt.stateDigest),
        )
  const selectedAttempt =
    selection.selectedAttempt === null
      ? null
      : attemptRecord(
          await attemptRow(
            ctx,
            selection.selectedAttempt.namespace,
            selection.selectedAttempt.stateDigest,
          ),
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
    const { key } = transitionRecordKeys(command)
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
