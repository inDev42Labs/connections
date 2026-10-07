import { httpRouter } from 'convex/server'
import { Convex } from '../../../../../src/stores/convex/index.js'
import { httpAction } from './_generated/server.js'
import { isLocalConnectionId, localBinding, salesforce } from './connections.js'

const http = httpRouter()

http.route({
  path: '/salesforce/callback',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    try {
      const completed = await Convex.bind(ctx, salesforce).completeAuthorization({
        callbackUrl: request.url,
        binding: localBinding(),
        authorize: ({ connectionId }) => {
          if (!isLocalConnectionId(connectionId)) throw new Error('Local application denied')
        },
      })
      return Response.json(completed)
    } catch {
      return Response.json({ error: 'Authorization failed' }, { status: 400 })
    }
  }),
})

export default http
