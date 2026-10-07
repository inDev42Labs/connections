import { Effect, Redacted } from 'effect'
import { AesGcm } from '../../../../../src/encryptors/aes-gcm/index.js'
import { ApiKey } from '../../../../../src/providers/api-key/index.js'
import { Connections } from '../../../../../src/index.js'
import { Salesforce } from '../../../../../src/providers/salesforce/index.js'
import { Configuration } from '../../../../../src/configuration/index.js'
import {
  Convex,
  type ConvexQueryInvocationContext,
} from '../../../../../src/stores/convex/index.js'
import { components } from './_generated/api.js'
import { env } from './_generated/server.js'

export const store = Convex.store({
  component: components.connections,
  encryptor: AesGcm.encryptor({
    key: Configuration.secret(() => env.CONNECTIONS_TEST_KEY),
    keyId: 'local-phase-3',
  }),
})

const provider = Salesforce.oauth({
  clientId: Configuration.string(() => env.SALESFORCE_TEST_CLIENT_ID),
  clientSecret: Configuration.secret(() => env.SALESFORCE_TEST_CLIENT_SECRET),
  redirectUri: Configuration.string(() => `${env.CONVEX_SITE_URL}/salesforce/callback`),
  scopes: ['api', 'refresh_token'],
  loginUrl: Configuration.string(() => env.SALESFORCE_TEST_LOGIN_URL),
})

export const salesforce = Connections.create({
  provider,
  store,
})

const promiseStore = Convex.store({
  component: components.connections,
  encryptionKey: () => {
    const key = env.CONNECTIONS_TEST_KEY
    if (key === undefined) throw new Error('Local fixture encryption key is missing')
    return key
  },
})

export const promiseApiKey = Connections.create({
  store: promiseStore,
  provider: ApiKey.opaque({ id: 'local-promise-key' }),
})

const wrongKeyStore = Convex.store({
  component: components.connections,
  encryptor: AesGcm.encryptor({
    key: Configuration.secret(() => 'KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys='),
    keyId: 'local-phase-3',
  }),
})

export const salesforceWithWrongEncryptionKey = Connections.create({
  provider,
  store: wrongKeyStore,
})

let clientCredentialRequests = 0
const clientCredentialsProvider = {
  id: 'default',
  prepareClientCredentials: (credentials: { readonly source: Redacted.Redacted<string> }) =>
    Effect.succeed({
      protectedPayload: Redacted.make(
        JSON.stringify({ source: Redacted.value(credentials.source), token: null }),
      ),
    }),
  acquireCredentials: ({
    protectedPayload,
  }: {
    readonly protectedPayload: Redacted.Redacted<string>
  }) =>
    Effect.sync(() => {
      const payload = JSON.parse(Redacted.value(protectedPayload)) as { readonly source: string }
      clientCredentialRequests++
      if (payload.source === 'unknown') return { _tag: 'ProviderOutcomeUnknown' as const }
      return {
        _tag: 'Acquired' as const,
        credentials: {
          protectedPayload: Redacted.make(
            JSON.stringify({ source: payload.source, token: `issued-${clientCredentialRequests}` }),
          ),
          credentialExpiresAt: null,
        },
      }
    }),
  projectCredentials: (protectedPayload: Redacted.Redacted<string>) =>
    Effect.sync(() => {
      const payload = JSON.parse(Redacted.value(protectedPayload)) as {
        readonly token: string | null
      }
      if (payload.token === null) throw new Error('Missing local derived credential')
      return { token: Redacted.make(payload.token) }
    }),
}

export function localClientCredentials() {
  return Connections.create({
    provider: clientCredentialsProvider,
    store,
  })
}

export function localClientCredentialRequestCount(): number {
  return clientCredentialRequests
}

export function inspectLocalConnection(
  context: ConvexQueryInvocationContext,
  connectionId: string,
) {
  return Convex.run(context, salesforce.effect.inspect(connectionId))
}

export function localBinding(): string {
  const binding = env.SALESFORCE_TEST_BINDING
  if (binding === undefined) throw new Error('Local fixture binding is missing')
  return binding
}

export function localConnectionId(): string {
  const connectionId = env.SALESFORCE_TEST_CONNECTION_ID
  if (connectionId === undefined) throw new Error('Local fixture connection ID is missing')
  return connectionId
}

export function isLocalConnectionId(connectionId: string): boolean {
  const configured = localConnectionId()
  return connectionId === configured || connectionId.startsWith(`${configured}:`)
}
