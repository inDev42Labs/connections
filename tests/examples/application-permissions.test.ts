import { afterEach, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../src/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Memory } from '../../src/stores/memory/index.js'

// This is an application usage example, not a claim that Connections owns permissions.
// The application's authenticated identity and connection ownership decide access.
class ApplicationDenied extends Error {}
type Operation = 'start' | 'replace' | 'credentials' | 'inspect' | 'remove'

afterEach(() => vi.unstubAllGlobals())

test('application entry points check caller authority before using a connection ID', async () => {
  const owners = new Map([
    ['owned', 'alice'],
    ['new-owned', 'alice'],
    ['foreign', 'bob'],
  ])
  const tokenEndpoint = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(async () =>
    Response.json({
      access_token: 'application-use-token',
      refresh_token: 'retained-refresh-token',
      instance_url: 'https://instance.example.test',
      token_type: 'Bearer',
    }),
  )
  vi.stubGlobal('fetch', tokenEndpoint)
  const manager = Connections.create({
    store: Memory.store({ encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=' }),
    provider: Salesforce.oauth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://app.example/callback',
      scopes: ['api', 'refresh_token'],
    }),
  })
  const binding = 'server-verified-session'
  const initial = await manager.startAuthorization('owned', { binding })
  const callback = new URL('https://app.example/callback')
  callback.search = new URLSearchParams({
    code: 'initial-code',
    state: new URL(initial.url).searchParams.get('state')!,
  }).toString()
  await manager.completeAuthorization({
    callbackUrl: callback.toString(),
    binding,
    authorize: ({ connectionId }) => {
      if (owners.get(connectionId) !== 'alice') throw new ApplicationDenied()
    },
  })

  // In a real route, caller and binding come from authenticated server-side evidence.
  async function handle(caller: string, connectionId: string, operation: Operation) {
    if (owners.get(connectionId) !== caller) throw new ApplicationDenied()
    switch (operation) {
      case 'start':
        return manager.startAuthorization(connectionId, { binding })
      case 'replace':
        return manager.startAuthorization(connectionId, { binding, replace: true })
      case 'credentials':
        return manager.credentials(connectionId)
      case 'inspect':
        return manager.inspect(connectionId)
      case 'remove':
        return manager.remove(connectionId)
    }
  }

  for (const operation of ['start', 'replace', 'credentials', 'inspect', 'remove'] as const) {
    await expect(handle('mallory', 'owned', operation)).rejects.toBeInstanceOf(ApplicationDenied)
    await expect(handle('alice', 'foreign', operation)).rejects.toBeInstanceOf(ApplicationDenied)
  }
  expect(revealSecret((await manager.credentials('owned')).accessToken)).toBe(
    'application-use-token',
  )
  expect(await manager.inspect('foreign')).toEqual({
    savedAuthorization: false,
    credentialWork: 'idle',
  })
  expect(tokenEndpoint).toHaveBeenCalledOnce()

  await expect(handle('alice', 'new-owned', 'start')).resolves.toHaveProperty('url')
  await expect(handle('alice', 'owned', 'replace')).resolves.toHaveProperty('url')
  await expect(handle('alice', 'owned', 'credentials')).resolves.toHaveProperty('instanceUrl')
  await expect(handle('alice', 'owned', 'inspect')).resolves.toEqual({
    savedAuthorization: true,
    credentialWork: 'idle',
  })
  await handle('alice', 'owned', 'remove')
  await expect(manager.credentials('owned')).rejects.toMatchObject({
    _tag: 'AuthorizationRequired',
  })
  expect(tokenEndpoint).toHaveBeenCalledOnce()
})
