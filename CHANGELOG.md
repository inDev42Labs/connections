# @indev42/connections

## 1.0.0

### Major Changes

- e392452: Replace the manager-wide token store with per-provider bindings, make binding keys the authoritative provider namespace, add raw credential sources and an environment-backed source, and support both source-backed and stored static providers with direct type-safe configuration.

## 0.6.0

### Minor Changes

- 442f609: Add a Retell AI provider that converts API keys into static bearer token records.

## 0.5.0

### Minor Changes

- 05fdea3: Add explicit static and refreshable token lifecycles, support expiring static tokens, and add `TokenManager.saveToken()` as the general token persistence API.

## 0.4.1

### Patch Changes

- 0ba92f7: Improved record validation and observability

## 0.4.0

### Minor Changes

- 98622a5: Added a built in encryptor that can be consumed by the end user

## 0.3.1

### Patch Changes

- e5ec62f: Updated Convex store readme

## 0.3.0

### Minor Changes

- a90f6de: Implemented convex provider and a dummy provider
