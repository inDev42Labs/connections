import { convexTest } from 'convex-test'
import { componentsGeneric } from 'convex/server'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { Connections } from '../../../src/index.js'
import { AesGcm } from '../../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../../src/providers/salesforce/index.js'
import { Configuration } from '../../../src/configuration/index.js'
import {
  Convex,
  type ConvexInvocation,
  type ConvexInvocationContext,
} from '../../../src/stores/convex/index.js'
import componentConfig from '../../../src/stores/convex/component/convex.config.js'
import type { ComponentApi } from '../../../src/stores/convex/component/_generated/component.js'
import type { MutationCtx } from '../../../src/stores/convex/component/_generated/server.js'
import componentSchema from '../../../src/stores/convex/component/schema.js'
import {
  credentialOperationStoreConformance,
  storeConformance,
} from '../../contracts/stores/conformance.js'

const componentModules = import.meta.glob('../../../src/stores/convex/component/**/*.ts')
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)))
const installedComponent = componentsGeneric().connections as unknown as ComponentApi<'connections'>

describe('Convex component', () => {
  test('exports the production component definition and registers its schema and functions', () => {
    const testBackend = convexTest(componentSchema, componentModules)
    const exportDefinition = Reflect.get(componentConfig, 'export')

    expect(typeof exportDefinition).toBe('function')
    expect(Reflect.apply(exportDefinition, componentConfig, [])).toMatchObject({
      name: 'connections',
      definitionType: { type: 'childComponent', name: 'connections' },
    })
    expect(() =>
      testBackend.registerComponent('connections', componentSchema, componentModules),
    ).not.toThrow()
  })

  test('prunes expired retention records in bounded batches without pruning unresolved state', async () => {
    const testBackend = convexTest(componentSchema, componentModules)
    testBackend.registerComponent('connections', componentSchema, componentModules)
    const componentBackend = testBackend as typeof testBackend & {
      readonly runInComponent: <A>(
        path: string,
        handler: (context: MutationCtx) => Promise<A>,
      ) => Promise<A>
    }
    const now = Date.now()
    const day = 24 * 60 * 60 * 1_000
    const oldReceiptIds = await componentBackend.runInComponent('connections', async ({ db }) => {
      const ids = []
      for (let index = 0; index < 40; index++) {
        ids.push(
          await db.insert('receipts', {
            schemaVersion: 1,
            namespace: 'default',
            requestId: `old:${index}`,
            commandKind: 'InitializeConnection',
            inputDigest: `digest:${index}`,
            result: { _tag: 'ConnectionInitialized', generation: 0, revision: 0 },
            createdAt: now - 30 * day - 1,
          }),
        )
      }
      await db.insert('receipts', {
        schemaVersion: 1,
        namespace: 'default',
        requestId: 'fresh',
        commandKind: 'InitializeConnection',
        inputDigest: 'fresh',
        result: { _tag: 'ConnectionInitialized', generation: 0, revision: 0 },
        createdAt: now,
      })
      for (let index = 0; index < 40; index++) {
        const connectionId = `closed:${index}`
        await db.insert('attempts', {
          schemaVersion: 1,
          storageKey: JSON.stringify(['retention', 'salesforce', connectionId]),
          stateDigest: `closed-state:${index}`,
          key: { namespace: 'default', providerId: 'salesforce', connectionId },
          generation: 0,
          intent: 'enroll',
          bindingDigest: `binding:${index}`,
          pkceVerifierEnvelope: {
            version: 1,
            algorithm: 'AES-256-GCM',
            keyId: 'test',
            iv: 'iv',
            ciphertext: 'ciphertext',
          },
          createdAt: now - 2 * day,
          expiresAt: now - 2 * day,
          state: { _tag: 'Closed', reason: 'Superseded' },
          retentionState: 'Closed',
          closedAt: now - day - 1,
        })
      }
      await db.insert('attempts', {
        schemaVersion: 1,
        storageKey: JSON.stringify(['retention', 'salesforce', 'fresh-closed']),
        stateDigest: 'fresh-closed-state',
        key: { namespace: 'default', providerId: 'salesforce', connectionId: 'fresh-closed' },
        generation: 0,
        intent: 'enroll',
        bindingDigest: 'fresh-binding',
        pkceVerifierEnvelope: {
          version: 1,
          algorithm: 'AES-256-GCM',
          keyId: 'test',
          iv: 'iv',
          ciphertext: 'ciphertext',
        },
        createdAt: now,
        expiresAt: now + day,
        state: { _tag: 'Closed', reason: 'ProviderDenied' },
        retentionState: 'Closed',
        closedAt: now,
      })
      await db.insert('attempts', {
        schemaVersion: 1,
        storageKey: JSON.stringify(['retention', 'salesforce', 'unresolved']),
        stateDigest: 'unresolved-state',
        key: { namespace: 'default', providerId: 'salesforce', connectionId: 'unresolved' },
        generation: 1,
        intent: 'replace',
        bindingDigest: 'unresolved-binding',
        pkceVerifierEnvelope: {
          version: 1,
          algorithm: 'AES-256-GCM',
          keyId: 'test',
          iv: 'iv',
          ciphertext: 'ciphertext',
        },
        createdAt: now - 60 * day,
        expiresAt: now - 59 * day,
        retentionState: 'Admitted',
        closedAt: null,
        state: {
          _tag: 'Admitted',
          admission: {
            stateDigest: 'unresolved-state',
            key: {
              namespace: 'default',
              providerId: 'salesforce',
              connectionId: 'unresolved',
            },
            intent: 'replace',
            generation: 1,
            admissionId: 'unresolved-admission',
            admittedAt: now - 60 * day,
            admissionExpiresAt: now - 59 * day,
          },
        },
      })
      await db.insert('connections', {
        storageKey: JSON.stringify(['retention', 'salesforce', 'unresolved']),
        schemaVersion: 1,
        key: {
          namespace: 'default',
          providerId: 'salesforce',
          connectionId: 'unresolved',
        },
        generation: 1,
        revision: 2,
        authorization: { _tag: 'Authorized', credentialExpiresAt: null },
        credentialEnvelope: {
          version: 1,
          algorithm: 'AES-256-GCM',
          keyId: 'test',
          iv: 'iv',
          ciphertext: 'ciphertext',
        },
        credentialOperation: {
          schemaVersion: 1,
          operationId: 'unresolved-operation',
          kind: 'authorization-exchange',
          generation: 1,
          observedRevision: 1,
          startedAt: now - 60 * day,
          recoveryDeadline: now - 59 * day,
          transferCount: 0,
          transferLimit: 1,
          phase: {
            _tag: 'InterventionRequired',
            reason: 'ProviderOutcomeUnknown',
            markedAt: now - 59 * day,
          },
        },
        authorizationAttemptStateDigest: 'unresolved-state',
      })
      return ids
    })

    await testBackend.mutation(installedComponent.connections.initialize, {
      request: { requestId: 'trigger:one', inputDigest: 'trigger:one' },
      key: { namespace: 'default', providerId: 'salesforce', connectionId: 'trigger:one' },
    })

    const firstPass = await componentBackend.runInComponent('connections', async ({ db }) => ({
      oldReceipts: (await Promise.all(oldReceiptIds.map((id) => db.get(id)))).filter(Boolean)
        .length,
      oldClosedAttempts: (await db.query('attempts').collect()).filter(
        (attempt) =>
          attempt.retentionState === 'Closed' &&
          attempt.closedAt !== null &&
          attempt.closedAt < now - day &&
          attempt.stateDigest.startsWith('closed-state:'),
      ).length,
    }))
    expect(firstPass.oldReceipts).toBeGreaterThan(0)
    expect(firstPass.oldReceipts).toBeLessThan(40)
    expect(firstPass.oldClosedAttempts).toBeGreaterThan(0)
    expect(firstPass.oldClosedAttempts).toBeLessThan(40)

    for (let index = 2; index <= 4; index++) {
      await testBackend.mutation(installedComponent.connections.initialize, {
        request: { requestId: `trigger:${index}`, inputDigest: `trigger:${index}` },
        key: {
          namespace: 'default',
          providerId: 'salesforce',
          connectionId: `trigger:${index}`,
        },
      })
    }

    const retained = await componentBackend.runInComponent('connections', async ({ db }) => ({
      oldReceipts: (await Promise.all(oldReceiptIds.map((id) => db.get(id)))).filter(Boolean)
        .length,
      attempts: await db.query('attempts').collect(),
      unresolved: await db
        .query('connections')
        .withIndex('by_storage_key', (query) =>
          query.eq('storageKey', JSON.stringify(['retention', 'salesforce', 'unresolved'])),
        )
        .unique(),
    }))
    expect(retained.oldReceipts).toBe(0)
    expect(
      retained.attempts.filter((attempt) => attempt.stateDigest.startsWith('closed-state:')),
    ).toHaveLength(0)
    expect(retained.attempts.some((attempt) => attempt.stateDigest === 'fresh-closed-state')).toBe(
      true,
    )
    expect(retained.attempts.some((attempt) => attempt.stateDigest === 'unresolved-state')).toBe(
      true,
    )
    expect(retained.unresolved?.credentialOperation?.phase._tag).toBe('InterventionRequired')
  })

  test('prunes long-expired prepared attempts before creating a replacement attempt', async () => {
    const testBackend = convexTest(componentSchema, componentModules)
    testBackend.registerComponent('connections', componentSchema, componentModules)
    const componentBackend = testBackend as typeof testBackend & {
      readonly runInComponent: <A>(
        path: string,
        handler: (context: MutationCtx) => Promise<A>,
      ) => Promise<A>
    }
    const now = Date.now()
    const day = 24 * 60 * 60 * 1_000
    const connectionKey = {
      namespace: 'default',
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const storageKey = JSON.stringify([
      connectionKey.namespace,
      connectionKey.providerId,
      connectionKey.connectionId,
    ])
    const envelope = {
      version: 1 as const,
      algorithm: 'AES-256-GCM' as const,
      keyId: 'test',
      iv: 'iv',
      ciphertext: 'ciphertext',
    }
    await componentBackend.runInComponent('connections', async ({ db }) => {
      await db.insert('connections', {
        storageKey,
        schemaVersion: 1,
        key: connectionKey,
        generation: 0,
        revision: 1,
        authorization: { _tag: 'NotAuthorized' },
        credentialEnvelope: null,
        credentialOperation: null,
        authorizationAttemptStateDigest: 'expired-state',
      })
      await db.insert('attempts', {
        schemaVersion: 1,
        storageKey,
        stateDigest: 'expired-state',
        key: connectionKey,
        generation: 0,
        intent: 'enroll',
        bindingDigest: 'expired-binding',
        pkceVerifierEnvelope: envelope,
        createdAt: now - 3 * day,
        expiresAt: now - 2 * day,
        state: { _tag: 'Prepared' },
        retentionState: 'Prepared',
        closedAt: null,
      })
    })

    const created = await testBackend.mutation(installedComponent.attempts.create, {
      request: { requestId: 'replacement', inputDigest: 'replacement' },
      attempt: {
        schemaVersion: 1,
        stateDigest: 'replacement-state',
        key: connectionKey,
        generation: 0,
        intent: 'enroll',
        bindingDigest: 'replacement-binding',
        pkceVerifierEnvelope: envelope,
        createdAt: now,
        expiresAt: now + day,
      },
    })

    expect(created._tag).toBe('AuthorizationAttemptCreated')
    const retained = await componentBackend.runInComponent('connections', async ({ db }) => ({
      attempts: await db.query('attempts').collect(),
      connection: await db
        .query('connections')
        .withIndex('by_storage_key', (query) => query.eq('storageKey', storageKey))
        .unique(),
    }))
    expect(retained.attempts.some((attempt) => attempt.stateDigest === 'expired-state')).toBe(false)
    expect(retained.connection?.authorizationAttemptStateDigest).toBe('replacement-state')
  })

  test('does not let a pruned older create request supersede newer browser work', async () => {
    const testBackend = convexTest(componentSchema, componentModules)
    testBackend.registerComponent('connections', componentSchema, componentModules)
    const componentBackend = testBackend as typeof testBackend & {
      readonly runInComponent: <A>(
        path: string,
        handler: (context: MutationCtx) => Promise<A>,
      ) => Promise<A>
    }
    const connectionKey = {
      namespace: 'default',
      providerId: 'salesforce',
      connectionId: 'connection',
    }
    const envelope = {
      version: 1 as const,
      algorithm: 'AES-256-GCM' as const,
      keyId: 'test',
      iv: 'iv',
      ciphertext: 'ciphertext',
    }
    const older = {
      schemaVersion: 1 as const,
      stateDigest: 'older-state',
      key: connectionKey,
      generation: 0,
      intent: 'enroll' as const,
      bindingDigest: 'older-binding',
      pkceVerifierEnvelope: envelope,
      createdAt: 1_000,
      expiresAt: 10_000,
    }
    const olderRequest = { requestId: 'older-request', inputDigest: 'older-digest' }
    await testBackend.mutation(installedComponent.attempts.create, {
      request: olderRequest,
      attempt: older,
    })
    await testBackend.mutation(installedComponent.attempts.create, {
      request: { requestId: 'newer-request', inputDigest: 'newer-digest' },
      attempt: {
        ...older,
        stateDigest: 'newer-state',
        bindingDigest: 'newer-binding',
        createdAt: 2_000,
        expiresAt: 11_000,
      },
    })
    await componentBackend.runInComponent('connections', async ({ db }) => {
      for (const receipt of await db.query('receipts').collect()) {
        if (receipt.requestId === olderRequest.requestId) await db.delete(receipt._id)
      }
      for (const attempt of await db.query('attempts').collect()) {
        if (attempt.stateDigest === older.stateDigest) await db.delete(attempt._id)
      }
    })

    expect(
      await testBackend.mutation(installedComponent.attempts.create, {
        request: olderRequest,
        attempt: older,
      }),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    expect(
      await testBackend.query(installedComponent.attempts.read, {
        lookup: {
          namespace: 'default',
          stateDigest: 'newer-state',
          bindingDigest: 'newer-binding',
          now: 3_000,
        },
      }),
    ).toMatchObject({ stateDigest: 'newer-state' })
  })

  test('rejects unsupported persisted schema versions', async () => {
    const testBackend = convexTest(componentSchema, componentModules)
    testBackend.registerComponent('connections', componentSchema, componentModules)
    const componentBackend = testBackend as typeof testBackend & {
      readonly runInComponent: <A>(
        path: string,
        handler: (context: MutationCtx) => Promise<A>,
      ) => Promise<A>
    }

    await expect(
      componentBackend.runInComponent('connections', async ({ db }) =>
        db.insert('receipts', {
          schemaVersion: 2 as 1,
          namespace: 'default',
          requestId: 'request',
          commandKind: 'InitializeConnection',
          inputDigest: 'digest',
          result: { _tag: 'ConnectionInitialized', generation: 0, revision: 0 },
          createdAt: Date.now(),
        }),
      ),
    ).rejects.toThrow(/Expected `1`, got `2`/)
  })

  test('persists client-credential invalidation command receipts and fences stale or conflicting replays', async () => {
    const testBackend = convexTest(componentSchema, componentModules)
    testBackend.registerComponent('connections', componentSchema, componentModules)
    const componentBackend = testBackend as typeof testBackend & {
      readonly runInComponent: <A>(
        path: string,
        handler: (context: MutationCtx) => Promise<A>,
      ) => Promise<A>
    }
    const key = {
      namespace: 'default',
      providerId: 'deterministic-client-credentials',
      connectionId: 'connection',
    }
    const envelope = {
      version: 1 as const,
      algorithm: 'AES-256-GCM' as const,
      keyId: 'test',
      iv: 'iv',
      ciphertext: 'ciphertext',
    }
    const initialize = await testBackend.mutation(installedComponent.connections.initialize, {
      request: { requestId: 'initialize', inputDigest: 'initialize' },
      key,
    })
    expect(initialize).toMatchObject({ _tag: 'ConnectionInitialized', generation: 0, revision: 0 })
    const saved = await testBackend.mutation(installedComponent.connections.saveCredential, {
      request: { requestId: 'save', inputDigest: 'save' },
      key,
      expectedGeneration: 0,
      expectedRevision: 0,
      intent: 'enroll',
      credentialEnvelope: envelope,
      credentialExpiresAt: null,
      credentialAcquiredAt: 1_000,
    })
    expect(saved).toMatchObject({ _tag: 'CredentialSaved', generation: 0, revision: 1 })

    const invalidation = {
      request: { requestId: 'invalidate', inputDigest: 'invalidate' },
      key,
      expectedGeneration: 0,
      expectedRevision: 1,
    }
    expect(
      await testBackend.mutation(installedComponent.connections.invalidateCredential, invalidation),
    ).toMatchObject({ _tag: 'CredentialInvalidated', generation: 0, revision: 2 })
    expect(
      await testBackend.mutation(installedComponent.connections.invalidateCredential, invalidation),
    ).toMatchObject({ _tag: 'CredentialInvalidated', generation: 0, revision: 2 })
    expect(
      await testBackend.mutation(installedComponent.connections.invalidateCredential, {
        ...invalidation,
        request: { requestId: 'stale', inputDigest: 'stale' },
      }),
    ).toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
    expect(
      await testBackend.mutation(installedComponent.connections.invalidateCredential, {
        ...invalidation,
        request: { requestId: 'invalidate', inputDigest: 'different-input' },
      }),
    ).toEqual({ _tag: 'StoreConflict', reason: 'RequestIdReused' })

    const receipts = await componentBackend.runInComponent('connections', async ({ db }) =>
      db.query('receipts').collect(),
    )
    expect(receipts.find((receipt) => receipt.requestId === 'invalidate')).toMatchObject({
      commandKind: 'InvalidateCredential',
      inputDigest: 'invalidate',
      result: { _tag: 'CredentialInvalidated', generation: 0, revision: 2 },
    })
  })

  test('projects inspection through query capability without resolving provider or encryption dependencies', async () => {
    const testBackend = convexTest(componentSchema, componentModules)
    testBackend.registerComponent('connections', componentSchema, componentModules)
    let forbiddenResolutions = 0
    const unavailable = () => {
      forbiddenResolutions++
      throw new Error('Unavailable during a query')
    }
    const store = Convex.store({
      component: installedComponent,
      encryptionKey: unavailable,
    })
    const manager = Connections.create({
      provider: Salesforce.oauth({
        clientId: Configuration.string(unavailable),
        clientSecret: Configuration.secret(unavailable),
        redirectUri: Configuration.string(unavailable),
        scopes: ['api'],
      }),
      store,
    })
    const queryContext = {
      runQuery: testBackend.query as ConvexInvocationContext['runQuery'],
    }

    expect(forbiddenResolutions).toBe(0)
    const inspection = await Effect.runPromise(
      manager.effect.inspect('missing').pipe(Effect.provide(Convex.layer(queryContext))),
    )

    expect(inspection).toEqual({ savedAuthorization: false, credentialWork: 'idle' })
    expect(forbiddenResolutions).toBe(0)
  })
})

function makeConformanceTarget() {
  const testBackend = convexTest(componentSchema, componentModules)
  testBackend.registerComponent('connections', componentSchema, componentModules)
  // convex-test additionally accepts inline functions, so its methods are wider
  // than an action context even though the FunctionReference path is identical.
  const context: ConvexInvocationContext = {
    runQuery: testBackend.query as ConvexInvocationContext['runQuery'],
    runMutation: testBackend.mutation as ConvexInvocationContext['runMutation'],
  }
  const store = Convex.store({
    component: installedComponent,
    encryptor: AesGcm.encryptor({
      key: Configuration.secret(() => key),
      keyId: 'test',
    }),
  })
  const componentBackend = testBackend as typeof testBackend & {
    readonly runInComponent: (
      path: string,
      handler: (context: MutationCtx) => Promise<void>,
    ) => Promise<void>
  }

  return {
    store,
    run: <A, E>(effect: Effect.Effect<A, E, ConvexInvocation>) =>
      Effect.runPromise(effect.pipe(Effect.provide(Convex.layer(context)))),
    pruneReceipts: () =>
      componentBackend.runInComponent('connections', async ({ db }) => {
        const receipts = await db.query('receipts').collect()
        for (const receipt of receipts) await db.delete(receipt._id)
      }),
  }
}

storeConformance('Convex component store', makeConformanceTarget)
credentialOperationStoreConformance('Convex component store', makeConformanceTarget)
