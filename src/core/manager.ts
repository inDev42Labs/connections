import { Effect, Redacted } from 'effect'
import type { Effect as EffectType } from 'effect'
import type {
  ApiKeyProviderDefinition,
  ClientCredentialsProviderDefinition,
  OAuthProviderDefinition,
  ProviderCredentials,
  SelfClientProviderDefinition,
} from './contracts/provider.js'
import type { ConnectionStore } from './contracts/store.js'
import type { CredentialUse, ConnectionIdentity } from './model.js'
import type { ApiKeyWorkflow } from './api-key-workflow.js'
import { makeApiKeyWorkflow } from './api-key-workflow.js'
import { makeClientCredentialsWorkflow } from './client-credentials-workflow.js'
import { makeOAuthWorkflow } from './workflow.js'
import { makeSelfClientWorkflow } from './self-client-workflow.js'
import type { AuthorizationStart, AuthorizationTarget, ConnectionInspection } from './model.js'
import type {
  AuthorizationFailure,
  CredentialConfigurationFailure,
  InspectionFailure,
  RemovalFailure,
} from './failures.js'
import type { CredentialFailure as ReadCredentialFailure } from './failures.js'
export type { CredentialFailure as ReadCredentialFailure } from './failures.js'
export type {
  AuthorizationStart,
  AuthorizationTarget,
  ConnectionInspection,
  CredentialWorkCondition,
  CredentialUse,
} from './model.js'

/** @internal Runtime brand used only to select invocation-bound execution. */
export const invocationBoundPromiseStore = Symbol(
  '@indev42/connections/invocationBoundPromiseStore',
)
/** @internal Carries the unbound Promise manager's invocation runner. */
export const bindPromiseManager = Symbol('@indev42/connections/bindPromiseManager')

export type InvocationBoundPromiseStore<
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
> = ConnectionStore<Error, Requirements, InspectionError, InspectionRequirements> & {
  readonly [invocationBoundPromiseStore]: true
}

export type PromiseEffectRunner<Requirements> = <Value, Error>(
  operation: EffectType.Effect<Value, Error, Requirements>,
) => Promise<Value>

export interface PromiseManagerRunners<
  ActionRequirements,
  InspectionRequirements,
  RemovalRequirements = ActionRequirements,
> {
  readonly action: PromiseEffectRunner<ActionRequirements>
  readonly inspection: PromiseEffectRunner<InspectionRequirements>
  readonly removal: PromiseEffectRunner<RemovalRequirements>
}

export interface PromiseCredentialUse<Credentials> {
  readonly credentials: Credentials
  readonly reportRejected: () => Promise<void>
}

export interface PromiseReadManager<
  Credentials,
  ActionRequirements = never,
  InspectionRequirements = ActionRequirements,
  RemovalRequirements = ActionRequirements,
> {
  readonly credentials: (id: string) => Promise<Credentials>
  readonly credentialUse: (id: string) => Promise<PromiseCredentialUse<Credentials>>
  readonly inspect: (id: string) => Promise<ConnectionInspection>
  readonly remove: (id: string) => Promise<void>
  readonly effect: {
    readonly credentials: (
      id: string,
    ) => EffectType.Effect<Credentials, ReadCredentialFailure, ActionRequirements>
    readonly credentialUse: (
      id: string,
    ) => EffectType.Effect<
      CredentialUse<Credentials, ActionRequirements>,
      ReadCredentialFailure,
      ActionRequirements
    >
    readonly inspect: (
      id: string,
    ) => EffectType.Effect<ConnectionInspection, InspectionFailure, InspectionRequirements>
    readonly remove: (id: string) => EffectType.Effect<void, RemovalFailure, RemovalRequirements>
  }
}

export interface ReplaceOptions {
  readonly replace?: boolean
}

export interface PromiseApiKeyManager<
  Credentials,
  ActionRequirements = never,
  InspectionRequirements = ActionRequirements,
  RemovalRequirements = ActionRequirements,
> extends PromiseReadManager<
  Credentials,
  ActionRequirements,
  InspectionRequirements,
  RemovalRequirements
> {
  readonly setApiKey: (id: string, apiKey: string, options?: ReplaceOptions) => Promise<void>
  readonly effect: PromiseReadManager<
    Credentials,
    ActionRequirements,
    InspectionRequirements,
    RemovalRequirements
  >['effect'] & {
    readonly setApiKey: (
      id: string,
      apiKey: string,
      options?: ReplaceOptions,
    ) => EffectType.Effect<void, CredentialConfigurationFailure, ActionRequirements>
  }
}

