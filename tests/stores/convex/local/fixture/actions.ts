// Default Convex runtime deliberately: no "use node" or Node-only APIs.
import { getFunctionAddress } from 'convex/server'
import { v } from 'convex/values'
import { Cause, Effect, Exit, Redacted } from 'effect'
import { revealSecret } from '../../../../../src/index.js'
import type { ReadCredentialFailure } from '../../../../../src/index.js'
import {
  digestStoreInput,
  type CredentialOperationCommandInput,
} from '../../../../../src/stores/index.js'
import {
  Convex,
  type ConvexInvocation,
  type ConvexInvocationContext,
} from '../../../../../src/stores/convex/index.js'
import {
  authorizationValidator,
  connectionKeyValidator,
  credentialOperationValidator,
} from '../../../../../src/stores/convex/component/schema.js'
import { action, query } from './_generated/server.js'
import { components } from './_generated/api.js'
import {
  inspectLocalConnection,
  isLocalConnectionId,
  localBinding,
  localClientCredentialRequestCount,
  localClientCredentials,
  promiseApiKey,
  salesforce,
  salesforceWithWrongEncryptionKey,
  store,
} from './connections.js'

const initialAccessToken = '__connections_local_access_token__'
const concurrentAccessToken = '__connections_local_concurrent_access_token__'
const acknowledgedAccessToken = '__connections_local_acknowledged_access_token__'
const replacementAccessToken = '__connections_local_replacement_access_token__'
const removalReenrolledAccessToken = '__connections_local_removal_reenrolled_access_token__'

function requireConnectionAuthority(connectionId: string): void {
  if (!isLocalConnectionId(connectionId)) {
    throw new Error('Local fixture application authorization denied')
  }
}

function expectedAccessToken(connectionId: string): string {
  if (connectionId.endsWith(':concurrent')) return concurrentAccessToken
  if (connectionId.endsWith(':acknowledgement')) return acknowledgedAccessToken
  if (connectionId.endsWith(':replacement')) return replacementAccessToken
  if (connectionId.endsWith(':removal')) return removalReenrolledAccessToken
  return initialAccessToken
}

function runWithContext<A, E>(
  context: ConvexInvocationContext,
  effect: Effect.Effect<A, E, ConvexInvocation>,
): Promise<A> {
  return Convex.run(context, effect)
}

async function useConnection(context: ConvexInvocationContext, connectionId: string) {
  const use = await runWithContext(context, salesforce.effect.credentialUse(connectionId))
  const applicationOwnedClient = (input: {
    readonly accessToken: string
    readonly instanceUrl: string
  }) => ({
    used: input.accessToken === expectedAccessToken(connectionId),
    instanceUrl: input.instanceUrl,
  })
  return applicationOwnedClient({
    accessToken: Redacted.value(use.credentials.accessToken),
    instanceUrl: use.credentials.instanceUrl,
  })
}

export const inspectConnection = query({
  args: { connectionId: v.string() },
  returns: v.object({
    savedAuthorization: v.boolean(),
    credentialWork: v.union(
      v.literal('idle'),
      v.literal('pending'),
      v.literal('intervention-required'),
      v.literal('known-failure'),
    ),
  }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    return inspectLocalConnection(ctx, connectionId)
  },
})

export const inspectPromiseApiKey = query({
  args: { connectionId: v.string() },
  returns: v.object({
    savedAuthorization: v.boolean(),
    credentialWork: v.union(
      v.literal('idle'),
      v.literal('pending'),
      v.literal('intervention-required'),
      v.literal('known-failure'),
    ),
  }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    return Convex.bind(ctx, promiseApiKey).inspect(connectionId)
  },
})

export const enrollPromiseApiKey = action({
  args: { connectionId: v.string(), apiKey: v.string() },
  returns: v.object({ saved: v.boolean() }),
  handler: async (ctx, { connectionId, apiKey }) => {
    requireConnectionAuthority(connectionId)
    await Convex.bind(ctx, promiseApiKey).setApiKey(connectionId, apiKey)
    return { saved: true }
  },
})

export const useAndRemovePromiseApiKey = action({
  args: { connectionId: v.string(), expectedApiKey: v.string() },
  returns: v.object({ credentialMatched: v.boolean(), rejectionReported: v.boolean() }),
  handler: async (ctx, { connectionId, expectedApiKey }) => {
    requireConnectionAuthority(connectionId)
    const bound = Convex.bind(ctx, promiseApiKey)
    const credentials = await bound.credentials(connectionId)
    const use = await bound.credentialUse(connectionId)
    await use.reportRejected()
    await bound.remove(connectionId)
    return {
      credentialMatched: revealSecret(credentials.apiKey) === expectedApiKey,
      rejectionReported: true,
    }
  },
})

