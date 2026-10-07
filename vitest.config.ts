import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'experiments/**',
      'tests/package/**',
      'tests/process-loss/**',
      'tests/stores/convex/**',
      'tests/types/**',
    ],
  },
})
