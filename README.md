# Connections

Connections is a TypeScript library that supplies credentials for external providers and renews them when safe. Your application chooses connection IDs, checks permissions, operates the store, and makes provider API requests with its own SDK or HTTP client.

Start with [Get credentials for a connection](docs/getting-started.md) for built-in Promise setup and use. Returned secrets stay redacted until you call `revealSecret` at the provider-request boundary. Managers also expose equivalent operations through `manager.effect` for Effect composition. Custom-provider, custom-store, and custom-encryptor extension APIs are deferred; see [supported integrations](docs/reference.md#supported-integrations). The built-in Convex store uses invocation binding.

## Find what you need

- [Reference](docs/reference.md): methods, providers, stores, failures, and security boundaries.
- [Use Connections with Effect](docs/effect.md): compose operations, handle failures, and run programs through `manager.effect`.
- [Convex setup](docs/stores/convex.md) and [PostgreSQL setup](docs/stores/postgresql.md): adapter-specific configuration and execution.
- [Active technical specifications](specs/README.md): feature requirements, implementation seams, and verification paths.
- [Constitution](CONSTITUTION.md) and [domain vocabulary](CONTEXT.md): project constraints and shared terms.

`docs/` is the authoritative human-facing target. `specs/` provides technical clarification, not an alternative target or initiative history. Exact exports, dependencies, and commands are declared in `package.json`.

## Develop this repository

Use the Bun version declared by `packageManager` in `package.json`. The local checks were exercised with Bun 1.4.0 and Node.js 24.21.0. Node must support `node:sqlite`; process-isolation and process-loss runners require POSIX process behavior.

From the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

`check` validates formatting, lint, the package skill, TypeScript and public types, and the default tests. `build` produces package artifacts. These checks use local fixtures and provider substitutes, not real provider accounts. Dependency installation requires package-registry access or a populated cache; a fresh online installation is not part of the local verification evidence.

For broader verification, run `bun run verify`. It also runs Convex tests, process-isolation checks, an anonymous local Convex backend, controlled process-loss checks, and packed-package consumer tests. Local Convex needs the pinned backend used by `tests/stores/convex/local/run.ts`; package tests install fixture dependencies. Initial dependency/backend downloads require network access. The runners own disposable state and refuse occupied test ports. Read their prerequisites before running them in a restricted environment.

No secrets or live integration configuration are required for the default checks. Real PostgreSQL verification is separate, requires explicit permission and a disposable backend, and is described in the [PostgreSQL guide](docs/stores/postgresql.md). Local verification does not establish a cloud deployment or live-provider compatibility.

## Publish a release

Releases use `bumpp` and the [npm publishing workflow](.github/workflows/publish.yml). Ordinary branch pushes do not publish. A `v<version>` tag push verifies the release, packs it, and publishes that archive to npm's `latest` tag using trusted publishing. The workflow rejects prerelease versions, the `0.0.0` placeholder, tags that differ from `package.json`, and commits outside `main`.

Before the first release, merge the replacement into `inDev42Labs/connections` while retaining upstream history and release tags. Remove upstream's Changesets configuration and release workflow when copying this project's files. In npm's settings for `@indev42/connections`, configure a GitHub Actions trusted publisher with organization `inDev42Labs`, repository `connections`, and workflow filename `publish.yml`. Allow direct `npm publish`; no environment name or npm token is required. See [npm trusted publishing setup](https://docs.npmjs.com/trusted-publishers/). The npm configuration and hosted publishing path must be verified at release time.

From a clean, up-to-date checkout of upstream `main`, run:

```sh
bun run verify
bun run release --release 2.0.0
```

The first replacement release is `2.0.0`. For subsequent releases, run `bun run release` and choose the next stable version. After confirmation, the release command updates `package.json`, creates a release commit and version tag, and pushes both. Those pushes trigger publication, so run this command only when you intend to release. Inspect the GitHub Actions run before treating the version as published. Do not delete and recreate a release tag or blindly rerun publishing after an uncertain result.