export const startAuthorization = action({
  args: { connectionId: v.string() },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    return runWithContext(
      ctx,
      salesforce.effect.startAuthorization(connectionId, {
        binding: localBinding(),
        replace: false,
      }),
    )
  },
})

export const startReplacement = action({
  args: { connectionId: v.string() },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    return runWithContext(
      ctx,
      salesforce.effect.startAuthorization(connectionId, {
        binding: localBinding(),
        replace: true,
      }),
    )
  },
})

export const removeConnection = action({
  args: { connectionId: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    await runWithContext(ctx, salesforce.effect.remove(connectionId))
    return { removed: true }
  },
})

const effectProgramProbeValidator = v.object({
  accessTokenMatched: v.boolean(),
  inspected: v.boolean(),
})

export const effectProgramProbe = action({
  args: { connectionId: v.string() },
  returns: effectProgramProbeValidator,
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    return Convex.run(
      ctx,
      Effect.gen(function* () {
        const connection = salesforce.effect
        const use = yield* connection.credentialUse(connectionId)
        const inspection = yield* connection.inspect(connectionId)
        return {
          accessTokenMatched:
            Redacted.value(use.credentials.accessToken) === expectedAccessToken(connectionId),
          inspected: inspection.savedAuthorization && inspection.credentialWork === 'idle',
        }
      }),
    )
  },
})

export const promiseRunCancellationProbe = action({
  args: {},
  returns: v.object({ started: v.boolean(), finalized: v.boolean(), rejected: v.boolean() }),
  handler: async (ctx) => {
    let started = false
    let finalized = false
    let signalStart: () => void = () => undefined
    const reached = new Promise<void>((resolve) => (signalStart = resolve))
    const operation = Effect.acquireRelease(
      Effect.sync(() => {
        started = true
        signalStart()
      }),
      () => Effect.sync(() => (finalized = true)),
    ).pipe(Effect.andThen(Effect.never))
    const controller = new AbortController()
    const running = Convex.run(ctx, operation, { signal: controller.signal })
    await reached
    controller.abort()
    const rejected = await running.then(
      () => false,
      () => true,
    )
    return { started, finalized, rejected }
  },
})

type InterventionCauseTag = 'ProviderOutcomeUnknown' | 'EncryptionFailure' | 'Conflict'

type SerializedCredentialOutcome =
  | { readonly _tag: 'Succeeded' }
  | { readonly _tag: 'AuthorizationRequired' }
  | {
      readonly _tag: 'TemporarilyUnavailable'
      readonly cause?: 'ProviderFailure' | 'StorageFailure'
    }
  | { readonly _tag: 'InterventionRequired'; readonly cause: InterventionCauseTag }

function serializeCredentialFailure(failure: ReadCredentialFailure): SerializedCredentialOutcome {
  switch (failure._tag) {
    case 'AuthorizationRequired':
      return { _tag: failure._tag }
    case 'TemporarilyUnavailable':
      return failure.cause === undefined
        ? { _tag: failure._tag }
        : { _tag: failure._tag, cause: failure.cause._tag }
    case 'InterventionRequired':
      return { _tag: failure._tag, cause: failure.cause._tag }
  }
}

const credentialOutcomeValidator = v.union(
  v.object({ _tag: v.literal('Succeeded') }),
  v.object({ _tag: v.literal('AuthorizationRequired') }),
  v.object({
    _tag: v.literal('TemporarilyUnavailable'),
    cause: v.optional(v.union(v.literal('ProviderFailure'), v.literal('StorageFailure'))),
  }),
  v.object({
    _tag: v.literal('InterventionRequired'),
    cause: v.union(
      v.literal('ProviderOutcomeUnknown'),
      v.literal('EncryptionFailure'),
      v.literal('Conflict'),
    ),
  }),
)

function observeCredentialOutcome(
  context: ConvexInvocationContext,
  connectionId: string,
  manager = salesforce,
): Promise<SerializedCredentialOutcome> {
  return runWithContext(
    context,
    manager.effect.credentialUse(connectionId).pipe(
      Effect.match({
        onFailure: serializeCredentialFailure,
        onSuccess: () => ({ _tag: 'Succeeded' as const }),
      }),
    ),
  )
}

