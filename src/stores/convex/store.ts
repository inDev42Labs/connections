import type {
  FunctionReference,
  FunctionVisibility,
  GenericActionCtx,
  GenericDataModel,
} from 'convex/server'
import { Context, Data, Effect } from 'effect'
import type { CredentialEncryptor } from '../../core/contracts/encryptor.js'
import { invocationBoundPromiseStore } from '../../core/manager.js'
import {
  encryptorFromKey,
  type StoreEncryptionFailure,
} from '../../integrations/store-encryption.js'
import type {
  AuthorizationAttempt,
  AcquireCredentialOperationCommand,
  AdmitSelfClientExchangeCommand,
  AdmitAuthorizationAttemptCommand,
  AuthorizationAttemptLookup,
  CloseAuthorizationAttemptCommand,
  CompleteAuthorizationAttemptCommand,
  CompleteCredentialOperationCommand,
  CompleteSelfClientExchangeCommand,
  InvalidateCredentialCommand,
  ConnectionKey,
  ConnectionSnapshot,
  ConnectionStore,
  StoredConnectionInspection,
  CredentialOperationCommand,
  MarkCredentialOperationInterventionCommand,
  RecordCredentialOperationFailureCommand,
  RemoveConnectionCommand,
  ReserveCredentialOperationDispatchCommand,
  SaveCredentialCommand,
  StoreCommandResult,
} from '../../core/contracts/store.js'
import { projectConnection } from '../internal/transition-kernel.js'

export type ConvexQueryInvocationContext = Pick<GenericActionCtx<GenericDataModel>, 'runQuery'>

export type ConvexInvocationContext = Pick<
  GenericActionCtx<GenericDataModel>,
  'runQuery' | 'runMutation'
>

export class ConvexQueryInvocation extends Context.Service<
  ConvexQueryInvocation,
  ConvexQueryInvocationContext
>()('@indev42/connections/ConvexQueryInvocation') {}

export class ConvexInvocation extends Context.Service<ConvexInvocation, ConvexInvocationContext>()(
  '@indev42/connections/ConvexInvocation',
) {}

export class StorageFailure extends Data.TaggedError('StorageFailure')<{
  readonly operation: 'read' | 'inspect' | 'attempt' | 'execute'
}> {}

interface EncryptionKeyOptions {
  readonly encryptionKey: string | (() => string)
  readonly encryptor?: never
}

interface EncryptorOptions<Error, Requirements> {
  readonly encryptor: CredentialEncryptor<Error, Requirements>
  readonly encryptionKey?: never
}

type MutationRequest = {
  readonly requestId: string
  readonly inputDigest: string
}

type StoredConnection = {
  readonly schemaVersion: 1
  readonly key: ConnectionKey
  readonly generation: number
  readonly revision: number
  readonly authorization:
    | { readonly _tag: 'NotAuthorized' }
    | {
        readonly _tag: 'Authorized'
        readonly credentialExpiresAt: number | null
        readonly credentialAcquiredAt?: number | null
      }
  readonly credentialEnvelope: ConnectionSnapshot['credentialEnvelope']
  readonly credentialOperation: ConnectionSnapshot['credentialOperation']
  readonly storageKey: string
  readonly authorizationAttemptStateDigest: string | null
} | null

function decodeConnection(stored: Exclude<StoredConnection, null>): ConnectionSnapshot | null {
  const {
    storageKey: _storageKey,
    authorizationAttemptStateDigest,
    authorization,
    credentialEnvelope,
    ...base
  } = stored
  if (authorization._tag === 'NotAuthorized' && credentialEnvelope === null) {
    return projectConnection({
      ...base,
      authorization,
      credentialEnvelope,
      authorizationAttemptStateDigest,
    })
  }
  if (authorization._tag === 'Authorized' && credentialEnvelope !== null) {
    return projectConnection({
      ...base,
      authorization: {
        ...authorization,
        credentialAcquiredAt: authorization.credentialAcquiredAt ?? null,
      },
      credentialEnvelope,
      authorizationAttemptStateDigest,
    })
  }
  return null
}

