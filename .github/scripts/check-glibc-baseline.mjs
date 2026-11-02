// Checks that every C symbol the standard library and the compiler bind on GNU/Linux is one the
// compiler's glibc 2.28 link stubs define (compiler/src/driver/LinuxLink.silk). The stubs list only
// symbols glibc 2.28 exports, so a binding outside them needs a fallback for older glibc, as
// `fstat` (2.33) has in silk/platform/native/filesystem.silk.
//
// usage: node .github/scripts/check-glibc-baseline.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const stubs = readFileSync('compiler/src/driver/LinuxLink.silk', 'utf8')
const start = stubs.indexOf('pub fn symbols()')
const table = stubs.slice(stubs.indexOf('"""', start) + 3, stubs.indexOf('"""', stubs.indexOf('"""', start) + 3))
const defined = new Set()
for (const line of table.split('\n')) {
  const colon = line.indexOf(':')
  if (colon < 0) continue
  for (const symbol of line.slice(colon + 1).trim().split(/\s+/)) defined.add(symbol.split('=')[0])
}

// Modules that never build for GNU/Linux.
const otherPlatforms = /(^|\/)(platform\/(wasi|wasm|windows)\/|[a-z_]+_(wasi|windows)\.silk$)/
// Bindings that sit in a branch for another platform, or name a symbol a Silk build defines itself.
const otherBranches = new Set([
  // Darwin
  '__error', '_NSGetEnviron', '__stderrp', '__ulock_wait', '__ulock_wake', 'arc4random_buf',
  'close$NOCANCEL', 'sysctlbyname', 'fstat', 'fstatat', 'posix_spawn_file_actions_addchdir_np',
  // Windows
  'closesocket', 'ioctlsocket', '__silk_stderr_lock', '__silk_stderr_once',
  // The Tracy profiler, which a profiling build links as a declared input.
  'silk_tracy_zone_begin', 'silk_tracy_zone_end', 'silk_tracy_zone_text',
])

const missing = []
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (path.endsWith('.silk') && !path.endsWith('Cases.silk')) scan(path)
  }
}
const scan = (path) => {
  const name = relative('.', path)
  if (otherPlatforms.test(name)) return
  const text = readFileSync(path, 'utf8')
  const declaration = /extern "C" (fn|static) (\w+)/g
  for (let match = declaration.exec(text); match; match = declaration.exec(text)) {
    // A declaration ends at the first line break outside its parameter list.
    let depth = 0
    let end = match.index + match[0].length
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++
      else if (text[end] === ')') depth--
      else if (text[end] === '\n' && depth === 0) break
    }
    const renamed = /\bas "([^"]+)"\s*$/.exec(text.slice(match.index, end))
    const symbol = renamed ? renamed[1] : match[2]
    // Windows API names start with a capital letter; the wasm32 runtime's imports with `silk_wasm_`;
    // only Darwin's variant names, such as `fstat$INODE64`, carry a `$`.
    if (/^[A-Z]/.test(symbol) || symbol.startsWith('silk_wasm_') || symbol.includes('$') || otherBranches.has(symbol) || defined.has(symbol)) continue
    missing.push(`${name}: ${symbol}`)
  }
}
walk('stdlib')
walk('compiler/src')
if (missing.length > 0) {
  console.error('These C bindings are not in the glibc 2.28 link stubs of compiler/src/driver/LinuxLink.silk.')
  console.error('Bind a glibc 2.28 symbol instead, or add a fallback for older glibc:')
  for (const line of missing) console.error(`  ${line}`)
  process.exit(1)
}
console.log(`All GNU/Linux C bindings are among the ${defined.size} glibc 2.28 stub symbols.`)