export const credentialOutcome = action({
  args: { connectionId: v.string() },
  returns: credentialOutcomeValidator,
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    return observeCredentialOutcome(ctx, connectionId)
  },
})

export const credentialOutcomeWithStorageFailure = action({
  args: { connectionId: v.string() },
  returns: credentialOutcomeValidator,
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    const context: ConvexInvocationContext = {
      runQuery: async () => {
        throw new Error('__connections_local_storage_cause_canary__')
      },
      runMutation: ctx.runMutation,
    }
    return observeCredentialOutcome(context, connectionId)
  },
})

export const credentialOutcomeWithEncryptionFailure = action({
  args: { connectionId: v.string() },
  returns: credentialOutcomeValidator,
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    return observeCredentialOutcome(ctx, connectionId, salesforceWithWrongEncryptionKey)
  },
})

export const credentialOutcomeWithConflict = action({
  args: { connectionId: v.string() },
  returns: credentialOutcomeValidator,
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    const context: ConvexInvocationContext = {
      runQuery: ctx.runQuery,
      runMutation: (async (reference, arguments_) => {
        const address = getFunctionAddress(reference)
        const isCompletion =
          'reference' in address && address.reference?.endsWith('/operations/complete') === true
        return isCompletion
          ? { _tag: 'StoreConflict' as const, reason: 'ConditionChanged' as const }
          : ctx.runMutation(reference, arguments_)
      }) as ConvexInvocationContext['runMutation'],
    }
    return observeCredentialOutcome(context, connectionId)
  },
})

export const useCredentials = action({
  args: { connectionId: v.string() },
  returns: v.object({ used: v.boolean(), instanceUrl: v.string() }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    return useConnection(ctx, connectionId)
  },
})

export const cancelCredentialFollower = action({
  args: { connectionId: v.string() },
  returns: v.object({ cancelled: v.boolean() }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25)
    try {
      const exit = await Effect.runPromiseExit(
        salesforce.effect.credentialUse(connectionId).pipe(Effect.provide(Convex.layer(ctx))),
        { signal: controller.signal },
      )
      return {
        cancelled: Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause),
      }
    } finally {
      clearTimeout(timeout)
    }
  },
})

export const useCredentialsWithLostAcknowledgement = action({
  args: { connectionId: v.string() },
  returns: v.object({
    used: v.boolean(),
    instanceUrl: v.string(),
    completionMutations: v.number(),
  }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    let loseCompletionAcknowledgement = true
    let completionMutations = 0
    const context: ConvexInvocationContext = {
      runQuery: ctx.runQuery,
      runMutation: (async (reference, arguments_) => {
        const address = getFunctionAddress(reference)
        const isCompletion =
          'reference' in address && address.reference?.endsWith('/operations/complete') === true
        const result = await ctx.runMutation(reference, arguments_)
        if (isCompletion) {
          completionMutations++
          if (loseCompletionAcknowledgement) {
            loseCompletionAcknowledgement = false
            throw new Error('Simulated lost Convex mutation acknowledgement')
          }
        }
        return result
      }) as ConvexInvocationContext['runMutation'],
    }
    return {
      ...(await useConnection(context, connectionId)),
      completionMutations,
    }
  },
})

async function withRequest<Command extends CredentialOperationCommandInput>(command: Command) {
  return {
    ...command,
    request: {
      requestId: crypto.randomUUID(),
      inputDigest: await digestStoreInput(command),
    },
  }
}

