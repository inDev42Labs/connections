function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function randomOpaqueValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

export function randomAuthorizationState(): string {
  return randomOpaqueValue()
}

export function randomPkceVerifier(): string {
  return randomOpaqueValue()
}

export function randomRequestId(): string {
  return crypto.randomUUID()
}

export function s256PkceChallenge(verifier: string): Promise<string> {
  return sha256(verifier)
}

export function digestAuthorizationState(state: string): Promise<string> {
  return sha256(JSON.stringify(['authorization-state', state]))
}

export function digestAuthorizationBinding(binding: string): Promise<string> {
  return sha256(JSON.stringify(['authorization-binding', binding]))
}
