#!/usr/bin/env node
// Checks that every type node is built through the `Types` table
// (compiler/src/semantic/Types.silk): no `Shared<Type>.make(` remains outside Types.silk. Prints
// each offending module with its count and exits nonzero if any remain.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const typesModule = 'semantic/Types.silk'

const sources = (directory) =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.silk') ? [path] : []
  })

let constructions = 0
for (const path of sources(src)) {
  if (relative(src, path) === typesModule) continue
  const count = (readFileSync(path, 'utf8').match(/Shared<Type>\.make\(/g) ?? []).length
  if (count === 0) continue
  constructions += count
  process.stderr.write(`${relative(src, path)}: ${count} Shared<Type>.make( sites\n`)
}
process.exitCode = constructions > 0 ? 1 : 0
