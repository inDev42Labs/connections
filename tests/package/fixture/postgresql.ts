import type { Pool as NeonPool } from '@neondatabase/serverless'
import { Effect, Redacted } from 'effect'
import type { Pool as NodePostgreSQLPool } from 'pg'
import { AesGcm } from '@indev42/connections/encryptors/aes-gcm'
import {
  PostgreSQL,
  PostgreSQLStorageFailure,
  type PostgreSQLPool,
} from '@indev42/connections/stores/postgresql'

const encryptor = AesGcm.encryptor({
  key: Effect.succeed(Redacted.make('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=')),
  keyId: 'package-postgresql',
})

declare const nodePostgreSQLPool: NodePostgreSQLPool
declare const neonPool: NeonPool

const structurallyCompatiblePools: readonly PostgreSQLPool[] = [nodePostgreSQLPool, neonPool]
const stores = structurallyCompatiblePools.map((pool) => PostgreSQL.store({ pool, encryptor }))

type ReadFailure = Effect.Error<ReturnType<(typeof stores)[number]['readConnection']>>
const storageFailure: ReadFailure = new PostgreSQLStorageFailure({ operation: 'read' })
void storageFailure
