import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { components } from './_generated/api'
import { requireLocalFixture } from './localOnly'

const http = httpRouter()
http.route({
  path: '/fake-oauth',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    requireLocalFixture()
    const body: unknown = await request.json()
    if (typeof body !== 'object' || body === null || !('key' in body) || !('refreshToken' in body)
      || typeof body.key !== 'string' || typeof body.refreshToken !== 'string') {
      return new Response('Invalid fixture request', { status: 400 })
    }
    await ctx.runMutation(components.credentialStore.records.recordHttpAttempt, { key: body.key })
    try {
      // Models a remote side effect in a transaction separate from credential commit.
      const result = await ctx.runMutation(components.credentialStore.records.fakeExchange, {
        key: body.key, refreshToken: body.refreshToken,
      })
      return Response.json(result)
    } catch {
      return new Response('Fake exchange rejected', { status: 400 })
    }
  }),
})
export default http
