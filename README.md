# Connections

Connections is a TypeScript library that supplies credentials for external providers and renews them when safe. Your application chooses connection IDs, checks permissions, operates the store, and makes provider API requests with its own SDK or HTTP client.

Start with [Get credentials for a connection](docs/getting-started.md) for built-in Promise setup and use. Returned secrets stay redacted until you call `revealSecret` at the provider-request boundary. Managers also expose equivalent operations through `manager.effect` for Effect composition. Custom-provider, custom-store, and custom-encryptor extension APIs are deferred; see [supported integrations](docs/reference.md#supported-integrations). The built-in Convex store uses invocation binding.

## Project documentation

- [Get credentials for a connection](docs/getting-started.md): built-in setup and common workflows.
- [Reference](docs/reference.md): methods, providers, stores, failures, and security boundaries.
- [Use Connections with Effect](docs/effect.md): composition through `manager.effect`.
- [Convex setup](docs/stores/convex.md) and [PostgreSQL setup](docs/stores/postgresql.md): adapter-specific configuration and execution.
- [Development quickstart](#develop-this-repository): prerequisites, local checks, and evidence limits.
- [Distribution](#publish-a-release): release triggers, access, verification, and recovery.
- [Glossary](GLOSSARY.md): agreed domain vocabulary.
- [Decision records](docs/adr/README.md): consequential choices and their rationale.
- [Constitution](CONSTITUTION.md): durable constraints and amendment rules.

`docs/` owns intended consumer behavior. Code, schemas, and configuration own exact declarations; tests provide executable guarantees. Issues track remaining work, and decision records explain consequential choices. Exact exports, dependencies, and commands are declared in `package.json`.

## Agent documentation

- [Repository instructions](AGENTS.md): consultation triggers and operating boundaries.
- [Issue tracker](docs/agents/issue-tracker.md): GitHub operations and authorization boundaries.
- [Implementation triage](docs/agents/triage-labels.md): implementation-ticket label mapping.
- [Domain guidance](docs/agents/domain.md): terminology practice and glossary maintenance.
- [Decision-record guidance](docs/agents/decision-records.md): criteria, format, acceptance, and supersession.
- [Constitution guidance](docs/agents/constitution.md): applying and maintaining governance.

## Develop this repository

Use the Bun version declared by `packageManager` in `package.json` and the Node.js version configured in CI. Node must support `node:sqlite`; process-isolation and process-loss runners require POSIX process behavior.

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

Connections is distributed as `@indev42/connections` on npm. The source workflow is [publish.yml](.github/workflows/publish.yml).

### Access and triggers

Publishing requires owner authorization and permission to push release commits and tags to `inDev42Labs/connections`. Ordinary branch pushes do not publish; pushes to `main` run CI. A `v<version>` tag push triggers release verification and npm publication. The publishing workflow also accepts a manual run for an existing release tag.

npm must have a GitHub Actions trusted publisher configured for organization `inDev42Labs`, repository `connections`, and workflow filename `publish.yml`, without an environment name. The workflow uses trusted publishing rather than an npm token. Maintainers manage that configuration separately in npm; editing local files does not change it. See [npm trusted publishing setup](https://docs.npmjs.com/trusted-publishers/).

### Release

From a clean, up-to-date checkout of `main` tracking `origin/main`:

```sh
bun run verify
bun run release
```

Choose the next stable version. After confirmation, the release command updates `package.json`, creates a release commit and version tag, and pushes both. Run it only when authorized to release.

The workflow rejects prerelease versions, `0.0.0`, tags that differ from `package.json`, and commits outside `main`. It verifies the release, packs it, and publishes that archive to npm's `latest` tag.

### Verify publication

Inspect both the verification and publishing jobs in GitHub Actions. Confirm that npm exposes the intended package version and that `latest` selects it. A successful local build does not establish publication. Hosted configuration and the publishing path require verification at release time.

### Recover

Do not delete and recreate a release tag or blindly rerun publishing after an uncertain result. Confirm whether npm already contains the version. If the workflow failure left it unpublished, manually run the publishing workflow with `release_tag` set to the existing version tag. The recovery run verifies and packs that tag's code without changing it.

No approved procedure is established here for withdrawing a published release or changing `latest` back to an earlier version. Obtain owner direction before either action.

### Maintain this procedure

Reconcile this section with `package.json` and the publishing workflow whenever release behavior changes. The owner approves changes to the release procedure. Documented commands do not grant permission to push, publish, or change remote configuration.