export const rejectStaleCompletion = action({
  args: { connectionId: v.string() },
  returns: v.object({
    interventionMarked: v.boolean(),
    staleCompletionRejected: v.boolean(),
    retainedPhase: v.string(),
  }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    const key = {
      namespace: 'default',
      providerId: 'salesforce',
      connectionId,
    }
    const snapshot = await runWithContext(ctx, store.readConnection(key))
    if (
      snapshot === null ||
      snapshot.authorization._tag !== 'Authorized' ||
      snapshot.credentialEnvelope === null
    ) {
      throw new Error('Expected an authorized connection for stale completion check')
    }
    const acquiredAt = Date.now()
    const acquisition = await runWithContext(
      ctx,
      store.executeCredentialOperation(
        await withRequest({
          _tag: 'AcquireCredentialOperation' as const,
          key,
          expectedGeneration: snapshot.generation,
          expectedRevision: snapshot.revision,
          acquiredAt,
          ownershipFence: `fence:${crypto.randomUUID()}`,
          leaseExpiresAt: acquiredAt + 30_000,
          proposal: {
            operationId: `operation:${crypto.randomUUID()}`,
            kind: 'refresh' as const,
            startedAt: acquiredAt,
            recoveryDeadline: acquiredAt + 120_000,
            transferLimit: 3,
          },
        }),
      ),
    )
    if (acquisition._tag !== 'CredentialOperationAcquired') {
      throw new Error('Expected operation acquisition')
    }
    const operation = acquisition.operation
    if (operation.phase._tag !== 'OwnedBeforeDispatch') {
      throw new Error('Expected pre-dispatch operation ownership')
    }
    const ownershipFence = operation.phase.ownershipFence
    const reservation = await runWithContext(
      ctx,
      store.executeCredentialOperation(
        await withRequest({
          _tag: 'ReserveCredentialOperationDispatch' as const,
          key,
          expectedGeneration: acquisition.generation,
          expectedRevision: acquisition.revision,
          operationId: operation.operationId,
          ownershipFence,
          reservedAt: acquiredAt + 1,
        }),
      ),
    )
    if (reservation._tag !== 'CredentialOperationDispatchReserved') {
      throw new Error('Expected dispatch reservation')
    }
    const intervention = await runWithContext(
      ctx,
      store.executeCredentialOperation(
        await withRequest({
          _tag: 'MarkCredentialOperationIntervention' as const,
          key,
          expectedGeneration: reservation.generation,
          expectedRevision: reservation.revision,
          operationId: operation.operationId,
          ownershipFence,
          markedAt: acquiredAt + 2,
          reason: 'ProviderOutcomeUnknown' as const,
        }),
      ),
    )
    const staleCompletion = await runWithContext(
      ctx,
      store.executeCredentialOperation(
        await withRequest({
          _tag: 'CompleteCredentialOperation' as const,
          key,
          expectedGeneration: reservation.generation,
          expectedRevision: reservation.revision,
          operationId: operation.operationId,
          ownershipFence,
          credentialEnvelope: snapshot.credentialEnvelope,
          credentialExpiresAt: snapshot.authorization.credentialExpiresAt,
          completedAt: acquiredAt + 3,
        }),
      ),
    )
    const retained = await runWithContext(ctx, store.readConnection(key))
    return {
      interventionMarked: intervention._tag === 'CredentialOperationInterventionMarked',
      staleCompletionRejected:
        staleCompletion._tag === 'StoreConflict' && staleCompletion.reason === 'ConditionChanged',
      retainedPhase: retained?.credentialOperation?.phase._tag ?? 'Missing',
    }
  },
})

export const clientCredentialsLifecycle = action({
  args: { connectionId: v.string() },
  returns: v.object({ concurrentRequests: v.number(), reused: v.boolean() }),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    const before = localClientCredentialRequestCount()
    const manager = localClientCredentials()
    const connection = manager.effect
    await runWithContext(
      ctx,
      connection.setClientCredentials(
        `${connectionId}:client-concurrent`,
        { source: Redacted.make('source') },
        { replace: false },
      ),
    )
    const concurrent = await runWithContext(
      ctx,
      Effect.all(
        [
          connection.credentialUse(`${connectionId}:client-concurrent`),
          connection.credentialUse(`${connectionId}:client-concurrent`),
        ],
        {
          concurrency: 'unbounded',
        },
      ),
    )
    const concurrentRequests = localClientCredentialRequestCount() - before
    return {
      concurrentRequests,
      reused:
        Redacted.value(concurrent[0].credentials.token) ===
        Redacted.value(concurrent[1].credentials.token),
    }
  },
})

const envelope = v.object({
  version: v.literal(1),
  algorithm: v.literal('AES-256-GCM'),
  keyId: v.string(),
  iv: v.string(),
  ciphertext: v.string(),
})

export const rawConnection = query({
  args: { connectionId: v.string() },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(1),
      key: connectionKeyValidator,
      storageKey: v.string(),
      generation: v.number(),
      revision: v.number(),
      authorization: authorizationValidator,
      credentialEnvelope: v.union(envelope, v.null()),
      credentialOperation: v.union(credentialOperationValidator, v.null()),
      authorizationAttemptStateDigest: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { connectionId }) => {
    requireConnectionAuthority(connectionId)
    const connection = await ctx.runQuery(components.connections.connections.read, {
      key: {
        namespace: 'default',
        providerId: 'salesforce',
        connectionId,
      },
    })
    if (connection === null) return null
    return connection
  },
})
