export interface ReplaySafeRecovery {
  readonly _tag: 'ReplaySafe'
  readonly retryUntil: number
  readonly retryAt: number
}

export type CredentialFailureRecovery = 'NotDispatched' | ReplaySafeRecovery

export function recoveryMatches(
  left: CredentialFailureRecovery | undefined,
  right: CredentialFailureRecovery | undefined,
): boolean {
  if (left === right) return true
  return (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    left._tag === right._tag &&
    left.retryUntil === right.retryUntil &&
    left.retryAt === right.retryAt
  )
}
