import { expect, test } from 'vitest'

test('runs Convex adapter tests with Web Crypto in the edge runtime', () => {
  expect(globalThis.crypto).toBeDefined()
  expect(globalThis.crypto.subtle).toBeDefined()
  expect(Reflect.get(globalThis, 'EdgeRuntime')).toBe('edge-runtime')
})
