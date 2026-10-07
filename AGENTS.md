# Repository guidance for coding agents

## Read the current target

Treat `docs/` as authoritative for intended behavior and extension boundaries. Before changing public behavior, read [getting started](docs/getting-started.md) and the [reference](docs/reference.md). Custom-provider, custom-store, and custom-encryptor extension APIs are deferred; see [supported integrations](docs/reference.md#supported-integrations). Do not add restrictions solely to block unsupported structural use. Read the relevant provider or store guide for adapter-specific work.

Follow [CONSTITUTION.md](CONSTITUTION.md) and use [CONTEXT.md](CONTEXT.md) for domain terms. [specs/README.md](specs/README.md) routes to technical clarification and plans, not a competing authority. Verify current behavior in `src/` and `tests/`; resolve relevant undocumented extension decisions before implementation.

## Maintain useful documentation

Keep getting started focused on common workflows through representative examples and the reference focused on shared interfaces and provider and store catalogs. Put provider-specific and store-specific differences in `docs/providers/` and `docs/stores/`. Link catalog entries to these guides; keep getting-started discovery links pointed at the catalogs.

Use the `project-documentation` system when creating or migrating project artifacts. Keep `specs/<feature-name>/` organized by active outcomes without numeric prefixes. A spec explains current intent, a plan records distinct technical approach and verification, and tasks record actionable remaining work. Do not recreate completed initiatives, obsolete targets, or empty artifact sets. Reference code, schemas, and configuration for exact declarations.

Update the semantic owner and affected links when a claim changes. Specs must follow `docs/`, never silently redefine them. Keep historical versions in Git. `experiments/` contains isolated historical evidence, not production code or an API contract. Read an experiment only to answer its named design question; implement and verify through `src/` and `tests/`, without importing experiment modules.

## Approve material behavior changes

Obtain owner approval before materially changing the public interface or library functionality. Routine documentation corrections, updates, and additions for approved stores or providers do not require separate approval. Keep them consistent with accepted behavior and verify their claims. Remove a target-not-implemented disclaimer only after the entire behavior it covers is implemented and verified. Do not remove a page-wide disclaimer while any covered interface remains unimplemented.

If work reveals a conflict or requires a material target change, stop the affected work and ask the owner. Do not silently redefine behavior through documentation or implementation. Apply these boundaries to delegated work as well.

## Verify within scope

Read `package.json` for current commands and the [README setup](README.md#develop-this-repository) for prerequisites and evidence limits. Run `bun run check` and the relevant integration path for implementation changes. For interface changes, follow [PR-010](CONSTITUTION.md#pr-010-catch-invalid-api-use-before-execution): verify accepted usage and rejected misuse through public type and package-consumer checks. Keep lint safeguards repository-local; do not ship independent lint rules. Do not claim live integrations or deployment from local substitutes. Obtain explicit authorization before contacting external services or running the real PostgreSQL check.
