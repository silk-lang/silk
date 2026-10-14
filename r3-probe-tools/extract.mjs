import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { nativeCorpus } from '/home/user/silk/packages/compiler/test/support/corpus.ts'
const [out, ...names] = process.argv.slice(2)
for (const name of names) {
  const program = nativeCorpus.find((p) => p.name === name)
  if (!program) { console.error('missing', name); continue }
  const dir = join(out, name)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory/driver.silk'), program.nativeSource ?? program.source)
  writeFileSync(join(dir, 'silk.toml'), '[package]\nname = "corpus"\nroot = "main.silk"\n')
  for (const [module, contents] of Object.entries(program.nativeImports ?? {})) {
    const path = join(dir, `${module}.silk`); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents)
  }
  if (program.nativeLinkInputs || program.composition) console.error('note: link inputs/composition ignored for', name)
}
