import { components } from './_generated/api'
import { env } from './_generated/server'
import { AesGcm, Convex, fakeHttpRefresh, makeManager } from '../adapter'

// Lazy module-level definitions: no key reads, database calls, or captured ctx.
export const encryptor = AesGcm.make(() => env.CONNECTIONS_TEST_KEY)
export const store = Convex.store({ component: components.credentialStore, encryptor })
export const manager = makeManager({ store, refresh: fakeHttpRefresh(() => env.CONVEX_SITE_URL) })
export const keyFor = (id: string) => JSON.stringify(['fake-salesforce', id])
