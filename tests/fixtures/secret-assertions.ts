import { inspect } from 'node:util'

export interface SecretCanary {
  readonly label: string
  readonly value: string
}

export function makeSecretCanary(label: string): SecretCanary {
  if (label.length === 0) {
    throw new TypeError('A secret canary requires a label')
  }

  return {
    label,
    value: `__connections_secret_canary:${label}__`,
  }
}

function containsSecret(value: unknown, secret: string, seen: Set<object>): boolean {
  if (typeof value === 'string') return value.includes(secret)
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)

  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (containsSecret(key, secret, seen) || containsSecret(entry, secret, seen)) return true
    }
  } else if (value instanceof Set) {
    for (const entry of value) {
      if (containsSecret(entry, secret, seen)) return true
    }
  }

  for (const key of Reflect.ownKeys(value)) {
    const keyText = typeof key === 'string' ? key : key.description
    if (keyText?.includes(secret) === true) return true
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor !== undefined &&
      'value' in descriptor &&
      containsSecret(descriptor.value, secret, seen)
    )
      return true
  }

  return false
}

export function assertSecretCanariesAbsent(
  canaries: ReadonlyArray<SecretCanary>,
  ...observations: ReadonlyArray<unknown>
): void {
  const rendered = observations.map((observation) =>
    typeof observation === 'string'
      ? observation
      : inspect(observation, {
          depth: null,
          getters: false,
        }),
  )

  for (const canary of canaries) {
    const structurallyPresent = observations.some((observation) =>
      containsSecret(observation, canary.value, new Set()),
    )
    if (structurallyPresent || rendered.some((observation) => observation.includes(canary.value))) {
      throw new Error(`Secret canary leaked: ${canary.label}`)
    }
  }
}
