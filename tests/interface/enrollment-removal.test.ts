import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../src/index.js'
import { Zoho } from '../../src/providers/zoho/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'

const redirectUri = 'https://app.example.test/oauth/zoho/callback'
const binding = 'trusted-session'
const connectionId = 'zoho-enrollment'

function requestCode(init?: RequestInit): string {
  if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected token request body')
  const code = init.body.get('code')
  if (code === null) throw new Error('Expected an enrollment code')
  return code
}

function tokenResponse(code: string) {
  return Response.json({
    access_token: `access-for-${code}`,
    refresh_token: `refresh-for-${code}`,
    api_domain: 'https://www.zohoapis.example',
    token_type: 'Bearer',
    expires_in: 3600,
  })
}

function browserManager() {
  return Connections.create({
    store: makeInMemoryStore(),
    provider: Zoho.oauth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri,
      scopes: ['ZohoCRM.modules.ALL'],
      accountsOrigin: 'https://accounts.zoho.example',
    }),
  })
}

async function prepareBrowserEnrollment(manager: ReturnType<typeof browserManager>, code: string) {
  const start = await manager.startAuthorization(connectionId, { binding })
  const state = new URL(start.url).searchParams.get('state')
  if (state === null) throw new Error('Expected OAuth state')
  const callback = new URL(redirectUri)
  callback.search = new URLSearchParams({ code, state }).toString()
  return () =>
    manager.completeAuthorization({
      callbackUrl: callback.toString(),
      binding,
      authorize: async () => undefined,
    })
}

afterEach(() => vi.unstubAllGlobals())

describe('removal fences initial enrollment through public managers', () => {
  test.each([false, true])(
    'invalidates a prepared browser callback without exchanging its code, previously removed: %s',
    async (previouslyRemoved) => {
      const fetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
        async (_url, init) => tokenResponse(requestCode(init)),
      )
      vi.stubGlobal('fetch', fetch)
      const manager = browserManager()
      if (previouslyRemoved) {
        await (
          await prepareBrowserEnrollment(manager, 'earlier-code')
        )()
        await manager.remove(connectionId)
        fetch.mockClear()
      }
      const complete = await prepareBrowserEnrollment(manager, 'removed-code')

      await manager.remove(connectionId)
      await expect(manager.inspect(connectionId)).resolves.toEqual({
        savedAuthorization: false,
        credentialWork: 'idle',
      })
      await expect(complete()).rejects.toMatchObject({ reason: 'InvalidAttempt' })
      expect(fetch).not.toHaveBeenCalled()
      await expect(manager.credentials(connectionId)).rejects.toMatchObject({
        _tag: 'AuthorizationRequired',
      })

      await (
        await prepareBrowserEnrollment(manager, 'fresh-code')
      )()
      expect(revealSecret((await manager.credentials(connectionId)).accessToken)).toBe(
        'access-for-fresh-code',
      )
    },
  )

  for (const mechanism of ['browser', 'self-client'] as const) {
    test.each([false, true])(
      `${mechanism}: delayed exchange cannot restore authorization or overwrite reenrollment, reenroll before completion: %s`,
      async (reenrollBeforeCompletion) => {
        const reached = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const requests: string[] = []
        vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
          const code = requestCode(init)
          requests.push(code)
          if (code === 'removed-code') {
            reached.resolve()
            await release.promise
          }
          return tokenResponse(code)
        })
        const store = makeInMemoryStore()
        const browser = Connections.create({
          store,
          provider: Zoho.oauth({
            clientId: 'client-id',
            clientSecret: 'client-secret',
            redirectUri,
            scopes: ['ZohoCRM.modules.ALL'],
            accountsOrigin: 'https://accounts.zoho.example',
          }),
        })
        const selfClient = Connections.create({
          store,
          provider: Zoho.selfClient({
            clientId: 'client-id',
            clientSecret: 'client-secret',
            accountsOrigin: 'https://accounts.zoho.example',
          }),
        })
        const manager = mechanism === 'browser' ? browser : selfClient
        const enroll = async (code: string) => {
          if (mechanism === 'browser') {
            await (
              await prepareBrowserEnrollment(browser, code)
            )()
          } else {
            await selfClient.enrollCode(connectionId, {
              code,
              authorize: async () => undefined,
            })
          }
        }
        const completion = enroll('removed-code').then(
          () => ({ succeeded: true }),
          (failure: unknown) => ({ failure }),
        )
        try {
          await reached.promise
          await expect(manager.inspect(connectionId)).resolves.toEqual({
            savedAuthorization: false,
            credentialWork: 'pending',
          })
          await manager.remove(connectionId)
          await expect(manager.inspect(connectionId)).resolves.toEqual({
            savedAuthorization: false,
            credentialWork: 'idle',
          })
          await expect(manager.credentials(connectionId)).rejects.toMatchObject({
            _tag: 'AuthorizationRequired',
          })
          if (reenrollBeforeCompletion) await enroll('fresh-code')
          release.resolve()
          await expect(completion).resolves.toMatchObject({ failure: { reason: 'Conflict' } })
          await expect(manager.inspect(connectionId)).resolves.toEqual({
            savedAuthorization: reenrollBeforeCompletion,
            credentialWork: 'idle',
          })
          const readAfterCompletion = await manager.credentials(connectionId).then(
            (credentials) => ({ accessToken: revealSecret(credentials.accessToken) }),
            (failure: unknown) => failure,
          )
          expect(readAfterCompletion).toMatchObject(
            reenrollBeforeCompletion
              ? { accessToken: 'access-for-fresh-code' }
              : { _tag: 'AuthorizationRequired' },
          )
          if (!reenrollBeforeCompletion) await enroll('fresh-code')
          expect(revealSecret((await manager.credentials(connectionId)).accessToken)).toBe(
            'access-for-fresh-code',
          )
          await expect(manager.inspect(connectionId)).resolves.toEqual({
            savedAuthorization: true,
            credentialWork: 'idle',
          })
          expect(requests).toEqual(['removed-code', 'fresh-code'])
        } finally {
          release.resolve()
          await completion
        }
      },
    )
  }
})
