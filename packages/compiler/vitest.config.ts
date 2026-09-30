import { homedir } from 'node:os'
import { join } from 'node:path'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { configDefaults } from 'vitest/config'
import { defineSilkConfig, wholeMachineWorkers } from '../../vitest.shared.js'

const nativeCacheDirectory = Effect.runSync(
  Config.String('SILK_NATIVE_CACHE_DIR').pipe(
    Config.withDefault(join(homedir(), '.cache', 'silk-effect', 'native')),
  ),
)
const ci = Effect.runSync(Config.Boolean('CI').pipe(Config.withDefault(false)))

export default defineSilkConfig({
  test: {
    exclude: [...configDefaults.exclude, 'conformance/**'],
    // Service replacements are scoped to each Effect and source fixture overrides are restored.
    // Reuse compiler modules and immutable shipped syntax across files in each worker.
    isolate: false,
    /**
     * JUL-227: each compiler shard has its own four-core CI runner, but full-core concurrency
     * made expensive files contend with each other. A native-final-cache test took 39.9 s on an
     * unloaded machine yet exceeded 120 s on CI. Keep two workers on CI so each costly compiler
     * pipeline has CPU headroom; local development retains the host-derived worker count.
     */
    maxWorkers: ci ? Math.min(2, wholeMachineWorkers) : wholeMachineWorkers,
    env: {
      // Shared across worktrees for backend emission and independently eligible cache entries.
      SILK_NATIVE_CACHE_DIR: nativeCacheDirectory,
    },
  },
})
