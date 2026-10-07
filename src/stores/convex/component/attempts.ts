import { v } from 'convex/values'
import { mutation, query } from './_generated/server.js'
import {
  authorizationAdmissionValidator,
  authorizationAttemptValidator,
  commandResultValidator,
  connectionKeyValidator,
  credentialEnvelopeValidator,
  credentialOperationProposalValidator,
} from './schema.js'
import { executeStoreCommand, readAuthorizationAttempt } from './persistence.js'

const requestValidator = v.object({ requestId: v.string(), inputDigest: v.string() })

export const read = query({
  args: {
    lookup: v.object({
      namespace: v.string(),
      stateDigest: v.string(),
      bindingDigest: v.string(),
      now: v.number(),
    }),
  },
  returns: v.union(authorizationAttemptValidator, v.null()),
  handler: (ctx, { lookup }) => readAuthorizationAttempt(ctx, lookup),
})

export const create = mutation({
  args: {
    request: requestValidator,
    attempt: authorizationAttemptValidator,
  },
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeStoreCommand(ctx, { _tag: 'CreateAuthorizationAttempt', ...input }),
})

export const admit = mutation({
  args: {
    request: requestValidator,
    admission: authorizationAdmissionValidator,
    ownershipFence: v.string(),
    leaseExpiresAt: v.number(),
    operation: credentialOperationProposalValidator,
  },
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeStoreCommand(ctx, { _tag: 'AdmitAuthorizationAttempt', ...input }),
})

export const close = mutation({
  args: {
    request: requestValidator,
    stateDigest: v.string(),
    key: connectionKeyValidator,
    expectedGeneration: v.number(),
    closedAt: v.number(),
    reason: v.literal('ProviderDenied'),
  },
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeStoreCommand(ctx, { _tag: 'CloseAuthorizationAttempt', ...input }),
})

export const complete = mutation({
  args: {
    request: requestValidator,
    admission: authorizationAdmissionValidator,
    expectedRevision: v.number(),
    operationId: v.string(),
    ownershipFence: v.string(),
    credentialEnvelope: credentialEnvelopeValidator,
    credentialExpiresAt: v.union(v.number(), v.null()),
    completedAt: v.number(),
  },
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeStoreCommand(ctx, { _tag: 'CompleteAuthorizationAttempt', ...input }),
})
