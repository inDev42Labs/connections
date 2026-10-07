import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { Effect, Redacted } from 'effect'
import type {
  AuthorizationCallback,
  ClientCredentialsProviderDefinition,
  OAuthProviderDefinition,
  ProviderRefreshOutcome,
  ProviderClientCredentialsOutcome,
  SelfClientProviderDefinition,
} from '../../src/core/contracts/provider.js'
import { AesGcm, type EncryptionFailure } from '../../src/encryptors/aes-gcm/index.js'
import type { StoredCommand } from '../../src/stores/internal/transition-kernel.js'
import { SQLitePersistence } from '../../src/stores/sqlite/persistence.js'
import { makeSQLiteStore, type SQLiteStorageFailure } from '../../src/stores/sqlite/store.js'
import {
  connectionStorageKey,
  type ConnectionKey,
  type ConnectionSnapshot,
  type ConnectionStore,
  type CredentialOperationCommand,
  type ProtectedCredentialEnvelope,
  type StoreCommand,
  type StoreCommandResult,
} from '../../src/stores/index.js'
import type { ProcessCheckpoint } from './protocol.js'

export interface ProcessCredentials {
  readonly accessToken: Redacted.Redacted<string>
}

export interface ProcessClientCredentials {
  readonly accessToken: Redacted.Redacted<string>
}

interface StoredProcessCredentials {
  readonly accessToken: string
  readonly refreshToken: string
}

interface StoredEvent {
  readonly command_json: string
  readonly result_json: string
  readonly snapshot_json: string
}

interface StoredProductionConnection {
  readonly record_json: string
}

type ProductionConnectionRecord = ConnectionSnapshot & {
  readonly authorizationAttemptStateDigest: string | null
}

type ProcessConnectionStore = ConnectionStore<
  SQLiteStorageFailure | EncryptionFailure,
  never,
  SQLiteStorageFailure,
  never
>

export interface SqliteCommandEvent {
  readonly command: StoreCommand | CredentialOperationCommand
  readonly result: StoreCommandResult
  readonly snapshot: ConnectionSnapshot | null
}

export interface SqliteProviderState {
  readonly calls: number
  readonly processed: number
  readonly authorizationCalls: number
  readonly authorizationProcessed: number
}

export type ProcessRefreshOutcome = 'refreshed' | 'provider-rejected'

interface StoredSqliteProviderState extends SqliteProviderState {
  readonly refreshOutcome: ProcessRefreshOutcome
}

export interface ProcessSecretCanary {
  readonly label: string
  readonly value: string
}

export const PROCESS_NAMESPACE = 'default'
export const PROCESS_CONNECTION_ID = 'conn_acme'
export const PROCESS_CONNECTION_KEY: ConnectionKey = {
  namespace: PROCESS_NAMESPACE,
  providerId: 'salesforce',
  connectionId: PROCESS_CONNECTION_ID,
}
export const PROCESS_CLIENT_CONNECTION_KEY: ConnectionKey = {
  namespace: PROCESS_NAMESPACE,
  providerId: 'deterministic-client-credentials',
  connectionId: PROCESS_CONNECTION_ID,
}
export const PROCESS_SELF_CLIENT_CONNECTION_KEY: ConnectionKey = {
  namespace: PROCESS_NAMESPACE,
  providerId: 'deterministic-self-client',
  connectionId: PROCESS_CONNECTION_ID,
}
export const PROCESS_INITIAL_TIME = 1_000
export const PROCESS_CREDENTIAL_FOLLOWER_WAIT = 5_000
export const PROCESS_OWNERSHIP_LEASE = 30_000
export const PROCESS_REFRESHED_ACCESS_TOKEN = '__connections_process_loss_refreshed_access_token__'
export const PROCESS_CLIENT_ACCESS_TOKEN = '__connections_process_loss_client_access_token__'
export const PROCESS_REPLACEMENT_ACCESS_TOKEN =
  '__connections_process_loss_replacement_access_token__'
