import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

export interface ScriptedResponse {
  readonly _tag: 'Response'
  readonly status: number
  readonly json?: unknown
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly delayMilliseconds?: number
}

export interface ScriptedTransportFailure {
  readonly _tag: 'TransportFailure'
}

export type ScriptedAuthorizationOutcome =
  | { readonly _tag: 'Grant'; readonly code: string }
  | { readonly _tag: 'Deny'; readonly error?: string }
  | ScriptedResponse
  | ScriptedTransportFailure

export type ScriptedTokenOutcome = ScriptedResponse | ScriptedTransportFailure

export interface RecordedAuthorizationRequest {
  readonly url: URL
  readonly query: URLSearchParams
}

export interface RecordedTokenRequest {
  readonly url: URL
  readonly form: URLSearchParams
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
}

export interface SalesforceTestServer {
  readonly loginUrl: string
  readonly authorizationRequestCount: number
  readonly tokenRequestCount: number
  readonly authorizationRequests: ReadonlyArray<RecordedAuthorizationRequest>
  readonly tokenRequests: ReadonlyArray<RecordedTokenRequest>
  readonly close: () => Promise<void>
}

export interface SalesforceTestServerScript {
  readonly authorization?: ReadonlyArray<ScriptedAuthorizationOutcome>
  readonly token?: ReadonlyArray<ScriptedTokenOutcome>
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

async function writeScriptedResponse(
  response: ServerResponse,
  outcome: ScriptedResponse,
): Promise<void> {
  if (outcome.delayMilliseconds !== undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, outcome.delayMilliseconds))
  }
  const body = outcome.json === undefined ? (outcome.body ?? '') : JSON.stringify(outcome.json)
  response.writeHead(outcome.status, {
    ...(outcome.json === undefined ? {} : { 'content-type': 'application/json' }),
    ...outcome.headers,
  })
  response.end(body)
}

function failTransport(request: IncomingMessage): void {
  request.socket.destroy()
}

export async function startSalesforceServer(
  script: SalesforceTestServerScript = {},
): Promise<SalesforceTestServer> {
  const authorization = [...(script.authorization ?? [])]
  const token = [...(script.token ?? [])]
  const authorizationRequests: RecordedAuthorizationRequest[] = []
  const tokenRequests: RecordedTokenRequest[] = []

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')

      if (request.method === 'GET' && requestUrl.pathname === '/services/oauth2/authorize') {
        authorizationRequests.push({
          url: new URL(requestUrl),
          query: new URLSearchParams(requestUrl.searchParams),
        })
        const outcome = authorization.shift() ?? {
          _tag: 'Response' as const,
          status: 500,
          body: 'No authorization outcome scripted',
        }
        if (outcome._tag === 'TransportFailure') {
          failTransport(request)
          return
        }
        if (outcome._tag === 'Response') {
          await writeScriptedResponse(response, outcome)
          return
        }

        const redirectUri = requestUrl.searchParams.get('redirect_uri')
        const state = requestUrl.searchParams.get('state')
        if (redirectUri === null || state === null) {
          response.writeHead(400)
          response.end('Missing redirect_uri or state')
          return
        }
        const location = new URL(redirectUri)
        if (outcome._tag === 'Grant') location.searchParams.set('code', outcome.code)
        else location.searchParams.set('error', outcome.error ?? 'access_denied')
        location.searchParams.set('state', state)
        response.writeHead(302, { location: location.toString() })
        response.end()
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/services/oauth2/token') {
        const body = await requestBody(request)
        tokenRequests.push({
          url: new URL(requestUrl),
          form: new URLSearchParams(body),
          headers: { ...request.headers },
        })
        const outcome = token.shift() ?? {
          _tag: 'Response' as const,
          status: 500,
          body: 'No token outcome scripted',
        }
        if (outcome._tag === 'TransportFailure') {
          failTransport(request)
          return
        }
        await writeScriptedResponse(response, outcome)
        return
      }

      response.writeHead(404)
      response.end('Not found')
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end('Fixture failure')
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  let closed = false

  return {
    loginUrl: `http://127.0.0.1:${address.port}`,
    get authorizationRequestCount() {
      return authorizationRequests.length
    },
    get tokenRequestCount() {
      return tokenRequests.length
    },
    authorizationRequests,
    tokenRequests,
    close: async () => {
      if (closed) return
      closed = true
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}
