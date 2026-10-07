import { v } from 'convex/values'
import { mutation, query } from './_generated/server.js'
import {
  commandResultValidator,
  connectionKeyValidator,
  connectionValidator,
  credentialEnvelopeValidator,
} from './schema.js'
import {
  executeCredentialOperation,
  executeStoreCommand,
  inspectConnection,
  readConnection,
} from './persistence.js'

function storageKey(key: {
  readonly namespace: string
  readonly providerId: string
  readonly connectionId: string
}): string {
  return JSON.stringify([key.namespace, key.providerId, key.connectionId])
}

const requestValidator = v.object({ requestId: v.string(), inputDigest: v.string() })

export const read = query({
  args: { key: connectionKeyValidator },
  returns: v.union(connectionValidator, v.null()),
  handler: async (ctx, { key }) => {
    const stored = await readConnection(ctx, key)
    return stored === null ? null : { storageKey: storageKey(stored.key), ...stored }
  },
})

export const inspect = query({
  args: { key: connectionKeyValidator },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(1),
      key: connectionKeyValidator,
      savedAuthorization: v.boolean(),
      credentialWork: v.union(
        v.literal('idle'),
        v.literal('pending'),
        v.literal('intervention-required'),
        v.literal('known-failure'),
      ),
    }),
    v.null(),
  ),
  handler: (ctx, { key }) => inspectConnection(ctx, key),
})

export const saveCredential = mutation({
  args: {
    request: requestValidator,
    key: connectionKeyValidator,
    expectedGeneration: v.number(),
    expectedRevision: v.number(),
    intent: v.union(v.literal('enroll'), v.literal('replace')),
    credentialEnvelope: credentialEnvelopeValidator,
    credentialExpiresAt: v.union(v.number(), v.null()),
    credentialAcquiredAt: v.optional(v.union(v.number(), v.null())),
  },
  returns: commandResultValidator,
  handler: (ctx, input) => executeCredentialOperation(ctx, { _tag: 'SaveCredential', ...input }),
})

export const invalidateCredential = mutation({
  args: {
    request: requestValidator,
    key: connectionKeyValidator,
    expectedGeneration: v.number(),
    expectedRevision: v.number(),
  },
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeCredentialOperation(ctx, { _tag: 'InvalidateCredential', ...input }),
})

export const remove = mutation({
  args: {
    request: requestValidator,
    key: connectionKeyValidator,
    expectedGeneration: v.number(),
    expectedRevision: v.number(),
    removedAt: v.number(),
  },
  returns: commandResultValidator,
  handler: (ctx, input) => executeCredentialOperation(ctx, { _tag: 'RemoveConnection', ...input }),
})

export const initialize = mutation({
  args: {
    request: requestValidator,
    key: connectionKeyValidator,
  },
  returns: commandResultValidator,
  handler: (ctx, input) => executeStoreCommand(ctx, { _tag: 'InitializeConnection', ...input }),
})
