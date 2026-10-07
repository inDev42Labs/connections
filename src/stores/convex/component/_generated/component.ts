/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    attempts: {
      admit: FunctionReference<
        "mutation",
        "internal",
        {
          admission: {
            admissionExpiresAt: number;
            admissionId: string;
            admittedAt: number;
            generation: number;
            intent: "enroll" | "replace";
            key: {
              connectionId: string;
              namespace: string;
              providerId: string;
            };
            stateDigest: string;
          };
          leaseExpiresAt: number;
          operation: {
            kind:
              | "refresh"
              | "authorization-exchange"
              | "client-credentials-acquisition";
            operationId: string;
            recoveryDeadline: number;
            startedAt: number;
            transferLimit: number;
          };
          ownershipFence: string;
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      close: FunctionReference<
        "mutation",
        "internal",
        {
          closedAt: number;
          expectedGeneration: number;
          key: { connectionId: string; namespace: string; providerId: string };
          reason: "ProviderDenied";
          request: { inputDigest: string; requestId: string };
          stateDigest: string;
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      complete: FunctionReference<
        "mutation",
        "internal",
        {
          admission: {
            admissionExpiresAt: number;
            admissionId: string;
            admittedAt: number;
            generation: number;
            intent: "enroll" | "replace";
            key: {
              connectionId: string;
              namespace: string;
              providerId: string;
            };
            stateDigest: string;
          };
          completedAt: number;
          credentialEnvelope: {
            algorithm: "AES-256-GCM";
            ciphertext: string;
            iv: string;
            keyId: string;
            version: 1;
          };
          credentialExpiresAt: number | null;
          expectedRevision: number;
          operationId: string;
          ownershipFence: string;
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          attempt: {
            bindingDigest: string;
            createdAt: number;
            expiresAt: number;
            generation: number;
            intent: "enroll" | "replace";
            key: {
              connectionId: string;
              namespace: string;
              providerId: string;
            };
            pkceVerifierEnvelope: {
              algorithm: "AES-256-GCM";
              ciphertext: string;
              iv: string;
              keyId: string;
              version: 1;
            };
            schemaVersion: 1;
            stateDigest: string;
          };
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      read: FunctionReference<
        "query",
        "internal",
        {
          lookup: {
            bindingDigest: string;
            namespace: string;
            now: number;
            stateDigest: string;
          };
        },
        {
          bindingDigest: string;
          createdAt: number;
          expiresAt: number;
          generation: number;
          intent: "enroll" | "replace";
          key: { connectionId: string; namespace: string; providerId: string };
          pkceVerifierEnvelope: {
            algorithm: "AES-256-GCM";
            ciphertext: string;
            iv: string;
            keyId: string;
            version: 1;
          };
          schemaVersion: 1;
          stateDigest: string;
        } | null,
        Name
      >;
    };
    connections: {
      initialize: FunctionReference<
        "mutation",
        "internal",
        {
          key: { connectionId: string; namespace: string; providerId: string };
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      inspect: FunctionReference<
        "query",
        "internal",
        {
          key: { connectionId: string; namespace: string; providerId: string };
        },
        {
          credentialWork:
            "idle" | "pending" | "intervention-required" | "known-failure";
          key: { connectionId: string; namespace: string; providerId: string };
          savedAuthorization: boolean;
          schemaVersion: 1;
        } | null,
        Name
      >;
      invalidateCredential: FunctionReference<
        "mutation",
        "internal",
        {
          expectedGeneration: number;
          expectedRevision: number;
          key: { connectionId: string; namespace: string; providerId: string };
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      read: FunctionReference<
        "query",
        "internal",
        {
          key: { connectionId: string; namespace: string; providerId: string };
        },
        {
          authorization:
            | { _tag: "NotAuthorized" }
            | {
                _tag: "Authorized";
                credentialAcquiredAt?: number | null;
                credentialExpiresAt: number | null;
              };
          authorizationAttemptStateDigest: string | null;
          credentialEnvelope: {
            algorithm: "AES-256-GCM";
            ciphertext: string;
            iv: string;
            keyId: string;
            version: 1;
          } | null;
          credentialOperation:
            | {
                generation: number;
                kind:
                  | "refresh"
                  | "authorization-exchange"
                  | "client-credentials-acquisition";
                observedRevision: number;
                operationId: string;
                phase:
                  | {
                      _tag: "OwnedBeforeDispatch";
                      leaseExpiresAt: number;
                      ownershipFence: string;
                    }
                  | {
                      _tag: "DispatchPossible";
                      leaseExpiresAt: number;
                      ownershipFence: string;
                      reservedAt: number;
                    }
                  | {
                      _tag: "KnownFailure";
                      failedAt: number;
                      reason: "ProviderRejected" | "ProviderFailure";
                    }
                  | {
                      _tag: "InterventionRequired";
                      markedAt: number;
                      reason:
                        | "ProviderOutcomeUnknown"
                        | "KnownResponseNotPersisted"
                        | "DispatchOwnerExpired"
                        | "RecoveryLimitExceeded";
                    };
                recoveryDeadline: number;
                schemaVersion: 1;
                startedAt: number;
                transferCount: number;
                transferLimit: number;
              }
            | {
                generation: number;
                intent: "enroll" | "replace";
                kind: "self-client-exchange";
                observedRevision: number;
                operationId: string;
                phase:
                  | {
                      _tag: "OwnedBeforeDispatch";
                      leaseExpiresAt: number;
                      ownershipFence: string;
                    }
                  | {
                      _tag: "DispatchPossible";
                      leaseExpiresAt: number;
                      ownershipFence: string;
                      reservedAt: number;
                    }
                  | {
                      _tag: "KnownFailure";
                      failedAt: number;
                      reason: "ProviderRejected" | "ProviderFailure";
                    }
                  | {
                      _tag: "InterventionRequired";
                      markedAt: number;
                      reason:
                        | "ProviderOutcomeUnknown"
                        | "KnownResponseNotPersisted"
                        | "DispatchOwnerExpired"
                        | "RecoveryLimitExceeded";
                    };
                recoveryDeadline: number;
                schemaVersion: 1;
                startedAt: number;
                transferCount: number;
                transferLimit: number;
              }
            | null;
          generation: number;
          key: { connectionId: string; namespace: string; providerId: string };
          revision: number;
          schemaVersion: 1;
          storageKey: string;
        } | null,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        {
          expectedGeneration: number;
          expectedRevision: number;
          key: { connectionId: string; namespace: string; providerId: string };
          removedAt: number;
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      saveCredential: FunctionReference<
        "mutation",
        "internal",
        {
          credentialAcquiredAt?: number | null;
          credentialEnvelope: {
            algorithm: "AES-256-GCM";
            ciphertext: string;
            iv: string;
            keyId: string;
            version: 1;
          };
          credentialExpiresAt: number | null;
          expectedGeneration: number;
          expectedRevision: number;
          intent: "enroll" | "replace";
          key: { connectionId: string; namespace: string; providerId: string };
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
    };
    operations: {
      acquire: FunctionReference<
        "mutation",
        "internal",
        {
          acquiredAt: number;
          expectedGeneration: number;
          expectedRevision: number;
          key: { connectionId: string; namespace: string; providerId: string };
          leaseExpiresAt: number;
          ownershipFence: string;
          proposal: {
            kind:
              | "refresh"
              | "authorization-exchange"
              | "client-credentials-acquisition";
            operationId: string;
            recoveryDeadline: number;
            startedAt: number;
            transferLimit: number;
          };
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      admitSelfClientExchange: FunctionReference<
        "mutation",
        "internal",
        {
          acquiredAt: number;
          expectedGeneration: number;
          expectedRevision: number;
          intent: "enroll" | "replace";
          key: { connectionId: string; namespace: string; providerId: string };
          leaseExpiresAt: number;
          ownershipFence: string;
          proposal: {
            operationId: string;
            recoveryDeadline: number;
            startedAt: number;
            transferLimit: number;
          };
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      complete: FunctionReference<
        "mutation",
        "internal",
        {
          completedAt: number;
          credentialAcquiredAt?: number | null;
          credentialEnvelope: {
            algorithm: "AES-256-GCM";
            ciphertext: string;
            iv: string;
            keyId: string;
            version: 1;
          };
          credentialExpiresAt: number | null;
          expectedGeneration: number;
          expectedRevision: number;
          key: { connectionId: string; namespace: string; providerId: string };
          operationId: string;
          ownershipFence: string;
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      completeSelfClientExchange: FunctionReference<
        "mutation",
        "internal",
        {
          completedAt: number;
          credentialEnvelope: {
            algorithm: "AES-256-GCM";
            ciphertext: string;
            iv: string;
            keyId: string;
            version: 1;
          };
          credentialExpiresAt: number | null;
          expectedGeneration: number;
          expectedRevision: number;
          key: { connectionId: string; namespace: string; providerId: string };
          operationId: string;
          ownershipFence: string;
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      markIntervention: FunctionReference<
        "mutation",
        "internal",
        {
          expectedGeneration: number;
          expectedRevision: number;
          key: { connectionId: string; namespace: string; providerId: string };
          markedAt: number;
          operationId: string;
          ownershipFence: string | null;
          reason:
            | "ProviderOutcomeUnknown"
            | "KnownResponseNotPersisted"
            | "DispatchOwnerExpired"
            | "RecoveryLimitExceeded";
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      recordFailure: FunctionReference<
        "mutation",
        "internal",
        {
          expectedGeneration: number;
          expectedRevision: number;
          failedAt: number;
          key: { connectionId: string; namespace: string; providerId: string };
          operationId: string;
          ownershipFence: string;
          reason: "ProviderRejected" | "ProviderFailure";
          request: { inputDigest: string; requestId: string };
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
      reserveDispatch: FunctionReference<
        "mutation",
        "internal",
        {
          expectedGeneration: number;
          expectedRevision: number;
          key: { connectionId: string; namespace: string; providerId: string };
          operationId: string;
          ownershipFence: string;
          request: { inputDigest: string; requestId: string };
          reservedAt: number;
        },
        | { _tag: "ConnectionInitialized"; generation: 0; revision: 0 }
        | {
            _tag: "AuthorizationAttemptCreated";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptAdmitted";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "AuthorizationAttemptClosed";
            generation: number;
            revision: number;
          }
        | {
            _tag: "AuthorizationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeAdmitted";
            generation: number;
            operation: {
              generation: number;
              intent: "enroll" | "replace";
              kind: "self-client-exchange";
              observedRevision: number;
              operationId: string;
              phase:
                | {
                    _tag: "OwnedBeforeDispatch";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                  }
                | {
                    _tag: "DispatchPossible";
                    leaseExpiresAt: number;
                    ownershipFence: string;
                    reservedAt: number;
                  }
                | {
                    _tag: "KnownFailure";
                    failedAt: number;
                    reason: "ProviderRejected" | "ProviderFailure";
                  }
                | {
                    _tag: "InterventionRequired";
                    markedAt: number;
                    reason:
                      | "ProviderOutcomeUnknown"
                      | "KnownResponseNotPersisted"
                      | "DispatchOwnerExpired"
                      | "RecoveryLimitExceeded";
                  };
              recoveryDeadline: number;
              schemaVersion: 1;
              startedAt: number;
              transferCount: number;
              transferLimit: number;
            };
            revision: number;
          }
        | {
            _tag: "SelfClientExchangeCompleted";
            generation: number;
            revision: number;
          }
        | { _tag: "CredentialSaved"; generation: number; revision: number }
        | {
            _tag: "CredentialOperationAcquired";
            generation: number;
            operation:
              | {
                  generation: number;
                  kind:
                    | "refresh"
                    | "authorization-exchange"
                    | "client-credentials-acquisition";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                }
              | {
                  generation: number;
                  intent: "enroll" | "replace";
                  kind: "self-client-exchange";
                  observedRevision: number;
                  operationId: string;
                  phase:
                    | {
                        _tag: "OwnedBeforeDispatch";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                      }
                    | {
                        _tag: "DispatchPossible";
                        leaseExpiresAt: number;
                        ownershipFence: string;
                        reservedAt: number;
                      }
                    | {
                        _tag: "KnownFailure";
                        failedAt: number;
                        reason: "ProviderRejected" | "ProviderFailure";
                      }
                    | {
                        _tag: "InterventionRequired";
                        markedAt: number;
                        reason:
                          | "ProviderOutcomeUnknown"
                          | "KnownResponseNotPersisted"
                          | "DispatchOwnerExpired"
                          | "RecoveryLimitExceeded";
                      };
                  recoveryDeadline: number;
                  schemaVersion: 1;
                  startedAt: number;
                  transferCount: number;
                  transferLimit: number;
                };
            revision: number;
          }
        | {
            _tag: "CredentialOperationDispatchReserved";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationCompleted";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialOperationFailed";
            generation: number;
            reason: "ProviderRejected" | "ProviderFailure";
            revision: number;
          }
        | {
            _tag: "CredentialOperationInterventionMarked";
            generation: number;
            revision: number;
          }
        | {
            _tag: "CredentialInvalidated";
            generation: number;
            revision: number;
          }
        | { _tag: "ConnectionRemoved"; generation: number; revision: number }
        | {
            _tag: "StoreConflict";
            reason: "RequestIdReused" | "ConditionChanged";
          },
        Name
      >;
    };
  };
