import { defineApp } from 'convex/server'
import { v } from 'convex/values'
import credentialStore from '../component/convex.config.js'

// Fake-only local fixture key. Optional so codegen can run before local env setup.
const app = defineApp({ env: { CONNECTIONS_TEST_KEY: v.optional(v.string()) } })
app.use(credentialStore, { name: 'credentialStore' })
export default app
