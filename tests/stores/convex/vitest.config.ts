import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(import.meta.dirname, '../../..'),
  test: {
    name: 'convex',
    environment: 'edge-runtime',
    include: ['tests/stores/convex/**/*.test.ts'],
    exclude: ['tests/stores/convex/local/**'],
    testTimeout: 15_000,
  },
})