export const PROCESS_REENROLLED_ACCESS_TOKEN =
  '__connections_process_loss_reenrolled_access_token__'
export const PROCESS_SELF_CLIENT_UNCERTAIN_CODE =
  '__connections_process_loss_self_client_uncertain_code__'
export const PROCESS_SELF_CLIENT_FRESH_CODE = '__connections_process_loss_self_client_fresh_code__'
export const PROCESS_SELF_CLIENT_ACK_CODE = '__connections_process_loss_self_client_ack_code__'
export const PROCESS_SELF_CLIENT_FRESH_ACCESS_TOKEN =
  '__connections_process_loss_self_client_fresh_access_token__'
export const PROCESS_SELF_CLIENT_ACK_ACCESS_TOKEN =
  '__connections_process_loss_self_client_ack_access_token__'
export const PROCESS_REPLACEMENT_BINDING = 'replacement-session'
export const PROCESS_REENROLLMENT_BINDING = 'reenrollment-session'

const processEncryptionKey = Buffer.from('process-loss-secret-key-canary!!').toString('base64')
const initialAccessToken = '__connections_process_loss_initial_access_token__'
const initialRefreshToken = '__connections_process_loss_initial_refresh_token__'
const refreshedRefreshToken = '__connections_process_loss_refreshed_refresh_token__'
const replacementRefreshToken = '__connections_process_loss_replacement_refresh_token__'
const reenrolledRefreshToken = '__connections_process_loss_reenrolled_refresh_token__'
const replacementAuthorizationCode = '__connections_process_loss_replacement_authorization_code__'
const reenrollmentAuthorizationCode = '__connections_process_loss_reenrollment_authorization_code__'
const initialCredentials: StoredProcessCredentials = {
  accessToken: initialAccessToken,
  refreshToken: initialRefreshToken,
}
const initialClientSource = '__connections_process_loss_client_source__'
const refreshedCredentials: StoredProcessCredentials = {
  accessToken: PROCESS_REFRESHED_ACCESS_TOKEN,
  refreshToken: refreshedRefreshToken,
}
const replacementCredentials: StoredProcessCredentials = {
  accessToken: PROCESS_REPLACEMENT_ACCESS_TOKEN,
  refreshToken: replacementRefreshToken,
}
const reenrolledCredentials: StoredProcessCredentials = {
  accessToken: PROCESS_REENROLLED_ACCESS_TOKEN,
  refreshToken: reenrolledRefreshToken,
}
const selfClientCredentialsByCode: Readonly<Record<string, StoredProcessCredentials>> = {
  [PROCESS_SELF_CLIENT_UNCERTAIN_CODE]: {
    accessToken: '__connections_process_loss_self_client_uncertain_access_token__',
    refreshToken: '__connections_process_loss_self_client_uncertain_refresh_token__',
  },
  [PROCESS_SELF_CLIENT_FRESH_CODE]: {
    accessToken: PROCESS_SELF_CLIENT_FRESH_ACCESS_TOKEN,
    refreshToken: '__connections_process_loss_self_client_fresh_refresh_token__',
  },
  [PROCESS_SELF_CLIENT_ACK_CODE]: {
    accessToken: PROCESS_SELF_CLIENT_ACK_ACCESS_TOKEN,
    refreshToken: '__connections_process_loss_self_client_ack_refresh_token__',
  },
}

