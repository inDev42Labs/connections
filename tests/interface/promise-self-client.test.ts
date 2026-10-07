import { Buffer } from 'node:buffer'
import { afterEach, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../src/index.js'
import { Zoho } from '../../src/providers/zoho/index.js'
import { Memory } from '../../src/stores/memory/index.js'

const encryptionKey = Buffer.alloc(32, 77).toString('base64')

afterEach(() => vi.unstubAllGlobals())

test('Self Client setup accepts a one-use string code and requires explicit replacement', async () => {
  const exchanged: string[] = []
  vi.stubGlobal('fetch', async (_url: string | URL | Request, init: RequestInit) => {
    const parameters = init.body as URLSearchParams
    const code = parameters.get('code')
    if (code === null) throw new Error('Missing Self Client code')
    exchanged.push(code)
    return Response.json({
      access_token: `access-for-${code}`,
      refresh_token: `refresh-for-${code}`,
      api_domain: 'https://www.zohoapis.example',
      token_type: 'Bearer',
      expires_in: 3600,
    })
  })

  const manager = Connections.create({
    store: Memory.store({ encryptionKey }),
    provider: Zoho.selfClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountsOrigin: 'https://accounts.zoho.example',
    }),
  })
  const denied = new Error('Not permitted to enroll this account')
  await expect(
    manager.enrollCode('zoho', { code: 'denied-code', authorize: () => Promise.reject(denied) }),
  ).rejects.toBe(denied)
  expect(exchanged).toEqual([])

  await manager.enrollCode('zoho', { code: 'first-code', authorize: async () => undefined })
  expect(revealSecret((await manager.credentials('zoho')).accessToken)).toBe(
    'access-for-first-code',
  )
  await expect(
    manager.enrollCode('zoho', { code: 'conflicting-code', authorize: async () => undefined }),
  ).rejects.toMatchObject({ reason: 'Conflict' })
  expect(exchanged).toEqual(['first-code'])

  await manager.enrollCode('zoho', {
    code: 'replacement-code',
    replace: true,
    authorize: async () => undefined,
  })
  expect(revealSecret((await manager.credentials('zoho')).accessToken)).toBe(
    'access-for-replacement-code',
  )
  expect(exchanged).toEqual(['first-code', 'replacement-code'])
})
