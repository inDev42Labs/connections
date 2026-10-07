import { Data, Effect, Redacted } from 'effect'
import type { CredentialEncryptor } from '../../src/core/contracts/encryptor.js'
import type {
  ConnectionKey,
  ConnectionSnapshot,
  ConnectionStore,
  CredentialOperationCommand,
  ProtectedCredentialEnvelope,
  StoreCommand,
  StoreCommandResult,
} from '../../src/stores/index.js'
import { AesGcm, type EncryptionFailure } from '../../src/encryptors/aes-gcm/index.js'
import { projectConnection } from '../../src/stores/internal/transition-kernel.js'
import { MemoryPersistence } from '../../src/stores/memory/persistence.js'
import { makeMemoryStore } from '../../src/stores/memory/store.js'

export class InMemoryStorageFailure extends Data.TaggedError('InMemoryStorageFailure')<{
  readonly operation: 'execute'
}> {}

export interface InMemoryExecutionHold {
  readonly reached: Promise<void>
  readonly release: () => void
}

export interface InMemoryStoreFixture<Error, Requirements> extends ConnectionStore<
  Error | InMemoryStorageFailure,
  Requirements
> {
  readonly diagnostics: {
    reads: number
    executions: number
    readonly commands: Partial<
      Record<StoreCommand['_tag'] | CredentialOperationCommand['_tag'], number>
    >
  }
  readonly executeCredentialOperation: (
    command: CredentialOperationCommand,
  ) => Effect.Effect<StoreCommandResult, Error | InMemoryStorageFailure, Requirements>
  readonly failNext: (command: StoreCommand['_tag'] | CredentialOperationCommand['_tag']) => void
  readonly loseNextAcknowledgement: (
    command: StoreCommand['_tag'] | CredentialOperationCommand['_tag'],
  ) => void
  readonly holdNext: (
    command: StoreCommand['_tag'] | CredentialOperationCommand['_tag'],
    position?: 'before' | 'after',
  ) => InMemoryExecutionHold
  readonly pruneReceipts: () => void
  readonly unsafeReadConnection: (key: ConnectionKey) => ConnectionSnapshot | null
  readonly unsafeReplaceCredentialEnvelope: (
    key: ConnectionKey,
    envelope: ProtectedCredentialEnvelope,
  ) => void
}

const defaultEncryptor = AesGcm.encryptor({
  key: Effect.succeed(Redacted.make('KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=')),
  keyId: 'in-memory-test',
})

type CommandKind = StoreCommand['_tag'] | CredentialOperationCommand['_tag']

