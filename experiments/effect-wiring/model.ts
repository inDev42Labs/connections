// THROWAWAY DESIGN EXPERIMENT — not exported by the package.
// Checks Effect dependency propagation, NOT OAuth or production storage.
import { Config, Context, Data, Effect, Redacted, Schema } from 'effect'

export class MissingConnection extends Data.TaggedError('MissingConnection')<{
  readonly connectionId: string
}> {}

// Stand-in for an application's existing SQL client. No real database is used.
export class FakeDatabase extends Context.Service<FakeDatabase, {
  readonly read: (
    namespace: string,
    connectionId: string,
  ) => Effect.Effect<unknown, MissingConnection>
}>()('prototype/FakeDatabase') {}

interface Store<E, R> {
  readonly read: (
    namespace: string,
    connectionId: string,
  ) => Effect.Effect<unknown, E, R>
}

export const FakeStore = {
  // Deliberately unencrypted, read-only fixture adapter. Not a proposed store contract.
  store: (): Store<MissingConnection, FakeDatabase> => ({
    read: (namespace, connectionId) => Effect.gen(function* () {
      const database = yield* FakeDatabase
      return yield* database.read(namespace, connectionId)
    }),
  }),
}

export const Salesforce = {
  id: 'salesforce',
  // Validates a fake stored row and wraps the secret at the retrieval boundary.
  credentials: Schema.Struct({
    accessToken: Schema.RedactedFromValue(Schema.String),
    instanceUrl: Schema.String,
  }),
}

export const Resend = { id: 'resend' }
export const Configuration = { secret: Config.redacted }

export const Connections = {
  oauth: <S extends Schema.Constraint, E, R>(options: {
    readonly namespace: string
    readonly provider: { readonly id: string; readonly credentials: S }
    readonly store: Store<E, R>
  }) => ({
    connection: (id: string) => ({
      id,
      credentials: () => Effect.gen(function* () {
        const stored = yield* options.store.read(options.namespace, id)
        return yield* Schema.decodeUnknownEffect(options.provider.credentials)(stored)
      }),
    }),
  }),

  apiKey: <E, R>(options: {
    readonly provider: { readonly id: string }
    readonly key: Effect.Effect<Redacted.Redacted<string>, E, R>
  }) => ({
    credentials: () => Effect.map(options.key, (apiKey) => ({ apiKey })),
  }),
}
