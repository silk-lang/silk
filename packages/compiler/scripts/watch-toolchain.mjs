import { execFileSync, spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const generator = fileURLToPath(new URL('./generate-toolchain-integrity.mjs', import.meta.url))
const generate = () => execFileSync(process.execPath, [generator], { stdio: 'inherit' })

// Refresh the identity before startup, on compiler source edits, and when the `@silklang/llvm`
// build rewrites its `dist`. Writing only changed output keeps the generated module's own
// filesystem event from causing a watch loop. Directory additions/removals can also change a
// recursive inventory. A missing input at startup is fatal; later failures are reported and retried
// on the next event so a rebuild that briefly removes llvm `dist` does not end the session.
generate()

// One llvm watch emit writes hundreds of files; coalesce each burst into one regeneration.
let pending
const refresh = () => {
  clearTimeout(pending)
  pending = setTimeout(() => {
    try {
      generate()
    } catch (error) {
      process.stderr.write(`Toolchain identity not refreshed: ${error.message}\n`)
    }
  }, 50)
}

const sourceWatcher = watch(
  new URL('../src/', import.meta.url),
  { recursive: true },
  (_event, name) => {
    if (name !== 'ToolchainIntegrity.generated.ts') refresh()
  },
)

// A recursive watcher never sees a deleted and recreated root, and `pnpm clean` removes llvm
// `dist` on every llvm build. Watch the llvm package root for `dist` itself and re-arm the
// recursive `dist` watcher whenever it reappears.
const llvmRoot = new URL('../../llvm/', import.meta.url)
let distWatcher
const watchDist = () => {
  distWatcher?.close()
  distWatcher = undefined
  try {
    const watcher = watch(new URL('dist/', llvmRoot), { recursive: true }, (_event, name) => {
      if (!name || name.endsWith('.js')) refresh()
    })
    watcher.on('error', () => watcher.close())
    distWatcher = watcher
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
watchDist()
const llvmWatcher = watch(llvmRoot, (_event, name) => {
  if (name !== 'dist') return
  watchDist()
  refresh()
})

const closeWatchers = () => {
  clearTimeout(pending)
  sourceWatcher.close()
  llvmWatcher.close()
  distWatcher?.close()
}
const compiler = spawn('tsc', ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], {
  cwd: packageRoot,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closeWatchers()
    compiler.kill(signal)
  })
}
process.on('exit', () => compiler.kill())
compiler.on('error', (error) => {
  closeWatchers()
  process.stderr.write(`${error}\n`)
  process.exitCode = 1
})
compiler.on('exit', (code, signal) => {
  closeWatchers()
  if (signal !== null) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  } else process.exitCode = code ?? 1
})
