import { expect, test } from 'vitest'
import { canonicalStoreInput, digestStoreInput } from '../../../src/stores/index.js'

test('preserves persisted command identity regardless of input property order', async () => {
  const inputs = [
    {
      key: { providerId: 'salesforce', namespace: 'example', connectionId: 'connection' },
      _tag: 'InitializeConnection',
    },
    {
      _tag: 'InitializeConnection',
      key: { connectionId: 'connection', namespace: 'example', providerId: 'salesforce' },
    },
  ]

  // These are persisted protocol values, not outputs regenerated from the implementation.
  for (const input of inputs) {
    expect(canonicalStoreInput(input)).toBe(
      '{"_tag":"InitializeConnection","key":{"connectionId":"connection","namespace":"example","providerId":"salesforce"}}',
    )
    await expect(digestStoreInput(input)).resolves.toBe(
      '021ecb87c9e88b94a2c5fef51cc3762e1167e74d83a1af6bcc7ff16eea0c1085',
    )
  }
})
