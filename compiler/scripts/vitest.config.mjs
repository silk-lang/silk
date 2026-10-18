import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['compiler/scripts/*.test.mjs'], maxWorkers: 1, testTimeout: 3000 },
})