interface ConnectionsComponent<Visibility extends FunctionVisibility> {
  readonly connections: {
    readonly initialize: FunctionReference<
      'mutation',
      Visibility,
      { readonly request: MutationRequest; readonly key: ConnectionKey },
      StoreCommandResult
    >
    readonly saveCredential: FunctionReference<
      'mutation',
      Visibility,
      Omit<SaveCredentialCommand, '_tag'>,
      StoreCommandResult
    >
    readonly invalidateCredential?: FunctionReference<
      'mutation',
      Visibility,
      Omit<InvalidateCredentialCommand, '_tag'>,
      StoreCommandResult
    >
    readonly remove: FunctionReference<
      'mutation',
      Visibility,
      Omit<RemoveConnectionCommand, '_tag'>,
      StoreCommandResult
    >
    readonly read: FunctionReference<
      'query',
      Visibility,
      { readonly key: ConnectionKey },
      StoredConnection
    >
    readonly inspect: FunctionReference<
      'query',
      Visibility,
      { readonly key: ConnectionKey },
      StoredConnectionInspection | null
    >
  }
  readonly operations: {
    readonly admitSelfClientExchange?: FunctionReference<
      'mutation',
      Visibility,
      Omit<AdmitSelfClientExchangeCommand, '_tag'>,
      StoreCommandResult
    >
    readonly completeSelfClientExchange?: FunctionReference<
      'mutation',
      Visibility,
      Omit<CompleteSelfClientExchangeCommand, '_tag'>,
      StoreCommandResult
    >
    readonly acquire: FunctionReference<
      'mutation',
      Visibility,
      Omit<AcquireCredentialOperationCommand, '_tag'>,
      StoreCommandResult
    >
    readonly reserveDispatch: FunctionReference<
      'mutation',
      Visibility,
      Omit<ReserveCredentialOperationDispatchCommand, '_tag'>,
      StoreCommandResult
    >
    readonly complete: FunctionReference<
      'mutation',
      Visibility,
      Omit<CompleteCredentialOperationCommand, '_tag'>,
      StoreCommandResult
    >
    readonly recordFailure: FunctionReference<
      'mutation',
      Visibility,
      Omit<RecordCredentialOperationFailureCommand, '_tag'>,
      StoreCommandResult
    >
    readonly markIntervention: FunctionReference<
      'mutation',
      Visibility,
      Omit<MarkCredentialOperationInterventionCommand, '_tag'>,
      StoreCommandResult
    >
  }
  readonly attempts: {
    readonly read: FunctionReference<
      'query',
      Visibility,
      { readonly lookup: AuthorizationAttemptLookup },
      AuthorizationAttempt | null
    >
    readonly create: FunctionReference<
      'mutation',
      Visibility,
      {
        readonly request: MutationRequest
        readonly attempt: AuthorizationAttempt
      },
      StoreCommandResult
    >
    readonly admit: FunctionReference<
      'mutation',
      Visibility,
      Omit<AdmitAuthorizationAttemptCommand, '_tag'>,
      StoreCommandResult
    >
    readonly close: FunctionReference<
      'mutation',
      Visibility,
      Omit<CloseAuthorizationAttemptCommand, '_tag'>,
      StoreCommandResult
    >
    readonly complete: FunctionReference<
      'mutation',
      Visibility,
      Omit<CompleteAuthorizationAttemptCommand, '_tag'>,
      StoreCommandResult
    >
  }
}

function invokeQuery<Value>(
  operation: StorageFailure['operation'],
  run: (context: ConvexQueryInvocationContext) => Promise<Value>,
): Effect.Effect<Value, StorageFailure, ConvexQueryInvocation> {
  return Effect.gen(function* () {
    const context = yield* ConvexQueryInvocation
    return yield* Effect.tryPromise({
      try: () => run(context),
      catch: () => new StorageFailure({ operation }),
    })
  })
}

function invoke<Value>(
  operation: StorageFailure['operation'],
  run: (context: ConvexInvocationContext) => Promise<Value>,
): Effect.Effect<Value, StorageFailure, ConvexInvocation> {
  return Effect.gen(function* () {
    const context = yield* ConvexInvocation
    return yield* Effect.tryPromise({
      try: () => run(context),
      catch: () => new StorageFailure({ operation }),
    })
  })
}

export function store<Visibility extends FunctionVisibility>(
  options: {
    readonly component: ConnectionsComponent<Visibility>
  } & EncryptionKeyOptions,
): ConnectionStore<
  StorageFailure | StoreEncryptionFailure,
  ConvexInvocation,
  StorageFailure,
  ConvexQueryInvocation
> & { readonly [invocationBoundPromiseStore]: true }
export function store<Visibility extends FunctionVisibility, Error, Requirements>(
  options: {
    readonly component: ConnectionsComponent<Visibility>
  } & EncryptorOptions<Error, Requirements>,
): ConnectionStore<
  StorageFailure | Error,
  ConvexInvocation | Requirements,
  StorageFailure,
  ConvexQueryInvocation