export const PROCESS_SECRET_CANARIES: ReadonlyArray<ProcessSecretCanary> = [
  { label: 'initial access token', value: initialAccessToken },
  { label: 'client source', value: initialClientSource },
  { label: 'client access token', value: PROCESS_CLIENT_ACCESS_TOKEN },
  { label: 'initial refresh token', value: initialRefreshToken },
  { label: 'refreshed access token', value: PROCESS_REFRESHED_ACCESS_TOKEN },
  { label: 'refreshed refresh token', value: refreshedRefreshToken },
  { label: 'replacement access token', value: PROCESS_REPLACEMENT_ACCESS_TOKEN },
  { label: 'replacement refresh token', value: replacementRefreshToken },
  { label: 'reenrolled access token', value: PROCESS_REENROLLED_ACCESS_TOKEN },
  { label: 'reenrolled refresh token', value: reenrolledRefreshToken },
  { label: 'self-client uncertain authorization code', value: PROCESS_SELF_CLIENT_UNCERTAIN_CODE },
  { label: 'self-client fresh authorization code', value: PROCESS_SELF_CLIENT_FRESH_CODE },
  { label: 'self-client acknowledgement authorization code', value: PROCESS_SELF_CLIENT_ACK_CODE },
  {
    label: 'self-client uncertain access token',
    value: selfClientCredentialsByCode[PROCESS_SELF_CLIENT_UNCERTAIN_CODE]!.accessToken,
  },
  {
    label: 'self-client uncertain refresh token',
    value: selfClientCredentialsByCode[PROCESS_SELF_CLIENT_UNCERTAIN_CODE]!.refreshToken,
  },
  { label: 'self-client fresh access token', value: PROCESS_SELF_CLIENT_FRESH_ACCESS_TOKEN },
  {
    label: 'self-client fresh refresh token',
    value: selfClientCredentialsByCode[PROCESS_SELF_CLIENT_FRESH_CODE]!.refreshToken,
  },
  {
    label: 'self-client acknowledgement access token',
    value: PROCESS_SELF_CLIENT_ACK_ACCESS_TOKEN,
  },
  {
    label: 'self-client acknowledgement refresh token',
    value: selfClientCredentialsByCode[PROCESS_SELF_CLIENT_ACK_CODE]!.refreshToken,
  },
  { label: 'replacement authorization code', value: replacementAuthorizationCode },
  { label: 'reenrollment authorization code', value: reenrollmentAuthorizationCode },
  { label: 'encryption key', value: processEncryptionKey },
]
const processEncryptor = AesGcm.encryptor({
  key: Effect.succeed(Redacted.make(processEncryptionKey)),
  keyId: 'process-loss-test',
})

function parseJson<Value>(json: string): Value {
  return JSON.parse(json) as Value
}

function initializeCredentialDatabase(path: string): Database {
  const database = new Database(path, { create: true, readwrite: true, strict: true })
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    database.exec(`
      CREATE TABLE IF NOT EXISTS command_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        command_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
    `)
    return database
  } catch (error) {
    database.close(true)
    throw error
  }
}

class ProcessSQLitePersistence extends SQLitePersistence {
  constructor(private readonly database: Database) {
    super(database)
  }

  protected override recordCommandExecution(
    command: StoredCommand,
    result: StoreCommandResult,
    snapshot: ConnectionSnapshot | null,
  ): void {
    this.database.run(
      `INSERT INTO command_events (command_json, result_json, snapshot_json)
       VALUES (?, ?, ?)`,
      [JSON.stringify(command), JSON.stringify(result), JSON.stringify(snapshot)],
    )
  }
}

export class SqliteProcessStore implements ProcessConnectionStore {
  private readonly database: Database
  private readonly production: ProcessConnectionStore

  readonly readConnection: ProcessConnectionStore['readConnection']
  readonly inspectConnection: ProcessConnectionStore['inspectConnection']
  readonly readAuthorizationAttempt: ProcessConnectionStore['readAuthorizationAttempt']
  readonly protect: ProcessConnectionStore['protect']
  readonly unprotect: ProcessConnectionStore['unprotect']
  readonly execute: ProcessConnectionStore['execute']
  readonly executeCredentialOperation: ProcessConnectionStore['executeCredentialOperation']

