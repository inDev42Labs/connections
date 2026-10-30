import { Effect } from 'effect'

const maximumJsonResponseBytes = 1024 * 1024

export type CredentialHttpResponse =
  | { readonly _tag: 'Success'; readonly body: unknown }
  | {
      readonly _tag: 'HttpFailure'
      readonly status: number
      readonly retryAfter: string | null
      readonly body: unknown
    }

/** Owns the request and body lifetime; provider adapters interpret the returned evidence. */
export function postCredentialRequest(options: {
  readonly url: URL
  readonly body: string | URLSearchParams
  readonly headers: Readonly<Record<string, string>>
  readonly fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
  readonly errorBodyStatuses?: readonly number[]
}): Effect.Effect<CredentialHttpResponse, unknown> {
  return Effect.tryPromise({
    try: async (effectSignal) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      effectSignal.addEventListener('abort', abort, { once: true })
      if (effectSignal.aborted) abort()
      const timeout = setTimeout(abort, 30_000)
      try {
        const response = await (options.fetch ?? fetch)(options.url, {
          method: 'POST',
          headers: options.headers,
          body: options.body,
          redirect: 'error',
          signal: controller.signal,
        })
        try {
          if (response.ok) {
            return { _tag: 'Success' as const, body: await readBoundedJsonResponse(response) }
          }
          const body = options.errorBodyStatuses?.includes(response.status)
            ? await readBoundedJsonResponse(response).catch(() => null)
            : null
          return {
            _tag: 'HttpFailure' as const,
            status: response.status,
            retryAfter: response.headers.get('retry-after'),
            body,
          }
        } finally {
          // Discard unread error bodies and cancel readers abandoned by a read failure.
          void response.body?.cancel().catch(() => undefined)
        }
      } finally {
        clearTimeout(timeout)
        effectSignal.removeEventListener('abort', abort)
      }
    },
    catch: (error) => error,
  })
}

export class MalformedJsonResponse extends Error {}

export function oauthErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const error = Reflect.get(body, 'error')
  return typeof error === 'string' ? error : null
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
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
