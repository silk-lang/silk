// Reproduce the standard library's raw Preview 2 imports from its pinned WIT package.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const tool = process.env.SILK_WASM_TOOLS || 'wasm-tools'
const wat = execFileSync(
  tool,
  [
    'component',
    'embed',
    `${root}stdlib/wit`,
    '--world',
    'command',
    '--dummy-names',
    'legacy',
    '-t',
  ],
  { encoding: 'utf8' },
)
const identifier = (text) =>
  text
    .replace(/\[method\]|\[static\]/g, '')
    .replace('[resource-drop]', 'drop_')
    .replace('[constructor]', 'new_')
    .replace(/[^a-zA-Z0-9_]/g, '_')
let output = `//! Raw imports for the WASI Preview 2 canonical ABI.
//!
//! # When to use
//! Use these unsafe calls when implementing WASI providers. Applications use the portable services
//! or the resource owners in the WASI provider modules.
//!
//! # Details
//! Generated from the pinned interfaces in \`stdlib/wit\`. Integer pointer arguments are wasm32
//! linear-memory addresses. Indirect results use the canonical ABI layout of the WIT result type.
//! Resource handles belong to the component instance and must be dropped or transferred once.
//!
//! @category Native platform

static if Intrinsic.profileText("target") == "wasm32-wasip2" {
`
let count = 0
for (const match of wat.matchAll(/^  \(import "([^"]+)" "([^"]+)" \(func .*$/gm)) {
  const [, module, member] = match
  const name = identifier(`${module.replace(/^wasi:/, '').replace(/@.*/, '')}_${member}`)
  const params = match[0].match(/\(param ([^)]+)\)/)?.[1].split(' ') || []
  const result = match[0].match(/\(result ([^)]+)\)/)?.[1] || '()'
  const lane = (type) => ({ i32: 'u32', i64: 'u64' })[type] || type
  output += `  /// Calls \`${module}#${member}\` with its canonical ABI.\n`
  output += `  /// The caller supplies valid handles and memory, and honors the WIT ownership contract.\n`
  output += `  pub unsafe extern "C" fn ${name}(${params.map((type, i) => `p${i}: ${lane(type)}`).join(', ')}) -> ${lane(result)}\n`
  output += `    as "${module}#${member}"\n\n`
  count++
}
if (count < 190) throw new Error(`WIT world unexpectedly contains only ${count} imports`)
output += '}\n'
const destination = `${root}stdlib/silk/platform/wasi/preview2.silk`
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== output) throw new Error('wasi_preview2.silk is stale')
} else writeFileSync(destination, output)
console.log(`${count} WASI Preview 2 imports`)
