export { oauth, selfClient } from './zoho.js'
export type { ZohoCredentials, ZohoOAuth, ZohoSecret, ZohoSelfClient, ZohoText } from './zoho.js'

import { oauth, selfClient } from './zoho.js'

export const Zoho = { oauth, selfClient } as const