export interface PromiseClientCredentialsManager<
  Source,
  Credentials,
  ActionRequirements = never,
  InspectionRequirements = ActionRequirements,
  RemovalRequirements = ActionRequirements,
> extends PromiseReadManager<
  Credentials,
  ActionRequirements,
  InspectionRequirements,
  RemovalRequirements
> {
  readonly setClientCredentials: (
    id: string,
    source: Source,
    options?: ReplaceOptions,
  ) => Promise<void>
  readonly effect: PromiseReadManager<
    Credentials,
    ActionRequirements,
    InspectionRequirements,
    RemovalRequirements
  >['effect'] & {
    readonly setClientCredentials: (
      id: string,
      source: Source,
      options?: ReplaceOptions,
    ) => EffectType.Effect<void, CredentialConfigurationFailure, ActionRequirements>
  }
}

export interface AuthorizationOptions extends ReplaceOptions {
  readonly binding: string
}

export interface CompleteAuthorizationOptions {
  readonly callbackUrl: string
  readonly binding: string
  readonly authorize: (target: AuthorizationTarget) => Promise<void> | void
}

export interface PromiseOAuthManager<
  Credentials,
  ActionRequirements = never,
  InspectionRequirements = ActionRequirements,
  RemovalRequirements = ActionRequirements,
> extends PromiseReadManager<
  Credentials,
  ActionRequirements,
  InspectionRequirements,
  RemovalRequirements
> {
  readonly startAuthorization: (
    id: string,
    options: AuthorizationOptions,
  ) => Promise<AuthorizationStart>
  readonly completeAuthorization: (
    options: CompleteAuthorizationOptions,
  ) => Promise<{ connectionId: string }>
  readonly effect: PromiseReadManager<
    Credentials,
    ActionRequirements,
    InspectionRequirements,
    RemovalRequirements
  >['effect'] & {
    readonly startAuthorization: (
      id: string,
      options: AuthorizationOptions,
    ) => EffectType.Effect<AuthorizationStart, AuthorizationFailure, ActionRequirements>
    readonly completeAuthorization: (
      options: CompleteAuthorizationOptions,
    ) => EffectType.Effect<
      { connectionId: string },
      AuthorizationFailure | unknown,
      ActionRequirements
    >
  }
}

export interface EnrollCodeOptions extends ReplaceOptions {
  readonly code: string
  readonly authorize: () => Promise<void> | void
}

export interface PromiseSelfClientManager<
  Credentials,
  ActionRequirements = never,
  InspectionRequirements = ActionRequirements,
  RemovalRequirements = ActionRequirements,
> extends PromiseReadManager<
  Credentials,
  ActionRequirements,
  InspectionRequirements,
  RemovalRequirements
> {
  readonly enrollCode: (id: string, options: EnrollCodeOptions) => Promise<void>
  readonly effect: PromiseReadManager<
    Credentials,
    ActionRequirements,
    InspectionRequirements,
    RemovalRequirements
  >['effect'] & {
    readonly enrollCode: (
      id: string,
      options: EnrollCodeOptions,
    ) => EffectType.Effect<void, AuthorizationFailure | unknown, ActionRequirements>
  }
}

type PromiseProvider =
  | ApiKeyProviderDefinition<unknown, never>
  | OAuthProviderDefinition<unknown, never>
  | SelfClientProviderDefinition<unknown, never>
  | ClientCredentialsProviderDefinition<never, unknown, never>

type PromiseStore = ConnectionStore<unknown, never, unknown, never>
type AnyInvocationBoundPromiseStore = InvocationBoundPromiseStore<
  unknown,
  unknown,
  unknown,
  unknown
>

type PromiseManagerFor<
  Provider extends PromiseProvider,
  ActionRequirements = never,
  InspectionRequirements = ActionRequirements,
  RemovalRequirements = ActionRequirements,
