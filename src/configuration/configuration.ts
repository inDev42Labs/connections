import { Config, Data, Effect, Redacted } from 'effect'

export class ConfigurationReadFailure extends Data.TaggedError('ConfigurationReadFailure')<{
  readonly reason: 'Missing' | 'ReadFailed'
}> {}

export function string(name: string): Config.Config<string>
export function string(
  read: () => string | undefined,
): Effect.Effect<string, ConfigurationReadFailure>
export function string(
  input: string | (() => string | undefined),
): Config.Config<string> | Effect.Effect<string, ConfigurationReadFailure> {
  if (typeof input === 'string') return Config.string(input)
  return Effect.try({
    try: input,
    catch: () => new ConfigurationReadFailure({ reason: 'ReadFailed' }),
  }).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.fail(new ConfigurationReadFailure({ reason: 'Missing' }))
        : Effect.succeed(value),
    ),
  )
}

export function secret(name: string): Config.Config<Redacted.Redacted<string>>
export function secret(
  read: () => string | Redacted.Redacted<string> | undefined,
): Effect.Effect<Redacted.Redacted<string>, ConfigurationReadFailure>
export function secret(
  input: string | (() => string | Redacted.Redacted<string> | undefined),
):
  | Config.Config<Redacted.Redacted<string>>
  | Effect.Effect<Redacted.Redacted<string>, ConfigurationReadFailure> {
  if (typeof input === 'string') return Config.redacted(input)
  return Effect.try({
    try: input,
    catch: () => new ConfigurationReadFailure({ reason: 'ReadFailed' }),
  }).pipe(
    Effect.flatMap((value) => {
      if (value === undefined) {
        return Effect.fail(new ConfigurationReadFailure({ reason: 'Missing' }))
      }
      return Effect.succeed(typeof value === 'string' ? Redacted.make(value) : value)
    }),
  )
}
