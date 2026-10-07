import { Data, Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { Connections, type ConnectionInspection, type InspectionFailure } from '../../src/index.js'
import type { OAuthProviderDefinition } from '../../src/core/contracts/provider.js'
import type { ConnectionStore } from '../../src/stores/index.js'

class ApplicationDenied extends Data.TaggedError('ApplicationDenied')<{}> {}
class TestStorageFailure extends Data.TaggedError('TestStorageFailure')<{}> {}

interface InspectionRecord {
  readonly schemaVersion: 1
  readonly key: {
    readonly namespace: string
    readonly providerId: string
    readonly connectionId: string
  }
  readonly savedAuthorization: boolean
  readonly credentialWork: 'idle' | 'pending' | 'intervention-required' | 'known-failure'
}

function makeFixture(record: InspectionRecord | null, failRead = false) {
  let inspectionReads = 0
  let forbiddenCalls = 0
  const forbidden = () => {
    forbiddenCalls++
    return Effect.die('inspection crossed a forbidden capability')
  }
  const provider: OAuthProviderDefinition<never> = {
    id: 'inspection-provider',
    authorizationUrl: forbidden,
    parseAuthorizationCallback: forbidden,
    exchangeAuthorizationCode: forbidden,
    refreshCredentials: forbidden,
    projectCredentials: forbidden,
  }
  const store = {
    readConnection: forbidden,
    inspectConnection: () => {
      inspectionReads++
      return failRead ? Effect.fail(new TestStorageFailure()) : Effect.succeed(record)
    },
    readAuthorizationAttempt: forbidden,
    protect: forbidden,
    unprotect: forbidden,
    execute: forbidden,
    executeCredentialOperation: forbidden,
  } satisfies ConnectionStore<TestStorageFailure, never>
  const manager = Connections.create({ provider, store })
  return {
    connection: manager.effect,
    diagnostics: () => ({ forbiddenCalls, inspectionReads }),
  }
}

function record(
  savedAuthorization: boolean,
  credentialWork: InspectionRecord['credentialWork'],
): InspectionRecord {
  return {
    schemaVersion: 1,
    key: {
      namespace: 'default',
      providerId: 'inspection-provider',
      connectionId: 'conn_acme',
    },
    savedAuthorization,
    credentialWork,
  }
}

describe('connection inspection interface', () => {
  test.each([
    ['missing', null, { savedAuthorization: false, credentialWork: 'idle' }],
    ['configured', record(true, 'idle'), { savedAuthorization: true, credentialWork: 'idle' }],
    ['pending', record(true, 'pending'), { savedAuthorization: true, credentialWork: 'pending' }],
    [
      'intervention required',
      record(true, 'intervention-required'),
      { savedAuthorization: true, credentialWork: 'intervention-required' },
    ],
  ] as const)(
    'projects %s local metadata through one read only',
    async (_name, stored, expected) => {
      const fixture = makeFixture(stored)

      const result = await Effect.runPromise(fixture.connection.inspect('conn_acme'))

      expect(result).toEqual(expected)
      expect(Object.keys(result).sort()).toEqual(['credentialWork', 'savedAuthorization'])
      expect(JSON.parse(JSON.stringify(result))).toEqual(expected)
      expect(Reflect.has(result, 'healthy')).toBe(false)
      expect(Reflect.has(result, 'valid')).toBe(false)
      expect(Reflect.has(result, 'credentialExpiresAt')).toBe(false)
      expect(fixture.diagnostics()).toEqual({ forbiddenCalls: 0, inspectionReads: 1 })
    },
  )

  test('fails operationally when metadata storage is unavailable', async () => {
    const fixture = makeFixture(null, true)

    await expect(Effect.runPromise(fixture.connection.inspect('conn_acme'))).rejects.toMatchObject({
      _tag: 'InspectionFailure',
      reason: 'StorageFailure',
    })
    expect(fixture.diagnostics()).toEqual({ forbiddenCalls: 0, inspectionReads: 1 })
  })

  test('application denial and cross-connection authority stop before the store read', async () => {
    const fixture = makeFixture(record(true, 'idle'))
    const allowed = new Set(['conn_acme'])
    const inspectAsApplication = (
      callerAllowed: boolean,
      connectionId: string,
    ): Effect.Effect<ConnectionInspection, InspectionFailure | ApplicationDenied> =>
      callerAllowed && allowed.has(connectionId)
        ? fixture.connection.inspect('conn_acme')
        : Effect.fail(new ApplicationDenied())

    await expect(Effect.runPromise(inspectAsApplication(false, 'conn_acme'))).rejects.toThrow(
      ApplicationDenied,
    )
    await expect(Effect.runPromise(inspectAsApplication(true, 'conn_globex'))).rejects.toThrow(
      ApplicationDenied,
    )
    expect(fixture.diagnostics()).toEqual({ forbiddenCalls: 0, inspectionReads: 0 })
  })
})