function configuredFixture<Error, Requirements>(
  encryptor: CredentialEncryptor<Error, Requirements>,
): InMemoryStoreFixture<Error, Requirements> {
  const persistence = new MemoryPersistence()
  const production = makeMemoryStore({ encryptor }, persistence)
  const failures = new Map<CommandKind, number>()
  const lostAcknowledgements = new Map<CommandKind, number>()
  const holds = new Map<
    string,
    {
      readonly reached: () => void
      readonly released: Promise<void>
    }
  >()
  const diagnostics: InMemoryStoreFixture<Error, Requirements>['diagnostics'] = {
    reads: 0,
    executions: 0,
    commands: {},
  }

  const executeWithControls = (
    command: StoreCommand | CredentialOperationCommand,
    apply: Effect.Effect<StoreCommandResult, Error, Requirements>,
  ): Effect.Effect<StoreCommandResult, Error | InMemoryStorageFailure, Requirements> =>
    Effect.suspend(() => {
      diagnostics.executions++
      diagnostics.commands[command._tag] = (diagnostics.commands[command._tag] ?? 0) + 1
      const remainingFailures = failures.get(command._tag) ?? 0
      if (remainingFailures > 0) {
        failures.set(command._tag, remainingFailures - 1)
        return Effect.fail(new InMemoryStorageFailure({ operation: 'execute' }))
      }

      const before = holds.get(`${command._tag}:before`)
      if (before !== undefined) holds.delete(`${command._tag}:before`)
      const applied =
        before === undefined
          ? apply
          : Effect.sync(before.reached).pipe(
              Effect.andThen(Effect.promise(() => before.released)),
              Effect.andThen(apply),
            )

      return applied.pipe(
        Effect.flatMap((result) => {
          const after = holds.get(`${command._tag}:after`)
          if (after !== undefined) holds.delete(`${command._tag}:after`)
          const acknowledge = Effect.suspend(() => {
            const remaining = lostAcknowledgements.get(command._tag) ?? 0
            if (remaining <= 0) return Effect.succeed(result)
            lostAcknowledgements.set(command._tag, remaining - 1)
            return Effect.fail(new InMemoryStorageFailure({ operation: 'execute' }))
          })
          return after === undefined
            ? acknowledge
            : Effect.sync(after.reached).pipe(
                Effect.andThen(Effect.promise(() => after.released)),
                Effect.andThen(acknowledge),
              )
        }),
      )
    })

  const readUnsafe = (key: ConnectionKey): ConnectionSnapshot | null =>
    structuredClone(projectConnection(persistence.connection(key)))

  return {
    diagnostics,
    readConnection: (key) =>
      Effect.sync(() => diagnostics.reads++).pipe(Effect.andThen(production.readConnection(key))),
    inspectConnection: (key) =>
      Effect.sync(() => diagnostics.reads++).pipe(
        Effect.andThen(production.inspectConnection(key)),
      ),
    readAuthorizationAttempt: (lookup) =>
      Effect.sync(() => diagnostics.reads++).pipe(
        Effect.andThen(production.readAuthorizationAttempt(lookup)),
      ),
    protect: production.protect,
    unprotect: production.unprotect,
    execute: (command) => executeWithControls(command, production.execute(command)),
    executeCredentialOperation: (command) =>
      executeWithControls(command, production.executeCredentialOperation(command)),
    failNext: (command) => failures.set(command, (failures.get(command) ?? 0) + 1),
    loseNextAcknowledgement: (command) =>
      lostAcknowledgements.set(command, (lostAcknowledgements.get(command) ?? 0) + 1),
    holdNext: (command, position = 'after') => {
      const key = `${command}:${position}`
      if (holds.has(key)) throw new Error(`A hold already exists for ${key}`)
      let markReached: () => void = () => undefined
      let release: () => void = () => undefined
      const reached = new Promise<void>((resolve) => (markReached = resolve))
      const released = new Promise<void>((resolve) => (release = resolve))
      holds.set(key, { reached: markReached, released })
      return { reached, release }
    },
    pruneReceipts: () => persistence.clearReceipts(),
    unsafeReadConnection: readUnsafe,
    unsafeReplaceCredentialEnvelope: (key, envelope) => {
      const stored = persistence.connection(key)
      if (stored === null || stored.authorization._tag !== 'Authorized') {
        throw new Error('Cannot alter credentials for an unauthorized connection')
      }
      persistence.replaceConnection({
        schemaVersion: 1,
        key: stored.key,
        generation: stored.generation,
        revision: stored.revision,
        authorization: stored.authorization,
        credentialEnvelope: structuredClone(envelope),
        credentialOperation: stored.credentialOperation,
        authorizationAttemptStateDigest: stored.authorizationAttemptStateDigest,
      })
    },
  }
}

export function makeInMemoryStore(): InMemoryStoreFixture<EncryptionFailure, never>
export function makeInMemoryStore<Error, Requirements>(options: {
  readonly encryptor: CredentialEncryptor<Error, Requirements>
}): InMemoryStoreFixture<Error, Requirements>
export function makeInMemoryStore(options?: {
  readonly encryptor?: CredentialEncryptor<unknown, unknown>
}): InMemoryStoreFixture<unknown, unknown> {
  return configuredFixture(options?.encryptor ?? defaultEncryptor)
}
