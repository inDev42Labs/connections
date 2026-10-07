const maximumJsonResponseBytes = 1024 * 1024

export class MalformedJsonResponse extends Error {}

export function oauthErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const error = Reflect.get(body, 'error')
  return typeof error === 'string' ? error : null
}

export async function readOAuthErrorCode(response: Response): Promise<string | null> {
  try {
    return oauthErrorCode(await readBoundedJsonResponse(response))
  } catch {
    return null
  }
}

export async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumJsonResponseBytes)
  ) {
    void response.body?.cancel().catch(() => undefined)
    throw new MalformedJsonResponse()
  }
  if (response.body === null) throw new MalformedJsonResponse()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximumJsonResponseBytes) {
        await reader.cancel().catch(() => undefined)
        throw new MalformedJsonResponse()
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return JSON.parse(text) as unknown
  } catch {
    throw new MalformedJsonResponse()
  }
}
