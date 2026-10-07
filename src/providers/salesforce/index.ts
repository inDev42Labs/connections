export { clientCredentials } from './client-credentials.js'
export type {
  SalesforceClientCredentials,
  SalesforceClientCredentialsOptions,
  SalesforceSourceCredentials,
} from './client-credentials.js'
export { oauth } from './salesforce.js'
export type { SalesforceCredentials, SalesforceOAuth } from './salesforce.js'

import { oauth } from './salesforce.js'
import { clientCredentials } from './client-credentials.js'

export const Salesforce = { oauth, clientCredentials } as const
