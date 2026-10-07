import { Convex } from '@indev42/connections/stores/convex'
import component from '@indev42/connections/stores/convex/convex.config.js'

if (typeof Convex.run !== 'function') throw new Error('Missing Convex.run')
if (typeof Convex.store !== 'function') throw new Error('Missing Convex.store')
if (typeof component !== 'object') throw new Error('Invalid packaged Convex component')
