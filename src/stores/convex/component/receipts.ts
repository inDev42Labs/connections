import type { Infer } from 'convex/values'
import type { MutationCtx } from './_generated/server.js'
import { commandKindValidator, commandResultValidator, componentSchemaVersion } from './schema.js'

interface ReceiptWrite {
  readonly commandKind: Infer<typeof commandKindValidator>
  readonly inputDigest: string
  readonly result: Infer<typeof commandResultValidator>
}

const receiptRetentionMilliseconds = 30 * 24 * 60 * 60 * 1_000
const closedAttemptRetentionMilliseconds = 24 * 60 * 60 * 1_000
const pruningBatchSize = 16

export async function pruneExpiredPreparedAttempts(ctx: MutationCtx, now: number): Promise<void> {
  const expired = await ctx.db
    .query('attempts')
    .withIndex('by_schema_state_expiry', (query) =>
      query
        .eq('schemaVersion', componentSchemaVersion)
        .eq('retentionState', 'Prepared')
        .lt('expiresAt', now - closedAttemptRetentionMilliseconds),
    )
    .take(pruningBatchSize)
  for (const stored of expired) {
    const current = await ctx.db
      .query('connections')
      .withIndex('by_storage_key', (query) => query.eq('storageKey', stored.storageKey))
      .unique()
    if (current?.authorizationAttemptStateDigest === stored.stateDigest) {
      await ctx.db.patch(current._id, { authorizationAttemptStateDigest: null })
    }
    await ctx.db.delete(stored._id)
  }
}

async function pruneRetention(ctx: MutationCtx, now: number): Promise<void> {
  const expiredReceipts = await ctx.db
    .query('receipts')
    .withIndex('by_schema_created_at', (query) =>
      query
        .eq('schemaVersion', componentSchemaVersion)
        .lt('createdAt', now - receiptRetentionMilliseconds),
    )
    .take(pruningBatchSize)
  for (const receipt of expiredReceipts) await ctx.db.delete(receipt._id)

  const expiredClosedAttempts = await ctx.db
    .query('attempts')
    .withIndex('by_schema_state_closed_at', (query) =>
      query
        .eq('schemaVersion', componentSchemaVersion)
        .eq('retentionState', 'Closed')
        .lt('closedAt', now - closedAttemptRetentionMilliseconds),
    )
    .take(pruningBatchSize)
  for (const attempt of expiredClosedAttempts) await ctx.db.delete(attempt._id)
}

export async function saveReceipt(
  ctx: MutationCtx,
  input: {
    readonly namespace: string
    readonly requestId: string
  } & ReceiptWrite,
): Promise<void> {
  const createdAt = Date.now()
  await pruneRetention(ctx, createdAt)
  await ctx.db.insert('receipts', {
    ...input,
    schemaVersion: componentSchemaVersion,
    createdAt,
  })
}
