# Technical clarification

[Consumer docs](../docs/reference.md) own intended behavior and extension boundaries. The notes below retain lifecycle safety constraints and implementation rationale not fully explained there. [CONSTITUTION.md](../CONSTITUTION.md) owns project constraints; [GLOSSARY.md](../GLOSSARY.md) owns domain terms.

- [Authorization](authorization/spec.md): callback lifetime, replacement preparation, and exchange fences.
- [Credential lifecycle](credential-lifecycle/spec.md): recovery evidence, inspection failures, and removal confirmation.
- [Protected storage](protected-storage/spec.md): atomic receipts, dispatch evidence, and persistence compatibility.

Exact types, provider fields, storage schemas, and exports belong to `src/`; commands and verification gates belong to `package.json` and the [development quickstart](../README.md#develop-this-repository). The notes link to code and tests for their retained guarantees. Local substitutes do not establish live-provider compatibility or cloud deployment.

The [supported integration boundary](../docs/reference.md#supported-integrations) defers custom-provider, custom-store, and custom-encryptor extension APIs. Additional Effect-service provision and provider namespaces require separate design decisions. These boundaries are not approved implementation tasks.

No generic auth-method abstraction, required library-level owner model, universal external-account model, or vault abstraction is selected. Internal mechanism names do not establish those public contracts.
