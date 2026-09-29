import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { integerOperationMatrix } from '../../packages/compiler/test/support/scalarOperationMatrix.js'

const silkc = process.env.SILKC
if (silkc === undefined) throw new Error('SILKC required')
const directory = mkdtempSync(join(tmpdir(), 'silk-b4-probe-'))
try {
  const definitions = integerOperationMatrix.slice(0, integerOperationMatrix.indexOf('pub fn main'))
  const calls = integerOperationMatrix
    .slice(integerOperationMatrix.indexOf('pub fn main'))
    .split('\n')
    .filter((line) => line.includes('let checked'))
  process.stdout.write(
    `[DEBUG-b4] matrix bytes=${integerOperationMatrix.length} calls=${calls.length}\n`,
  )
  for (const count of [0, 1, 10, 100, calls.length]) {
    writeFileSync(
      join(directory, 'main.silk'),
      `${definitions}
pub fn main() -> i32 {
${calls.slice(0, count).join('\n')}
return 42
}`,
    )
    for (const mode of count === calls.length ? ['hir', 'build'] : ['build']) {
      const start = performance.now()
      const result = spawnSync(
        silkc,
        mode === 'build' ? ['build', 'main.silk', '-o', 'program'] : ['hir', 'main.silk'],
        { cwd: directory, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      )
      process.stdout.write(
        `[DEBUG-b4] mode=${mode} calls=${count} elapsed=${performance.now() - start} exit=${result.status} signal=${result.signal} error=${result.error?.message ?? ''} stderr=${result.stderr}\n`,
      )
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