  constructor(
    directory: string,
    options?: {
      readonly checkpoint?: (point: ProcessCheckpoint) => Effect.Effect<void>
    },
  ) {
    const checkpoint = options?.checkpoint ?? (() => Effect.void)
    this.database = initializeCredentialDatabase(join(directory, 'credentials.sqlite'))
    this.production = makeSQLiteStore(
      { database: this.database, encryptor: processEncryptor },
      new ProcessSQLitePersistence(this.database),
    )
    this.readConnection = this.production.readConnection
    this.inspectConnection = this.production.inspectConnection
    this.readAuthorizationAttempt = this.production.readAuthorizationAttempt
    this.protect = this.production.protect
    this.unprotect = this.production.unprotect
    this.execute = this.production.execute
    this.executeCredentialOperation = (command) =>
      this.production
        .executeCredentialOperation(command)
        .pipe(
          Effect.tap(() =>
            command._tag === 'AcquireCredentialOperation'
              ? checkpoint('pre-dispatch')
              : command._tag === 'CompleteCredentialOperation' ||
                  command._tag === 'CompleteSelfClientExchange'
                ? checkpoint('completion-acknowledgement')
                : command._tag === 'RemoveConnection'
                  ? checkpoint('removal-acknowledgement')
                  : Effect.void,
          ),
        )
  }

  unsafeReadConnection(key: ConnectionKey): ConnectionSnapshot | null {
    return Effect.runSync(this.production.readConnection(key))
  }

  unsafeSeedConnection(snapshot: ConnectionSnapshot): void {
    if (this.unsafeReadConnection(snapshot.key) !== null) {
      throw new Error('Cannot seed an existing process connection')
    }
    this.database.run(
      `INSERT INTO indev42_connections_sqlite_connections
         (storage_key, schema_version, record_json)
       VALUES (?, 1, ?)`,
      [
        connectionStorageKey(snapshot.key),
        JSON.stringify({ ...snapshot, authorizationAttemptStateDigest: null }),
      ],
    )
  }

  unsafeReplaceCredentialEnvelope(
    key: ConnectionKey,
    credentialEnvelope: ProtectedCredentialEnvelope,
  ): void {
    const storageKey = connectionStorageKey(key)
    const row = this.database
      .query<StoredProductionConnection, [string]>(
        `SELECT record_json FROM indev42_connections_sqlite_connections
         WHERE storage_key = ?`,
      )
      .get(storageKey)
    if (row === null) throw new Error('Cannot alter credentials for a missing connection')
    const stored = parseJson<ProductionConnectionRecord>(row.record_json)
    if (stored.authorization._tag !== 'Authorized') {
      throw new Error('Cannot alter credentials for an unauthorized connection')
    }
    this.database.run(
      `UPDATE indev42_connections_sqlite_connections
       SET record_json = ? WHERE storage_key = ?`,
      [JSON.stringify({ ...stored, credentialEnvelope }), storageKey],
    )
  }

  commandEvents(): readonly SqliteCommandEvent[] {
    return this.database
      .query<StoredEvent, []>(
        `SELECT command_json, result_json, snapshot_json
         FROM command_events ORDER BY sequence`,
      )
      .all()
      .map((row) => ({
        command: parseJson<StoreCommand | CredentialOperationCommand>(row.command_json),
        result: parseJson<StoreCommandResult>(row.result_json),
        snapshot: parseJson<ConnectionSnapshot | null>(row.snapshot_json),
      }))
  }

  close(): void {
    this.database.close(true)
  }
}

function initializeProviderDatabase(
  directory: string,
  refreshOutcome: ProcessRefreshOutcome,
): void {
  const database = new Database(join(directory, 'provider.sqlite'), {
    create: true,
    readwrite: true,
    strict: true,
  })
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    database.exec(`
      CREATE TABLE IF NOT EXISTS provider_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        calls INTEGER NOT NULL,
        processed INTEGER NOT NULL,
        authorization_calls INTEGER NOT NULL,
        authorization_processed INTEGER NOT NULL,
        refresh_outcome TEXT NOT NULL CHECK (refresh_outcome IN ('refreshed', 'provider-rejected'))
      );
    `)
    database.run(
      `INSERT OR IGNORE INTO provider_state
         (id, calls, processed, authorization_calls, authorization_processed, refresh_outcome)
       VALUES (1, 0, 0, 0, 0, ?)`,
      [refreshOutcome],
    )
  } finally {
    database.close(true)
  }
}

