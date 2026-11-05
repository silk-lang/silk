// `silk --help` is printed by the silk tool, which lists the compiler's commands from its own table
// (`compilerCommands` in tool/src/Command.silk). The compiler's overview (`usage` in
// compiler/src/main.silk) is the source of truth: every command and summary it lists must be in the
// tool's table, in the same order, so a new compiler command cannot go missing from `silk --help`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const repository = new URL('../../', import.meta.url)
const source = (path) => readFileSync(new URL(path, repository), 'utf8')

// The `name  summary` lines of the compiler's "Project commands:" and "Tools:" sections.
function compilerOverview(main) {
  const literal = /^fn usage\(\) -> &'static \[u8\] \{\n  return b"((?:[^"\\]|\\.)*)"/m.exec(main)
  assert.ok(literal, 'compiler/src/main.silk has no usage() literal')
  const text = literal[1].replaceAll('\\n', '\n')
  const commands = []
  for (const section of text.split('\n\n')) {
    const [heading, ...lines] = section.split('\n')
    if (heading !== 'Project commands:' && heading !== 'Tools:') continue
    for (const line of lines) {
      const [, name, summary] = /^ {2}(\S+) +(.+)$/.exec(line)
      commands.push({ name, summary })
    }
  }
  return commands
}

// The entries of the tool's `compilerCommands` table.
function toolTable(command) {
  const table = /^pub fn compilerCommands\(\) -> \[CompilerCommand; (\d+)\] \{\n  return \[\n([\s\S]*?)\n  \]/m.exec(command)
  assert.ok(table, 'tool/src/Command.silk has no compilerCommands table')
  const entries = [...table[2].matchAll(/CompilerCommand \{ name: b"([^"]*)", summary: b"((?:[^"\\]|\\.)*)" \}/g)]
  assert.equal(entries.length, Number(table[1]))
  return entries.map(([, name, summary]) => ({ name, summary: summary.replaceAll("\\'", "'") }))
}

test('silk --help lists every compiler command with the compiler summary', () => {
  const compiler = compilerOverview(source('compiler/src/main.silk'))
  assert.ok(compiler.some(({ name }) => name === 'debug') && compiler.some(({ name }) => name === 'generate'))
  assert.deepEqual(toolTable(source('tool/src/Command.silk')), compiler)
})
