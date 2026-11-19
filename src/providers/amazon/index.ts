export { oauth } from './amazon.js'
export type { AmazonOAuth, AmazonSecret, AmazonText } from './amazon.js'
export type { AmazonCredentials } from './responses.js'

import { oauth } from './amazon.js'

export const Amazon = { oauth } as const
