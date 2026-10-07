# Connections constitution

These rules constrain the current target and future changes. [Consumer docs](docs/reference.md) own intended behavior and extension boundaries. [Technical specifications](specs/README.md) explain that target without overriding it.

## PR-001: Ship a library, not a platform

Connections MUST remain a distributed code package without a Connections-operated service or control plane. An adapter MAY use infrastructure deliberately chosen and operated by the consuming application. Plans must identify any required consumer infrastructure.

## PR-002: Supply credentials, not application clients

Connections MUST own authorization and credential lifecycle workflows while leaving protected-resource requests to the application's SDK or HTTP client. Public credential results MUST contain provider-specific use material without refresh tokens or lifecycle-only application secrets. Verify this boundary through public types and usage tests.

## PR-003: Keep application authority in the application

The application MUST own connection identity, ownership, authentication, and permissions. Possession of a connection ID MUST NOT grant authority. Application entry points must check access before exposing information or changing state; library-required authorization callbacks must run before code exchange. Examples and tests must distinguish these responsibilities.

## PR-004: Protect secrets deliberately

Connections MUST protect persisted credentials, minimize returned secrets, and keep secrets out of library-generated logs, diagnostics, failures, and non-secret results. Redaction MUST NOT be described as encryption. Verify persistence protection, safe output, tampering, and substitution failures.

## PR-006: Hide coordination behind infrastructure seams

Built-in integrations MUST hide lifecycle coordination from ordinary consumers. Custom adapters MUST implement documented capabilities and atomicity guarantees, not orchestrate workflows or choose provider retry policy. Verify guarantees through the seam the production workflow actually uses.

## PR-007: Recover only from defensible evidence

Automatic recovery MUST be justified by provider behavior and retained operation evidence. Timeout, cancellation, ownership expiry, and transport failure MUST NOT be treated as proof that a remote operation did not occur. Superseded work MUST NOT overwrite newer state. When recovery cannot be justified, expose uncertainty rather than replaying blindly or falsely declaring revocation. Verify concurrency, interruption, lost responses and acknowledgements, ownership transfer, and bounded recovery.

## PR-008: Require direct evidence for delivered behavior

Delivered behavior MUST have executable evidence through its production interface or infrastructure seam. Compilation or an isolated internal test is not sufficient for an integration claim. Claims about external providers must cite authoritative evidence and state whether live-provider validation exists. Report unavailable prerequisites and evidence limits instead of claiming completion.

## PR-009: Keep direct runtime dependencies Effect-only

The published package's direct runtime dependencies MUST contain only Effect unless the owner explicitly approves another dependency before addition. Prefer platform capabilities, consumer-provided integration packages, or project-owned code. Development tooling MUST NOT become a published runtime requirement. Verify `package.json` and package-consumer checks.

## PR-010: Catch invalid API use before execution

The public API MUST preserve precise configuration, capability, and provider-specific result types. Invalid setup and unsupported operations MUST be rejected by the TypeScript compiler wherever statically knowable. Repository lint checks MUST reinforce constraints they can reliably check. Consumers MUST receive compile-time safeguards through the package's TypeScript declarations, without requiring a Connections-specific lint plugin. Connections MUST NOT ship independent lint rules. Public APIs MUST NOT require callers to bypass type safety for supported use.

Verify accepted usage and rejected misuse through public-interface type tests and published-package consumer checks. Runtime validation MUST remain for values and conditions that static checks cannot establish, including environment configuration, secrets, persisted data, and provider responses.

## Maintain the rules and their owners

The project owner approves amendments and exceptions. Higher-precedence platform and user instructions still govern repository work. Reconcile a changed rule with affected docs, specs, agent instructions, and tests; do not hide an exception in a plan.

Keep governance here, consumer intent in `docs/`, technical clarification in living feature specs, approach in plans, and actionable remaining work in tasks. Exact declarations belong to code, schemas, and configuration. Git preserves superseded targets and completed initiatives. If a technical artifact conflicts with the consumer target or a rule, stop the affected work and resolve the conflict with the owner.
