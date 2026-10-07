import { Convex } from '@indev42/connections/stores/convex'
import type { ComponentApi } from '@indev42/connections/stores/convex/_generated/component.js'

export type PackagedConnectionsComponent = ComponentApi<'connections'>

if (typeof Convex.run !== 'function') throw new Error('Missing Convex.run')
