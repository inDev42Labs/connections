# Repository guidance for coding agents

## Find project guidance

Use README's [Project documentation](README.md#project-documentation) and [Agent documentation](README.md#agent-documentation) indexes.

- Before local setup or verification, read the [development quickstart](README.md#develop-this-repository).
- Before pushing, releasing, or changing release configuration, read [distribution guidance](README.md#publish-a-release).
- Before ticket access or updates, read [issue-tracker guidance](docs/agents/issue-tracker.md). Before assigning implementation triage roles, read the [mapping](docs/agents/triage-labels.md).
- Before exploring domain concepts or proposing terminology changes, read [domain guidance](docs/agents/domain.md) and the [glossary](GLOSSARY.md).
- When evaluating consequential trade-offs or creating or revisiting records, read [decision-record guidance](docs/agents/decision-records.md).
- Before changing governed work or proposing amendments, read the [constitution](CONSTITUTION.md) and its [agent guidance](docs/agents/constitution.md).
- Before adding, changing, or removing tests, read the [testing guidance](docs/testing.md) for approved seams and coverage-preserving migration requirements.
- Before changing code, read the repository's [lint](.oxlintrc.json) and [format](.oxfmtrc.json) configuration.

## Read the current target

Treat `docs/` as authoritative for intended behavior and extension boundaries. Before changing public behavior, read [getting started](docs/getting-started.md) and the [reference](docs/reference.md). Custom-provider, custom-store, and custom-encryptor extension APIs are deferred; see [supported integrations](docs/reference.md#supported-integrations). Do not add restrictions solely to block unsupported structural use. Read the relevant provider or store guide for adapter-specific work.

Follow [CONSTITUTION.md](CONSTITUTION.md) and use [GLOSSARY.md](GLOSSARY.md) for domain terms. Verify current behavior in `src/` and `tests/`; resolve relevant undocumented extension decisions before implementation.

## Maintain useful documentation

Keep getting started focused on common workflows through representative examples and the reference focused on shared interfaces and provider and store catalogs. Put provider-specific and store-specific differences in `docs/providers/` and `docs/stores/`. Link catalog entries to these guides; keep getting-started discovery links pointed at the catalogs.

Keep consumer behavior in `docs/`, exact declarations in code, schemas, and configuration, actionable remaining work and implementation plans in issues, and consequential rationale in decision records. Do not recreate completed initiatives or obsolete targets.

Update the semantic owner and affected links when a claim changes. Keep historical versions in Git.

## Approve material behavior changes

Obtain owner approval before materially changing the public interface or library functionality. Routine documentation corrections, updates, and additions for approved stores or providers do not require separate approval. Keep them consistent with accepted behavior and verify their claims. Remove a target-not-implemented disclaimer only after the entire behavior it covers is implemented and verified. Do not remove a page-wide disclaimer while any covered interface remains unimplemented.

If work reveals a conflict or requires a material target change, stop the affected work and ask the owner. Do not silently redefine behavior through documentation or implementation. Apply these boundaries to delegated work as well.

Require an explicit compatibility and migration decision before changing persisted declarations or encryption identity. Key or encryption-identity changes require migration, not implicit rotation.

## Verify within scope

Read `package.json` for current commands and the [README setup](README.md#develop-this-repository) for prerequisites and evidence limits. Run `bun run check` and the relevant integration path for implementation changes. For interface changes, follow [PR-010](CONSTITUTION.md#pr-010-catch-invalid-api-use-before-execution): verify accepted usage and rejected misuse through public type and package-consumer checks. Keep lint safeguards repository-local; do not ship independent lint rules. Do not claim live integrations or deployment from local substitutes. Obtain explicit authorization before contacting external services or running the real PostgreSQL check.

## Commits

After completing and verifying a coherent unit of work, commit its changes unless instructed otherwise. Stage only files belonging to that work. If verification or scope is unresolved, report the blocker rather than commit incomplete or ambiguous work. Never push without an explicit request.