function commitProviderRefresh(directory: string): StoredSqliteProviderState {
  const database = new Database(join(directory, 'provider.sqlite'), {
    create: false,
    readwrite: true,
    strict: true,
  })
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    const transact = database.transaction(() => {
      database.run(
        'UPDATE provider_state SET calls = calls + 1, processed = processed + 1 WHERE id = 1',
      )
      const state = database
        .query<StoredSqliteProviderState, []>(
          `SELECT calls, processed,
             authorization_calls AS authorizationCalls,
             authorization_processed AS authorizationProcessed,
             refresh_outcome AS refreshOutcome
           FROM provider_state WHERE id = 1`,
        )
        .get()
      if (state === null) throw new Error('Missing owned provider fixture state')
      return state
    })
    return transact.immediate()
  } finally {
    database.close(true)
  }
}

function commitProviderAuthorization(directory: string): SqliteProviderState {
  const database = new Database(join(directory, 'provider.sqlite'), {
    create: false,
    readwrite: true,
    strict: true,
  })
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    const transact = database.transaction(() => {
      database.run(
        `UPDATE provider_state
         SET authorization_calls = authorization_calls + 1,
             authorization_processed = authorization_processed + 1
         WHERE id = 1`,
      )
      const state = database
        .query<SqliteProviderState, []>(
          `SELECT calls, processed,
             authorization_calls AS authorizationCalls,
             authorization_processed AS authorizationProcessed
           FROM provider_state WHERE id = 1`,
        )
        .get()
      if (state === null) throw new Error('Missing owned provider fixture state')
      return state
    })
    return transact.immediate()
  } finally {
    database.close(true)
  }
}

export function readSqliteProviderState(directory: string): SqliteProviderState {
  const database = new Database(join(directory, 'provider.sqlite'), {
    create: false,
    readonly: true,
    strict: true,
  })
  try {
    const state = database
      .query<SqliteProviderState, []>(
        `SELECT calls, processed,
           authorization_calls AS authorizationCalls,
           authorization_processed AS authorizationProcessed
         FROM provider_state WHERE id = 1`,
      )
      .get()
    if (state === null) throw new Error('Missing owned provider fixture state')
    return state
  } finally {
    database.close(true)
  }
}

function storedCredentials(value: Redacted.Redacted<string>): StoredProcessCredentials {
  const parsed = JSON.parse(Redacted.value(value)) as unknown
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof Reflect.get(parsed, 'accessToken') !== 'string' ||
    typeof Reflect.get(parsed, 'refreshToken') !== 'string'
  ) {
    throw new Error('Invalid process fixture credentials')
  }
  return parsed as StoredProcessCredentials
}

function processAuthorizationCallbackUrl(state: string, code: string): string {
  const callback = new URL('https://app.example.test/oauth/callback')
  callback.searchParams.set('state', state)
  callback.searchParams.set('code', code)
  return callback.toString()
}

export function processReplacementCallbackUrl(state: string): string {
  return processAuthorizationCallbackUrl(state, replacementAuthorizationCode)
}

export function processReenrollmentCallbackUrl(state: string): string {
  return processAuthorizationCallbackUrl(state, reenrollmentAuthorizationCode)
}

export function makeSqliteProcessClientCredentialsProvider(
  directory: string,
  checkpoint: (point: ProcessCheckpoint) => Effect.Effect<void> = () => Effect.void,
): ClientCredentialsProviderDefinition<
  { readonly source: Redacted.Redacted<string> },
  ProcessClientCredentials
