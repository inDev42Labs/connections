export type YotpoFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface YotpoRequest {
  readonly url: string
  readonly init: RequestInit | undefined
}

export function makeYotpoTokenSubstitute(responses: readonly (Response | Error)[]) {
  const requests: YotpoRequest[] = []
  let index = 0
  const fetch: YotpoFetch = async (input, init) => {
    requests.push({ url: String(input), init })
    const response = responses[index++]
    if (response === undefined) throw new Error('Unexpected Yotpo token request')
    if (response instanceof Error) throw response
    return response
  }
  return { fetch, requests: () => [...requests] }
}

export function yotpoTokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ access_token: 'yotpo-access-token', token_type: 'Bearer', ...overrides })
}
