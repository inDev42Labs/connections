# Use Connections with PostgreSQL

> **Built-in PostgreSQL interface.** `PostgreSQL.store({ pool, encryptionKey })` and `Connections.create` are available in this checkout. A real PostgreSQL backend was not part of the default verification suite; see the verification limits below.

Use this store when your application supplies a PostgreSQL-compatible pool. Connections owns its schema within the chosen database schema, but your application owns pool creation and shutdown.

```ts
import pg from 'pg'
import { Connections } from '@indev42/connections'
import { PostgreSQL } from '@indev42/connections/stores/postgresql'
import { Salesforce } from '@indev42/connections/providers/salesforce'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = PostgreSQL.store({
  pool,
  schema: 'connections',
  encryptionKey: process.env.CONNECTIONS_ENCRYPTION_KEY!,
})
const salesforce = Connections.create({
  store,
  provider: Salesforce.oauth({
    clientId: process.env.SALESFORCE_CLIENT_ID!,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET!,
    redirectUri: process.env.SALESFORCE_REDIRECT_URI!,
    scopes: ['api', 'refresh_token'],
  }),
})

// In an authenticated server-side request:
const credentials = await salesforce.credentials(connectionId)
```

Use the [common workflows](../getting-started.md) for saving or authorizing a connection. Configure the pool's connection limit and lifetime for your deployment; do not create a new global pool on every request in a serverless runtime. Some serverless drivers require a request-scoped pool instead. In either case, the store must retain transactional conditional-write semantics; do not replace it with independent reads and writes. Close the pool according to your application's lifecycle.

The existing PostgreSQL tests use a local PGlite-backed protocol endpoint. Real-backend advisory-lock verification requires `DATABASE_URL` and `bun run test:postgresql:real`; the local substitute is not a production PostgreSQL compatibility guarantee.
