import connections from '@indev42/connections/stores/convex/convex.config.js'
import { defineApp } from 'convex/server'

const app = defineApp()
app.use(connections, { name: 'connections' })

export default app
