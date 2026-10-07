import { v } from 'convex/values'
import { mutation } from './_generated/server.js'
import {
  commandResultValidator,
  connectionKeyValidator,
  credentialEnvelopeValidator,
} from './schema.js'
import { executeCredentialOperation } from './persistence.js'

const requestValidator = v.object({ requestId: v.string(), inputDigest: v.string() })
const credentialOperationKindValidator = v.union(
  v.literal('refresh'),
  v.literal('authorization-exchange'),
  v.literal('client-credentials-acquisition'),
)
const selfClientExchangeProposalValidator = v.object({
  operationId: v.string(),
  startedAt: v.number(),
  recoveryDeadline: v.number(),
  transferLimit: v.number(),
})
const knownFailureReasonValidator = v.union(
  v.literal('ProviderRejected'),
  v.literal('ProviderFailure'),
)
const interventionReasonValidator = v.union(
  v.literal('ProviderOutcomeUnknown'),
  v.literal('KnownResponseNotPersisted'),
  v.literal('DispatchOwnerExpired'),
  v.literal('RecoveryLimitExceeded'),
)

const acquisitionArgs = {
  request: requestValidator,
  key: connectionKeyValidator,
  expectedGeneration: v.number(),
  expectedRevision: v.number(),
  acquiredAt: v.number(),
  ownershipFence: v.string(),
  leaseExpiresAt: v.number(),
  proposal: v.object({
    operationId: v.string(),
    kind: credentialOperationKindValidator,
    startedAt: v.number(),
    recoveryDeadline: v.number(),
    transferLimit: v.number(),
  }),
}

const selfClientAdmissionArgs = {
  request: requestValidator,
  key: connectionKeyValidator,
  expectedGeneration: v.number(),
  expectedRevision: v.number(),
  intent: v.union(v.literal('enroll'), v.literal('replace')),
  acquiredAt: v.number(),
  ownershipFence: v.string(),
  leaseExpiresAt: v.number(),
  proposal: selfClientExchangeProposalValidator,
}

const reservationArgs = {
  request: requestValidator,
  key: connectionKeyValidator,
  expectedGeneration: v.number(),
  expectedRevision: v.number(),
  operationId: v.string(),
  ownershipFence: v.string(),
  reservedAt: v.number(),
}

const completionArgs = {
  request: requestValidator,
  key: connectionKeyValidator,
  expectedGeneration: v.number(),
  expectedRevision: v.number(),
  operationId: v.string(),
  ownershipFence: v.string(),
  credentialEnvelope: credentialEnvelopeValidator,
  credentialExpiresAt: v.union(v.number(), v.null()),
  credentialAcquiredAt: v.optional(v.union(v.number(), v.null())),
  completedAt: v.number(),
}

const selfClientCompletionArgs = {
  request: requestValidator,
  key: connectionKeyValidator,
  expectedGeneration: v.number(),
  expectedRevision: v.number(),
  operationId: v.string(),
  ownershipFence: v.string(),
  credentialEnvelope: credentialEnvelopeValidator,
  credentialExpiresAt: v.union(v.number(), v.null()),
  completedAt: v.number(),
}

const failureArgs = {
  request: requestValidator,
  key: connectionKeyValidator,
  expectedGeneration: v.number(),
  expectedRevision: v.number(),
  operationId: v.string(),
  ownershipFence: v.string(),
  failedAt: v.number(),
  reason: knownFailureReasonValidator,
}

const interventionArgs = {
  request: requestValidator,
  key: connectionKeyValidator,
  expectedGeneration: v.number(),
  expectedRevision: v.number(),
  operationId: v.string(),
  ownershipFence: v.union(v.string(), v.null()),
  markedAt: v.number(),
  reason: interventionReasonValidator,
}

export const acquire = mutation({
  args: acquisitionArgs,
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeCredentialOperation(ctx, { _tag: 'AcquireCredentialOperation', ...input }),
})

export const admitSelfClientExchange = mutation({
  args: selfClientAdmissionArgs,
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeCredentialOperation(ctx, { _tag: 'AdmitSelfClientExchange', ...input }),
})

export const reserveDispatch = mutation({
  args: reservationArgs,
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeCredentialOperation(ctx, { _tag: 'ReserveCredentialOperationDispatch', ...input }),
})

export const complete = mutation({
  args: completionArgs,
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeCredentialOperation(ctx, { _tag: 'CompleteCredentialOperation', ...input }),
})

export const completeSelfClientExchange = mutation({
  args: selfClientCompletionArgs,
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeCredentialOperation(ctx, { _tag: 'CompleteSelfClientExchange', ...input }),
})

export const recordFailure = mutation({
  args: failureArgs,
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeCredentialOperation(ctx, { _tag: 'RecordCredentialOperationFailure', ...input }),
})

export const markIntervention = mutation({
  args: interventionArgs,
  returns: commandResultValidator,
  handler: (ctx, input) =>
    executeCredentialOperation(ctx, { _tag: 'MarkCredentialOperationIntervention', ...input }),
})
