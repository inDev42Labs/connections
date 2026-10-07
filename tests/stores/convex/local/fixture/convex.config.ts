import { defineApp } from 'convex/server'
import { v } from 'convex/values'
import connections from '../../../../../src/stores/convex/component/convex.config.js'

const app = defineApp({
  env: {
    CONNECTIONS_TEST_KEY: v.optional(v.string()),
    SALESFORCE_TEST_BINDING: v.optional(v.string()),
    SALESFORCE_TEST_CLIENT_ID: v.optional(v.string()),
    SALESFORCE_TEST_CLIENT_SECRET: v.optional(v.string()),
    SALESFORCE_TEST_CONNECTION_ID: v.optional(v.string()),
    SALESFORCE_TEST_LOGIN_URL: v.optional(v.string()),
  },
})
app.use(connections, { name: 'connections' })
export default app
