import { afterEach, describe, expect, test } from 'vitest'
import { startSalesforceServer, type SalesforceTestServer } from './salesforce-server.js'

const servers = new Set<SalesforceTestServer>()

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('deterministic Salesforce server', () => {
  test('counts authorization and token requests independently and consumes scripted responses', async () => {
    const server = await startSalesforceServer({
      authorization: [
        { _tag: 'Grant', code: 'code-one' },
        { _tag: 'Deny', error: 'access_denied' },
      ],
      token: [
        {
          _tag: 'Response',
          status: 200,
          json: {
            access_token: 'access-one',
            refresh_token: 'refresh-one',
            instance_url: 'https://instance.example.test',
            token_type: 'Bearer',
            issued_at: '1000',
            expires_in: 3600,
          },
        },
      ],
    })
    servers.add(server)

    const authorizationUrl = new URL('/services/oauth2/authorize', server.loginUrl)
    authorizationUrl.search = new URLSearchParams({
      redirect_uri: 'https://app.example.test/oauth/callback',
      state: 'state-one',
    }).toString()

    const grant = await fetch(authorizationUrl, { redirect: 'manual' })
    const denial = await fetch(authorizationUrl, { redirect: 'manual' })
    const token = await fetch(new URL('/services/oauth2/token', server.loginUrl), {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'code-one' }),
    })

    expect(grant.headers.get('location')).toBe(
      'https://app.example.test/oauth/callback?code=code-one&state=state-one',
    )
    expect(denial.headers.get('location')).toBe(
      'https://app.example.test/oauth/callback?error=access_denied&state=state-one',
    )
    await expect(token.json()).resolves.toMatchObject({ access_token: 'access-one' })
    expect(server.authorizationRequestCount).toBe(2)
    expect(server.tokenRequestCount).toBe(1)
    expect(server.authorizationRequests[0]?.query.get('state')).toBe('state-one')
    expect(server.tokenRequests[0]?.form.get('grant_type')).toBe('authorization_code')
  })

  test('scripts a transport failure without consuming another endpoint counter', async () => {
    const server = await startSalesforceServer({ token: [{ _tag: 'TransportFailure' }] })
    servers.add(server)

    await expect(
      fetch(new URL('/services/oauth2/token', server.loginUrl), {
        method: 'POST',
        body: new URLSearchParams({ code: 'lost-response' }),
      }),
    ).rejects.toThrow(/./)
    expect(server.authorizationRequestCount).toBe(0)
    expect(server.tokenRequestCount).toBe(1)
  })
})
