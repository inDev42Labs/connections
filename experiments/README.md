# Design experiments

**Historical design evidence, not the target interface.** These throwaway programs answer bounded questions about the earlier implementation. Public syntax and suggested wiring may conflict with [the current consumer target](../docs/reference.md). Read a specific experiment only to investigate its stated question; do not import its modules or copy its API into production. Keep experiments here rather than under `src/`.

## Check isolation

- The root TypeScript configuration includes `src/`, not this directory.
- Root Vitest explicitly excludes `experiments/**`.
- When root linting and formatting are introduced, exclude this directory from their default scope. Moving files does not automatically exclude them from every tool.
- Experiment checks remain available through explicit commands. Do not add them to default package checks merely because they live in the same repository.

## Effect wiring, refresh, and lifecycle

These small experiments use the root package's dependencies and a dedicated TypeScript configuration. From the repository root:

```sh
bunx --no-install tsc --noEmit -p experiments/tsconfig.json
bun experiments/effect-wiring/demo.ts
bun experiments/refresh/demo.ts
bun experiments/lifecycle/demo.ts
bun experiments/lifecycle/process-demo.ts
```

Read the [Effect wiring findings](effect-wiring/README.md), [refresh findings](refresh/README.md), and [lifecycle/recovery findings](lifecycle/README.md) for scope and limitations. The lifecycle demo models retained history across fresh runtimes. Its separate process demo adds controlled OS-worker termination and fresh-process recovery against disposable SQLite state with a fake provider; it does not establish production durability.

## Convex component

The [Convex experiment](convex-store/README.md) is a private subpackage with its own dependencies, configuration, and local backend state:

```sh
cd experiments/convex-store
bun install
bun run typecheck
bun run test
bun run local
```

The local runner needs no cloud deployment or real provider credentials. Read its README before running it, especially its local-only safeguards and platform requirements.