> =
  Provider extends ApiKeyProviderDefinition<infer Credentials, never>
    ? PromiseApiKeyManager<
        Credentials,
        ActionRequirements,
        InspectionRequirements,
        RemovalRequirements
      >
    : Provider extends ClientCredentialsProviderDefinition<infer Source, infer Credentials, never>
      ? PromiseClientCredentialsManager<
          Source,
          Credentials,
          ActionRequirements,
          InspectionRequirements,
          RemovalRequirements
        >
      : Provider extends SelfClientProviderDefinition<unknown, never>
        ? PromiseSelfClientManager<
            ProviderCredentials<Provider>,
            ActionRequirements,
            InspectionRequirements,
            RemovalRequirements
          >
        : Provider extends OAuthProviderDefinition<infer Credentials, never>
          ? PromiseOAuthManager<
              Credentials,
              ActionRequirements,
              InspectionRequirements,
              RemovalRequirements
            >
          : never

type ManagerEffect<Manager> = Manager extends { readonly effect: infer Effect } ? Effect : never

/** @internal Carrier returned only for stores requiring invocation services. */
export interface UnboundPromiseManager<
  Manager,
  ActionRequirements,
  InspectionRequirements,
  RemovalRequirements = ActionRequirements,
> {
  readonly effect: ManagerEffect<Manager>
  readonly [bindPromiseManager]: (
    runners: PromiseManagerRunners<ActionRequirements, InspectionRequirements, RemovalRequirements>,
  ) => Manager
}

function makeReadManager<
  Credentials,
  ActionRequirements,
  InspectionRequirements,
  RemovalRequirements,
>(
  workflow: Pick<
    ApiKeyWorkflow<Credentials, ActionRequirements, InspectionRequirements, RemovalRequirements>,
    'credentials' | 'inspect' | 'remove'
  >,
  identity: (id: string) => ConnectionIdentity,
  runners: PromiseManagerRunners<ActionRequirements, InspectionRequirements, RemovalRequirements>,
): PromiseReadManager<
  Credentials,
  ActionRequirements,
  InspectionRequirements,
  RemovalRequirements
> {
  const effect = Object.freeze({
    credentialUse: (id: string) => workflow.credentials(identity(id)),
    credentials: (id: string) =>
      workflow.credentials(identity(id)).pipe(Effect.map((use) => use.credentials)),
    inspect: (id: string) => workflow.inspect(identity(id)),
    remove: (id: string) => workflow.remove(identity(id)),
  })

  return Object.freeze({
    credentials: (id: string) => runners.action(effect.credentials(id)),
    credentialUse: (id: string) =>
      runners.action(effect.credentialUse(id)).then((use) => ({
        credentials: use.credentials,
        reportRejected: () => runners.action(use.reportRejected()),
      })),
    inspect: (id: string) => runners.inspection(effect.inspect(id)),
    remove: (id: string) => runners.removal(effect.remove(id)),
    effect,
  })
}