> {
  return {
    id: 'deterministic-client-credentials',
    prepareClientCredentials: ({ source }) =>
      Effect.succeed({
        protectedPayload: Redacted.make(
          JSON.stringify({ version: 1, source: Redacted.value(source), token: null }),
        ),
      }),
    acquireCredentials: ({ protectedPayload }) =>
      Effect.gen(function* () {
        yield* checkpoint('dispatch-possible')
        const payload = JSON.parse(Redacted.value(protectedPayload)) as { source?: unknown }
        if (payload.source !== initialClientSource) {
          return { _tag: 'ProviderFailure' } satisfies ProviderClientCredentialsOutcome
        }
        const committed = yield* Effect.sync(() => commitProviderRefresh(directory))
        yield* checkpoint('response-received')
        if (committed.refreshOutcome === 'provider-rejected') {
          return { _tag: 'ProviderRejected' } satisfies ProviderClientCredentialsOutcome
        }
        return {
          _tag: 'Acquired',
          credentials: {
            protectedPayload: Redacted.make(
              JSON.stringify({
                version: 1,
                source: initialClientSource,
                token: PROCESS_CLIENT_ACCESS_TOKEN,
              }),
            ),
            credentialExpiresAt: null,
          },
        } satisfies ProviderClientCredentialsOutcome
      }),
    projectCredentials: (protectedPayload) =>
      Effect.try({
        try: () => {
          const payload = JSON.parse(Redacted.value(protectedPayload)) as { token?: unknown }
          if (typeof payload.token !== 'string') throw new Error('Missing client credential')
          return { accessToken: Redacted.make(payload.token) }
        },
        catch: (error) => error,
      }),
  }
}

export function makeSqliteProcessProvider(
  directory: string,
  checkpoint: (point: ProcessCheckpoint) => Effect.Effect<void> = () => Effect.void,
): OAuthProviderDefinition<ProcessCredentials> {
  return {
    id: 'salesforce',
    authorizationUrl: ({ state }) =>
      Effect.succeed(`https://provider.example.test/authorize?state=${encodeURIComponent(state)}`),
    parseAuthorizationCallback: (callbackUrl) => {
      const url = new URL(callbackUrl)
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      return state === null || code === null
        ? Effect.fail(new Error('Invalid process fixture callback'))
        : Effect.succeed<AuthorizationCallback>({
            _tag: 'AuthorizationGranted',
            state,
            code: Redacted.make(code),
          })
    },
    exchangeAuthorizationCode: ({ code }) =>
      Effect.gen(function* () {
        const authorizationCode = Redacted.value(code)
        const credentials =
          authorizationCode === replacementAuthorizationCode
            ? replacementCredentials
            : authorizationCode === reenrollmentAuthorizationCode
              ? reenrolledCredentials
              : null
        if (credentials === null) {
          return yield* Effect.fail({ reason: 'ProviderRejected' as const })
        }
        const committed = yield* Effect.sync(() => commitProviderAuthorization(directory))
        if (committed.authorizationCalls < 1 || committed.authorizationProcessed < 1) {
          return yield* Effect.fail({ reason: 'TransportFailure' as const })
        }
        yield* checkpoint('replacement-response-received')
        return {
          protectedPayload: Redacted.make(JSON.stringify(credentials)),
          credentialExpiresAt: null,
        }
      }),
    refreshCredentials: ({ protectedPayload }) =>
      Effect.gen(function* () {
        yield* checkpoint('dispatch-possible')
        const previous = yield* Effect.sync(() => storedCredentials(protectedPayload))
        if (previous.refreshToken !== initialCredentials.refreshToken) {
          return { _tag: 'ProviderFailure' } satisfies ProviderRefreshOutcome
        }
        const committed = yield* Effect.sync(() => commitProviderRefresh(directory))
        if (committed.calls < 1 || committed.processed < 1) {
          return { _tag: 'ProviderFailure' } satisfies ProviderRefreshOutcome
        }
        yield* checkpoint('response-received')
        if (committed.refreshOutcome === 'provider-rejected') {
          return { _tag: 'ProviderRejected' } satisfies ProviderRefreshOutcome
        }
        return {
          _tag: 'Refreshed',
          credentials: {
            protectedPayload: Redacted.make(JSON.stringify(refreshedCredentials)),
            credentialExpiresAt: null,
          },
        } satisfies ProviderRefreshOutcome
      }),
    projectCredentials: (protectedPayload) =>
      Effect.try({
        try: () => ({
          accessToken: Redacted.make(storedCredentials(protectedPayload).accessToken),
        }),
        catch: (error) => error,
      }),
  }
}

