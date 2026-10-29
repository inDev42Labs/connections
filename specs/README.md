# Implementation rationale

[Consumer docs](../docs/reference.md) own intended behavior and extension boundaries. The remaining notes explain implementation choices rather than define additional requirements:

- [Execution choice](credential-lifecycle/spec.md): shared Effect workflows are not a public mandate.
- [Persistence rationale](protected-storage/spec.md): transactional coordination, compatibility decisions, and unresolved persistence design.

Exact types, provider fields, storage schemas, and exports belong to `src/`; executable guarantees belong to `tests/`. Commands and verification limits belong to `package.json` and the [development quickstart](../README.md#develop-this-repository).

The [supported integration boundary](../docs/reference.md#supported-integrations) defers custom-provider, custom-store, and custom-encryptor extension APIs. Additional Effect-service provision and provider namespaces require separate design decisions. These boundaries are not approved implementation tasks.

No generic auth-method abstraction, required library-level owner model, universal external-account model, or vault abstraction is selected. Internal mechanism names do not establish those public contracts.
