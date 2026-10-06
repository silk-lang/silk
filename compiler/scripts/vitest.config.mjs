import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
const compilerRequire = createRequire(
  new URL('../../packages/compiler/package.json', import.meta.url),
)
export default defineConfig({
  resolve: { alias: { '@effect/vitest': compilerRequire.resolve('@effect/vitest') } },
  test: { include: ['compiler/scripts/*.test.mjs'], maxWorkers: 1, testTimeout: 3000 },
})