function makePromiseFacade<Requirements, InspectionRequirements>(options: {
  readonly store: ConnectionStore<unknown, Requirements, unknown, InspectionRequirements>
  readonly provider: PromiseProvider
  readonly runners: PromiseManagerRunners<Requirements, InspectionRequirements, Requirements>
}):
  | PromiseReadManager<unknown, Requirements, InspectionRequirements>
  | PromiseApiKeyManager<unknown, Requirements, InspectionRequirements>
  | PromiseClientCredentialsManager<never, unknown, Requirements, InspectionRequirements>
  | PromiseSelfClientManager<unknown, Requirements, InspectionRequirements>
  | PromiseOAuthManager<unknown, Requirements, InspectionRequirements> {
  const { provider, store, runners } = options
  const namespace = 'default'
  const identity = (connectionId: string): ConnectionIdentity => ({
    namespace,
    providerId: provider.id,
    connectionId,
  })
  if ('prepareApiKey' in provider) {
    const workflow = makeApiKeyWorkflow({ provider, store })
    const read = makeReadManager(workflow, identity, runners)
    const setApiKey = (id: string, apiKey: string, options?: ReplaceOptions) =>
      workflow.setApiKey(identity(id), {
        apiKey: Redacted.make(apiKey),
        intent: options?.replace === true ? 'replace' : 'enroll',
      })
    return Object.freeze({
      ...read,
      setApiKey: (id: string, apiKey: string, options?: ReplaceOptions) =>
        runners.action(setApiKey(id, apiKey, options)),
      effect: Object.freeze({ ...read.effect, setApiKey }),
    })
  }
  if ('acquireCredentials' in provider) {
    const workflow = makeClientCredentialsWorkflow({ provider, store })
    const read = makeReadManager(workflow, identity, runners)
    const setClientCredentials = (id: string, source: never, options?: ReplaceOptions) =>
      workflow.setClientCredentials(identity(id), {
        credentials: source,
        intent: options?.replace === true ? 'replace' : 'enroll',
      })
    return Object.freeze({
      ...read,
      setClientCredentials: (id: string, source: never, options?: ReplaceOptions) =>
        runners.action(setClientCredentials(id, source, options)),
      effect: Object.freeze({ ...read.effect, setClientCredentials }),
    })
  }
  if ('exchangeSelfClientCode' in provider) {
    const workflow = makeSelfClientWorkflow({ provider, store })
    const read = makeReadManager(workflow, identity, runners)
    const enrollCode = (id: string, options: EnrollCodeOptions) =>
      workflow.enrollCode(identity(id), {
        code: Redacted.make(options.code),
        intent: options.replace === true ? 'replace' : 'enroll',
        authorize: () =>
          Effect.tryPromise({
            try: () => Promise.resolve(options.authorize()),
            catch: (error) => error,
          }),
      })
    return Object.freeze({
      ...read,
      enrollCode: (id: string, options: EnrollCodeOptions) =>
        runners.action(enrollCode(id, options)),
      effect: Object.freeze({ ...read.effect, enrollCode }),
    })
  }
  const workflow = makeOAuthWorkflow({ namespace, provider, store })
  const read = makeReadManager(workflow, identity, runners)
  const startAuthorization = (id: string, options: AuthorizationOptions) =>
    workflow.startAuthorization(identity(id), {
      binding: options.binding,
      intent: options.replace === true ? 'replace' : 'enroll',
    })
  const completeAuthorization = (options: CompleteAuthorizationOptions) =>
    workflow
      .completeAuthorization({
        callbackUrl: options.callbackUrl,
        binding: options.binding,
        authorize: (target) =>
          Effect.tryPromise({
            try: () => Promise.resolve(options.authorize(target)),
            catch: (error) => error,
          }),
      })
      .pipe(Effect.map(({ connectionId }) => ({ connectionId })))
  return Object.freeze({
    ...read,
    startAuthorization: (id: string, options: AuthorizationOptions) =>
      runners.action(startAuthorization(id, options)),
    completeAuthorization: (options: CompleteAuthorizationOptions) =>
      runners.action(completeAuthorization(options)),
    effect: Object.freeze({ ...read.effect, startAuthorization, completeAuthorization }),
  })
}

function makeUnboundPromiseManager(options: {
  readonly store: AnyInvocationBoundPromiseStore
  readonly provider: PromiseProvider
}): unknown {
  const { store, provider } = options
  const unavailable: PromiseEffectRunner<unknown> = () =>
    Promise.reject(
      new Error('Bind this manager to its current invocation before using Promise methods'),
    )
  const build = (runners: PromiseManagerRunners<unknown, unknown, unknown>) =>
    makePromiseFacade({ store, provider, runners })
  const unbound = build({ action: unavailable, inspection: unavailable, removal: unavailable })
  return Object.freeze({
    effect: unbound.effect,
    [bindPromiseManager]: build,
  })
}

export function makeManager<Provider extends PromiseProvider>(options: {
  readonly store: PromiseStore
  readonly provider: Provider
}): PromiseManagerFor<Provider>
export function makeManager<
  Provider extends PromiseProvider,
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
>(options: {
  readonly store: InvocationBoundPromiseStore<
    Error,
    Requirements,
    InspectionError,
    InspectionRequirements
  >
  readonly provider: Provider
}): UnboundPromiseManager<
  PromiseManagerFor<Provider, Requirements, InspectionRequirements, Requirements>,
  Requirements,
  InspectionRequirements
>
export function makeManager(options: {
  readonly store: PromiseStore | AnyInvocationBoundPromiseStore
  readonly provider: PromiseProvider
}): unknown {
  if (invocationBoundPromiseStore in options.store) {
    return makeUnboundPromiseManager({ store: options.store, provider: options.provider })
  }
  const runPromise: PromiseEffectRunner<never> = <Value, Error>(
    operation: EffectType.Effect<Value, Error, never>,
  ) => Effect.runPromise(operation)
  return makePromiseFacade({
    store: options.store,
    provider: options.provider,
    runners: { action: runPromise, inspection: runPromise, removal: runPromise },
  })
}

export function revealSecret(secret: Redacted.Redacted<string>): string {
  return Redacted.value(secret)
}
