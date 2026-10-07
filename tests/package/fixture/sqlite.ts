import { Database } from 'bun:sqlite'
import { Effect, Redacted } from 'effect'
import { AesGcm } from '@indev42/connections/encryptors/aes-gcm'
import { SQLite } from '@indev42/connections/stores/sqlite'

const database = new Database(':memory:', { strict: true })
try {
  const store = SQLite.store({
    database,
    encryptor: AesGcm.encryptor({
      key: Effect.succeed(Redacted.make('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=')),
      keyId: 'package-sqlite',
    }),
  })
  const key = {
    namespace: 'package-sqlite',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const initialized = await Effect.runPromise(
    store.execute({
      _tag: 'InitializeConnection',
      request: { requestId: 'initialize', inputDigest: 'package-fixture' },
      key,
    }),
  )
  if (initialized._tag !== 'ConnectionInitialized') {
    throw new Error('Packed SQLite store did not initialize a connection')
  }
  const snapshot = await Effect.runPromise(store.readConnection(key))
  if (snapshot?.authorization._tag !== 'NotAuthorized') {
    throw new Error('Packed SQLite store did not read its persisted connection')
  }
} finally {
  database.close(true)
}
