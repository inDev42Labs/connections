# Domain language

Read the [glossary](../../GLOSSARY.md) before exploring domain concepts, discussing terminology, or proposing a change. Connections uses one domain context and one root glossary.

Use the agreed terms in proposals, issues, documentation, and code. Configuration helpers, stores, encryptors, adapters, Effect services, and layers are implementation mechanisms, not automatically domain concepts. "Access" remains an informal description, not an agreed domain entity.

## Active practice

- Challenge usage that conflicts with a glossary definition. Name the conflicting meanings and ask which is intended.
- Sharpen vague or overloaded language by proposing a precise canonical term rather than silently choosing a meaning.
- Test domain relationships with concrete scenarios that expose their boundaries.
- Compare claims with consumer docs, code, tests, and specifications. Surface contradictions rather than silently changing the contract.
- Record a resolved definition in the glossary immediately. A proposed term remains a proposal until agreed.

## Definition format

Use a bold term, one or two sentences defining the concept, and an optional `_Avoid_` line for misleading synonyms.

Choose one canonical name. Include project-specific domain concepts, not general programming vocabulary, implementation decisions, or work notes. Group related terms only when that improves lookup.

## Maintenance and approval

Owner agreement to a definition authorizes recording it; do not ask for the same approval again. Preserve established definitions until a change is agreed. Public behavior changes still require the approval established in [repository instructions](../../AGENTS.md#approve-material-behavior-changes).

Reconcile affected usage and links when terminology changes. Changes to this procedure require owner approval.

Keep consequential decision rationale in [decision records](../adr/README.md), not glossary definitions.