export function makeSqliteProcessSelfClientProvider(
  directory: string,
  checkpoint: (point: ProcessCheckpoint) => Effect.Effect<void> = () => Effect.void,
): SelfClientProviderDefinition<ProcessCredentials> {
  return {
    id: PROCESS_SELF_CLIENT_CONNECTION_KEY.providerId,
    exchangeSelfClientCode: ({ code }) =>
      Effect.gen(function* () {
        yield* checkpoint('dispatch-possible')
        const credentials = selfClientCredentialsByCode[Redacted.value(code)]
        if (credentials === undefined)
          return yield* Effect.fail({ reason: 'ProviderRejected' as const })
        yield* Effect.sync(() => commitProviderAuthorization(directory))
        yield* checkpoint('self-client-response-received')
        return {
          protectedPayload: Redacted.make(JSON.stringify(credentials)),
          credentialExpiresAt: null,
        }
      }),
    refreshCredentials: () => Effect.succeed({ _tag: 'ProviderOutcomeUnknown' }),
    projectCredentials: (protectedPayload) =>
      Effect.try({
        try: () => ({
          accessToken: Redacted.make(storedCredentials(protectedPayload).accessToken),
        }),
        catch: (error) => error,
      }),
  }
}

export async function initializeSqliteClientCredentialsProcessFixture(
  directory: string,
  options: { readonly refreshOutcome?: ProcessRefreshOutcome } = {},
): Promise<void> {
  initializeProviderDatabase(directory, options.refreshOutcome ?? 'refreshed')
  const store = new SqliteProcessStore(directory)
  try {
    const credentialEnvelope = await Effect.runPromise(
      store.protect(
        Redacted.make(JSON.stringify({ version: 1, source: initialClientSource, token: null })),
        { ...PROCESS_CLIENT_CONNECTION_KEY, generation: 0, purpose: 'credentials' },
      ),
    )
    store.unsafeSeedConnection({
      schemaVersion: 1,
      key: PROCESS_CLIENT_CONNECTION_KEY,
      generation: 0,
      revision: 0,
      authorization: {
        _tag: 'Authorized',
        credentialExpiresAt: null,
        credentialAcquiredAt: null,
      },
      credentialEnvelope,
      credentialOperation: null,
    })
  } finally {
    store.close()
  }
}

export async function initializeSqliteProcessFixture(
  directory: string,
  options: { readonly refreshOutcome?: ProcessRefreshOutcome } = {},
): Promise<void> {
  initializeProviderDatabase(directory, options.refreshOutcome ?? 'refreshed')
  const store = new SqliteProcessStore(directory)
  try {
    const credentialEnvelope: ProtectedCredentialEnvelope = await Effect.runPromise(
      store.protect(Redacted.make(JSON.stringify(initialCredentials)), {
        ...PROCESS_CONNECTION_KEY,
        generation: 0,
        purpose: 'credentials',
      }),
    )
    store.unsafeSeedConnection({
      schemaVersion: 1,
      key: PROCESS_CONNECTION_KEY,
      generation: 0,
      revision: 0,
      authorization: { _tag: 'Authorized', credentialExpiresAt: 0 },
      credentialEnvelope,
      credentialOperation: null,
    })
  } finally {
    store.close()
  }
}