> & { readonly [invocationBoundPromiseStore]: true }
export function store<Visibility extends FunctionVisibility, EncryptorError, EncryptorRequirements>(
  options: { readonly component: ConnectionsComponent<Visibility> } & (
    | EncryptionKeyOptions
    | EncryptorOptions<EncryptorError, EncryptorRequirements>
  ),
): ConnectionStore<
  StorageFailure | StoreEncryptionFailure | EncryptorError,
  ConvexInvocation | EncryptorRequirements,
  StorageFailure,
  ConvexQueryInvocation
> & { readonly [invocationBoundPromiseStore]: true } {
  const { component } = options
  const encryptor: CredentialEncryptor<
    StoreEncryptionFailure | EncryptorError,
    EncryptorRequirements
  > =
    options.encryptionKey === undefined
      ? options.encryptor
      : encryptorFromKey(options.encryptionKey)
  const configured: ConnectionStore<
    StorageFailure | StoreEncryptionFailure | EncryptorError,
    ConvexInvocation | EncryptorRequirements,
    StorageFailure,
    ConvexQueryInvocation
  > = {
    readConnection: (key) =>
      invoke('read', (context) => context.runQuery(component.connections.read, { key })).pipe(
        Effect.flatMap((stored) => {
          if (stored === null) return Effect.succeed(null)
          const snapshot = decodeConnection(stored)
          return snapshot === null
            ? Effect.fail(new StorageFailure({ operation: 'read' }))
            : Effect.succeed(snapshot)
        }),
      ),
    inspectConnection: (key) =>
      invokeQuery('inspect', (context) => context.runQuery(component.connections.inspect, { key })),
    readAuthorizationAttempt: (lookup) =>
      invoke('attempt', (context) => context.runQuery(component.attempts.read, { lookup })),
    protect: (plaintext, context) => encryptor.encrypt(plaintext, context),
    unprotect: (envelope, context) => encryptor.decrypt(envelope, context),
    executeCredentialOperation: (command: CredentialOperationCommand) => {
      switch (command._tag) {
        case 'AdmitSelfClientExchange': {
          const admitSelfClientExchange = component.operations.admitSelfClientExchange
          return admitSelfClientExchange === undefined
            ? Effect.fail(new StorageFailure({ operation: 'execute' }))
            : invoke('execute', (context) =>
                context.runMutation(admitSelfClientExchange, {
                  request: command.request,
                  key: command.key,
                  expectedGeneration: command.expectedGeneration,
                  expectedRevision: command.expectedRevision,
                  intent: command.intent,
                  acquiredAt: command.acquiredAt,
                  ownershipFence: command.ownershipFence,
                  leaseExpiresAt: command.leaseExpiresAt,
                  proposal: command.proposal,
                }),
              )
        }
        case 'CompleteSelfClientExchange': {
          const completeSelfClientExchange = component.operations.completeSelfClientExchange
          return completeSelfClientExchange === undefined
            ? Effect.fail(new StorageFailure({ operation: 'execute' }))
            : invoke('execute', (context) =>
                context.runMutation(completeSelfClientExchange, {
                  request: command.request,
                  key: command.key,
                  expectedGeneration: command.expectedGeneration,
                  expectedRevision: command.expectedRevision,
                  operationId: command.operationId,
                  ownershipFence: command.ownershipFence,
                  credentialEnvelope: command.credentialEnvelope,
                  credentialExpiresAt: command.credentialExpiresAt,
                  completedAt: command.completedAt,
                }),
              )
        }
        case 'SaveCredential':
          return invoke('execute', (context) =>
            context.runMutation(component.connections.saveCredential, {
              request: command.request,
              key: command.key,
              expectedGeneration: command.expectedGeneration,
              expectedRevision: command.expectedRevision,
              intent: command.intent,
              credentialEnvelope: command.credentialEnvelope,
              credentialExpiresAt: command.credentialExpiresAt,
              credentialAcquiredAt: command.credentialAcquiredAt,
            }),
          )
        case 'AcquireCredentialOperation':
          return invoke('execute', (context) =>
            context.runMutation(component.operations.acquire, {
              request: command.request,
              key: command.key,
              expectedGeneration: command.expectedGeneration,
              expectedRevision: command.expectedRevision,
              acquiredAt: command.acquiredAt,
              ownershipFence: command.ownershipFence,
              leaseExpiresAt: command.leaseExpiresAt,
              proposal: command.proposal,
            }),
          )
        case 'ReserveCredentialOperationDispatch':
          return invoke('execute', (context) =>
            context.runMutation(component.operations.reserveDispatch, {
              request: command.request,
              key: command.key,
              expectedGeneration: command.expectedGeneration,
              expectedRevision: command.expectedRevision,
              operationId: command.operationId,
              ownershipFence: command.ownershipFence,
              reservedAt: command.reservedAt,
            }),
          )
        case 'CompleteCredentialOperation':
          return invoke('execute', (context) =>
            context.runMutation(component.operations.complete, {
              request: command.request,
              key: command.key,
              expectedGeneration: command.expectedGeneration,
              expectedRevision: command.expectedRevision,
              operationId: command.operationId,
              ownershipFence: command.ownershipFence,
              credentialEnvelope: command.credentialEnvelope,
              credentialExpiresAt: command.credentialExpiresAt,
              credentialAcquiredAt: command.credentialAcquiredAt,
              completedAt: command.completedAt,
            }),
          )
        case 'RecordCredentialOperationFailure':
          return invoke('execute', (context) =>
            context.runMutation(component.operations.recordFailure, {
              request: command.request,
              key: command.key,
              expectedGeneration: command.expectedGeneration,
              expectedRevision: command.expectedRevision,
              operationId: command.operationId,
              ownershipFence: command.ownershipFence,
              failedAt: command.failedAt,
              reason: command.reason,
            }),
          )
        case 'MarkCredentialOperationIntervention':
          return invoke('execute', (context) =>
            context.runMutation(component.operations.markIntervention, {
              request: command.request,
              key: command.key,
              expectedGeneration: command.expectedGeneration,
              expectedRevision: command.expectedRevision,
              operationId: command.operationId,
              ownershipFence: command.ownershipFence,
              markedAt: command.markedAt,
              reason: command.reason,
            }),
          )
        case 'InvalidateCredential': {
          const invalidateCredential = component.connections.invalidateCredential
          return invalidateCredential === undefined
            ? Effect.fail(new StorageFailure({ operation: 'execute' }))
            : invoke('execute', (context) =>
                context.runMutation(invalidateCredential, {
                  request: command.request,
                  key: command.key,
                  expectedGeneration: command.expectedGeneration,
                  expectedRevision: command.expectedRevision,
                }),
              )
        }
        case 'RemoveConnection':
          return invoke('execute', (context) =>
            context.runMutation(component.connections.remove, {
              request: command.request,
              key: command.key,
              expectedGeneration: command.expectedGeneration,
              expectedRevision: command.expectedRevision,
              removedAt: command.removedAt,
            }),
          )
      }
    },
    execute: (command) => {
      switch (command._tag) {
        case 'InitializeConnection':
          return invoke('execute', (context) =>
            context.runMutation(component.connections.initialize, {
              key: command.key,
              request: command.request,
            }),
          )
        case 'CreateAuthorizationAttempt':
          return invoke('execute', (context) =>
            context.runMutation(component.attempts.create, {
              attempt: command.attempt,
              request: command.request,
            }),
          )
        case 'AdmitAuthorizationAttempt':
          return invoke('execute', (context) =>
            context.runMutation(component.attempts.admit, {
              admission: command.admission,
              ownershipFence: command.ownershipFence,
              leaseExpiresAt: command.leaseExpiresAt,
              operation: command.operation,
              request: command.request,
            }),
          )
        case 'CloseAuthorizationAttempt':
          return invoke('execute', (context) =>
            context.runMutation(component.attempts.close, {
              stateDigest: command.stateDigest,
              key: command.key,
              expectedGeneration: command.expectedGeneration,
              closedAt: command.closedAt,
              reason: command.reason,
              request: command.request,
            }),
          )
        case 'CompleteAuthorizationAttempt':
          return invoke('execute', (context) =>
            context.runMutation(component.attempts.complete, {
              admission: command.admission,
              expectedRevision: command.expectedRevision,
              operationId: command.operationId,
              ownershipFence: command.ownershipFence,
              credentialEnvelope: command.credentialEnvelope,
              credentialExpiresAt: command.credentialExpiresAt,
              completedAt: command.completedAt,
              request: command.request,
            }),
          )
      }
    },
  }
  return Object.freeze({ ...configured, [invocationBoundPromiseStore]: true as const })
}
