import {
  connectionStorageKey,
  credentialOperationCommandKey,
  storeCommandKey,
  type AuthorizationAttemptLookup,
  type ConnectionKey,
  type CredentialOperationCommand,
  type StoreCommand,
  type StoreCommandResult,
} from '../../core/contracts/store.js'
import {
  transitionCredentialOperation,
  transitionStoreCommand,
  type StoreTransition,
  type StoredAuthorizationAttempt,
  type StoredCommand,
  type StoredConnection,
  type StoredReceipt,
  type TransitionRecords,
} from '../internal/transition-kernel.js'

function attemptStorageKey(namespace: string, stateDigest: string): string {
  return JSON.stringify([namespace, stateDigest])
}

function receiptStorageKey(namespace: string, requestId: string): string {
  return JSON.stringify([namespace, requestId])
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

export class MemoryPersistence {
  readonly #connections = new Map<string, StoredConnection>()
  readonly #attempts = new Map<string, StoredAuthorizationAttempt>()
  readonly #receipts = new Map<string, StoredReceipt>()

  connection(key: ConnectionKey): StoredConnection | null {
    const stored = this.#connections.get(connectionStorageKey(key))
    return stored === undefined ? null : clone(stored)
  }

  authorizationAttempt(
    lookup: Pick<AuthorizationAttemptLookup, 'namespace' | 'stateDigest'>,
  ): StoredAuthorizationAttempt | null {
    const stored = this.#attempts.get(attemptStorageKey(lookup.namespace, lookup.stateDigest))
    return stored === undefined ? null : clone(stored)
  }

  execute(command: StoreCommand): StoreCommandResult {
    return this.#commit(command, transitionStoreCommand(command, this.#records(command)))
  }

  executeCredentialOperation(command: CredentialOperationCommand): StoreCommandResult {
    return this.#commit(command, transitionCredentialOperation(command, this.#records(command)))
  }

  replaceConnection(stored: StoredConnection): void {
    this.#connections.set(connectionStorageKey(stored.key), clone(stored))
  }

  clearReceipts(): void {
    this.#receipts.clear()
  }

  #records(command: StoredCommand): TransitionRecords {
    const key =
      command._tag === 'InitializeConnection' ||
      command._tag === 'CreateAuthorizationAttempt' ||
      command._tag === 'AdmitAuthorizationAttempt' ||
      command._tag === 'CloseAuthorizationAttempt' ||
      command._tag === 'CompleteAuthorizationAttempt'
        ? storeCommandKey(command)
        : credentialOperationCommandKey(command)
    const connection = this.connection(key)
    let attempt: StoredAuthorizationAttempt | null = null
    switch (command._tag) {
      case 'CreateAuthorizationAttempt':
        attempt = this.authorizationAttempt({
          namespace: command.attempt.key.namespace,
          stateDigest: command.attempt.stateDigest,
        })
        break
      case 'AdmitAuthorizationAttempt':
      case 'CompleteAuthorizationAttempt':
        attempt = this.authorizationAttempt({
          namespace: command.admission.key.namespace,
          stateDigest: command.admission.stateDigest,
        })
        break
      case 'CloseAuthorizationAttempt':
        attempt = this.authorizationAttempt({
          namespace: command.key.namespace,
          stateDigest: command.stateDigest,
        })
        break
    }
    const selectedAttempt =
      connection?.authorizationAttemptStateDigest === null || connection === null
        ? null
        : this.authorizationAttempt({
            namespace: key.namespace,
            stateDigest: connection.authorizationAttemptStateDigest,
          })
    const receipt = this.#receipts.get(receiptStorageKey(key.namespace, command.request.requestId))
    return {
      connection,
      attempt,
      selectedAttempt,
      receipt: receipt === undefined ? null : clone(receipt),
    }
  }

  #commit(command: StoredCommand, transition: StoreTransition): StoreCommandResult {
    const { writes } = transition
    if (writes.connection !== undefined) {
      this.#connections.set(connectionStorageKey(writes.connection.key), clone(writes.connection))
    }
    for (const stored of writes.attempts ?? []) {
      this.#attempts.set(
        attemptStorageKey(stored.attempt.key.namespace, stored.attempt.stateDigest),
        clone(stored),
      )
    }
    if (writes.receipt !== undefined) {
      const key =
        command._tag === 'InitializeConnection' ||
        command._tag === 'CreateAuthorizationAttempt' ||
        command._tag === 'AdmitAuthorizationAttempt' ||
        command._tag === 'CloseAuthorizationAttempt' ||
        command._tag === 'CompleteAuthorizationAttempt'
          ? storeCommandKey(command)
          : credentialOperationCommandKey(command)
      this.#receipts.set(
        receiptStorageKey(key.namespace, command.request.requestId),
        clone(writes.receipt),
      )
    }
    return clone(transition.result)
  }
}
