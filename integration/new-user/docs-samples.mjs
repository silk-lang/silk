// Collects every complete program in the silk-lang/docs pages (a ```silk block with a `main`),
// builds and runs each one in its own package the way a reader would after pasting it into
// `src/main.silk`, and compares the output with the block the page shows after `silk run`.
//
//   node integration/new-user/docs-samples.mjs <docs checkout> [--filter <text>] [--run-all] [--release] [--json <file>]
//
// --run-all also runs the programs whose output the page does not show, and fails on a crash.
// --release also runs each of those with --release and fails when the result differs from debug.
//
// Exit status 1 when any sample fails to check or prints something other than the page says.
import { spawn } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, relative } from 'node:path'
import { freshHome, install, read, sharedHome, silk, userEnv, write } from './lib.mjs'

// Sections a reader follows. content/std is generated from the stdlib's own doc comments, which
// `silk doctest --stdlib` already covers.
// Programs that need more than the page's labelled files: a C object, a running server, another
// package made with `silk add`, or a library with no `main`. The scenario tests cover these flows.
const contextual = new Map([
  ['reference/26-unsafe-code-and-c-interop.md:323', 'links a C object built by hand'],
  ['projects/08-build-outputs-and-native-linking.md:157', 'links a C object built by hand'],
  ['projects/04-dependencies.md:42', 'needs the text-utils package from `silk add`'],
  ['tools/05-writing-documentation.md:88', 'a library module, shown for its doc comments'],
  ['tools/06-doc-tests-and-reference-generation.md:87', 'a library module, shown for its doc tests'],
  ['guides/09-http-client.md:21', 'talks to a local HTTP server'],
  ['guides/16-testing-with-providers.md:112', 'a test module beside the package'],
])

const sections = ['get-started', 'book', 'reference', 'projects', 'tools', 'guides', 'appendix']

export function fences(markdown) {
  const blocks = []
  const lines = markdown.split('\n')
  let prose = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})(\S*)/.exec(lines[i])
    if (open === null) {
      prose.push(lines[i])
      continue
    }
    const body = []
    let j = i + 1
    while (j < lines.length && !lines[j].startsWith(open[1])) body.push(lines[j++])
    blocks.push({ lang: open[2], text: body.join('\n'), line: i + 1, before: prose.join('\n').trim() })
    prose = []
    i = j
  }
  return blocks
}

// Connecting prose that describes changing the program first.
const edits = /\b(instead|change|replace|add|remove|delete|without|leave)\b/i

const isOutput = (block) => block !== undefined && (block.lang === '' || block.lang === 'text')

// A page shows what a program does in the fences right after it: an optional ```sh command, then
// its output. Only short connecting prose ("`silk check` prints:") may sit between them; longer
// prose usually describes an edit, and the output then belongs to the edited program.
function shownResult(blocks, index) {
  let k = index + 1
  let command = ''
  if (blocks[k]?.lang === 'sh' && blocks[k].before.length <= 160) {
    command = blocks[k].text.trim()
    k++
  }
  const output = blocks[k]
  if (!isOutput(output) || output.before.length > 160 || edits.test(output.before)) return {}
  if (/error\[[A-Z]{3}\d{4}\]/.test(output.text)) {
    const build = /silk build/.test(`${command}\n${output.before}`)
    return { diagnostics: errorLines(output.text), build }
  }
  if (/^silk run\b/m.test(command)) return { expected: { command, text: output.text } }
  // "`silk run` prints, after the build lines:" with no command block.
  if (command === '' && /`silk run`/.test(output.before)) return { expected: { command: 'silk run', text: output.text } }
  return {}
}

// The file a block is labelled as by the paragraph before it, such as "`src/helper.silk`:".
function fileLabel(block) {
  if (block === undefined) return undefined
  return /`((?:\/home\/you\/[\w-]+\/)?(?:src\/|tests\/)?[\w/.-]+\.(?:silk|toml))`:$/.exec(block.before.split(/\n\s*\n/).at(-1) ?? '')?.[1]
}

export function collect(docs, filter = '') {
  const samples = []
  for (const section of sections) {
    const folder = join(docs, 'content', section)
    for (const name of readdirSync(folder).filter((file) => file.endsWith('.md')).sort()) {
      const path = join(folder, name)
      const page = read(path)
      const blocks = fences(page)
      // Every import on the page, for excerpts that leave out the imports of the full program
      // shown earlier.
      const imports = [...new Set(blocks.filter((block) => block.lang === 'silk').flatMap((block) => block.text.match(/^import .*$/gm) ?? []))]
      blocks.forEach((block, index) => {
        if (block.lang !== 'silk' || !/\bfn main\(/.test(block.text)) return
        // A block with an elided line (`...` on its own, or `{ ... }`) or unbalanced braces is an
        // excerpt, not a program.
        const opens = (block.text.match(/\{/g) ?? []).length
        const closes = (block.text.match(/\}/g) ?? []).length
        const excerpt = opens !== closes || /^\s*(\.\.\.|\/\/ \.\.\.)\s*$/m.test(block.text) || /\{ \.\.\. \}/.test(block.text)
        if (opens !== closes) return
        // A page that labels the block "`src/main.silk`:" may follow it with more labelled files
        // ("`src/helper.silk`:", "`silk.toml`:") that make up the same package.
        const files = {}
        let last = index
        if (fileLabel(block) === 'src/main.silk') {
          for (let k = index - 1; fileLabel(blocks[k]) !== undefined && fileLabel(blocks[k]) !== 'src/main.silk'; k--) files[fileLabel(blocks[k])] = blocks[k].text
          while (fileLabel(blocks[last + 1]) !== undefined && fileLabel(blocks[last + 1]) !== 'src/main.silk') files[fileLabel(blocks[++last])] = blocks[last].text
        }
        const { expected, diagnostics, build } = shownResult(blocks, last)
        // A manifest fragment right before or after the program configures its package.
        const manifest = [blocks[index - 1], blocks[index + 1]].find((near) => near?.lang === 'toml' && /^\[build/m.test(near.text) && !/^\[package\]/m.test(near.text))?.text
        // Prose right before the block that names a code ("OWN0010, conflicting loans:") says the
        // block is rejected with that code.
        const paragraph = block.before.split(/\n\s*\n/).at(-1) ?? ''
        const named = diagnostics === undefined && /:\s*$/.test(paragraph) && paragraph.length < 120 && !/\b(fix|instead)\b/i.test(paragraph) ? /^([A-Z]{3}\d{4})\b/.exec(paragraph)?.[1] : undefined
        const id = `${relative(join(docs, 'content'), path)}:${block.line}`
        if (filter === '' || id.includes(filter)) samples.push({ id, source: block.text, excerpt, expected, diagnostics, build, named, imports, manifest, files })
      })
    }
  }
  return samples
}

let runAll = false
let compareRelease = false

function run(h, args, cwd, timeout = 120_000) {
  return new Promise((done) => {
    const child = spawn('silk', args, { cwd, env: userEnv(h), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      done({ status, signal, stdout, stderr })
    })
  })
}

// The page's output block, without the build's progress rows a page sometimes shows.
function expectedOutput(text) {
  const lines = text.split('\n')
  const finished = lines.findIndex((line) => /^Finished /.test(line))
  return (finished >= 0 ? lines.slice(finished + 1) : lines).join('\n').trimEnd()
}

// Arguments after `silk run` in the page's command, such as `-- Ada`.
function runArguments(command) {
  const line = command.split('\n').find((text) => text.startsWith('silk run'))
  return line.slice('silk run'.length).split(';')[0].trim().split(/\s+/).filter((word) => word !== '')
}

// `path:line:column: error[CODE] message` lines with the path cut down to the file name, so a
// page's `/home/you/demo/src/main.silk` matches whatever the compiler prints.
export function errorLines(text) {
  return text
    .split('\n')
    .map((line) => /^(?:.*\/)?([\w.-]+\.silk:\d+:\d+: error\[[A-Z]{3}\d{4}\].*)$/.exec(line.trim())?.[1])
    .filter((line) => line !== undefined)
}

async function check(h, sample, index) {
  if (contextual.has(sample.id)) return { ...sample, outcome: 'needs-context', detail: contextual.get(sample.id) }
  const result = await checkSample(h, sample, index)
  // Pages should show code as `silk format` writes it. Only programs that check are formatted.
  if (['checked', 'ran', 'output-matches'].includes(result.outcome)) {
    const formatted = await run(h, ['format', '--check'], join(h.work, `sample${index}`, 'demo'))
    result.formatted = formatted.status === 0
  }
  return result
}

async function checkSample(h, sample, index) {
  const name = 'demo'
  const folder = join(h.work, `sample${index}`, name)
  write(join(folder, 'silk.toml'), `[package]\nname = "${name}"\nversion = "0.1.0"\n${sample.manifest === undefined ? '' : `\n${sample.manifest}\n`}`)
  write(join(folder, 'src/main.silk'), `${sample.source}\n`)
  for (const [label, text] of Object.entries(sample.files)) {
    // `/home/you/<package>/...` is a package beside the sample's own `demo` folder.
    const path = join(folder, label.replace(/^\/home\/you\//, '../'))
    // Pages pin `silk-version = "0.1.0"`; pin the installed toolchain instead.
    const pinned = text.replace(/^silk-version = .*$/m, '')
    if (label === 'silk.toml' && !/^\[package\]/m.test(text)) write(path, `${read(path)}\n${pinned}\n`)
    else write(path, `${pinned}\n`)
  }
  let checked = await run(h, ['check', '--quiet'], folder)
  if (checked.status !== 0 && sample.diagnostics === undefined && sample.named === undefined && /^import /m.test(sample.source) === false && unknownOnly(checked.stderr)) {
    // An excerpt that relies on the page's imports: retry with them.
    write(join(folder, 'src/main.silk'), `${sample.imports.join('\n')}\n\n${sample.source}\n`)
    checked = await run(h, ['check', '--quiet'], folder)
    if (checked.status !== 0 && unknownOnly(checked.stderr)) return { ...sample, outcome: 'needs-context', detail: checked.stderr }
  }
  if (sample.named !== undefined) {
    const codes = errorLines(checked.stderr).map(code)
    if (codes.includes(sample.named)) return { ...sample, outcome: 'errors-match' }
    return { ...sample, outcome: 'errors-differ', detail: `the page names ${sample.named}\nactual (exit ${checked.status}):\n${checked.stderr.trimEnd()}` }
  }
  if (sample.diagnostics !== undefined && sample.build && checked.status === 0) checked = await run(h, ['build', '--quiet'], folder)
  if (sample.diagnostics !== undefined) {
    // The page shows this program failing; the compiler must report the same errors.
    const actual = errorLines(`${checked.stdout}\n${checked.stderr}`)
    if (checked.status !== 0 && actual.join('\n') === sample.diagnostics.join('\n')) return { ...sample, outcome: 'errors-match' }
    if (checked.status !== 0 && actual.map(code).join() === sample.diagnostics.map(code).join()) {
      return { ...sample, outcome: 'errors-differ', detail: `same codes, different text or position\nexpected:\n${sample.diagnostics.join('\n')}\nactual (exit ${checked.status}):\n${actual.join('\n')}` }
    }
    return { ...sample, outcome: 'errors-differ', detail: `expected:\n${sample.diagnostics.join('\n')}\nactual (exit ${checked.status}):\n${checked.stderr.trimEnd()}` }
  }
  if (checked.status !== 0) return { ...sample, outcome: 'check-failed', detail: checked.stderr }
  if (sample.expected === undefined) {
    if (!runAll) return { ...sample, outcome: 'checked' }
    // With --run-all, a program the page shows no output for still must not crash.
    const ran = await run(h, ['run', '--quiet'], folder, 20_000)
    if (ran.signal !== null || /fatal trap|unhandled error|Segmentation/.test(ran.stderr)) {
      return { ...sample, outcome: 'crashed', detail: `exit ${ran.status}${ran.signal ? `, ${ran.signal}` : ''}\n${ran.stdout}${ran.stderr}`.trimEnd() }
    }
    if (compareRelease) {
      const release = await run(h, ['run', '--quiet', '--release'], folder, 60_000)
      const strip = (text) => text.split('\n').filter((line) => !/^Finished /.test(line)).join('\n')
      if (release.status !== ran.status || release.signal !== ran.signal || release.stdout !== ran.stdout || strip(release.stderr) !== strip(ran.stderr)) {
        return { ...sample, outcome: 'release-differs', detail: `debug: exit ${ran.status}${ran.signal ? `, ${ran.signal}` : ''}\n${ran.stdout}${strip(ran.stderr)}\nrelease: exit ${release.status}${release.signal ? `, ${release.signal}` : ''}\n${release.stdout}${strip(release.stderr)}`.trimEnd() }
      }
    }
    return { ...sample, outcome: 'ran', status: ran.status }
  }
  const ran = await run(h, ['run', '--quiet', ...runArguments(sample.expected.command)], folder)
  const stderr = ran.stderr.split('\n').filter((line) => !/^Finished /.test(line)).join('\n')
  let actual = `${ran.stdout}${stderr}`.trimEnd()
  if (/\becho "?(exit )?\$\?"?$/m.test(sample.expected.command)) {
    // The shell prints 128 + N for a program killed by signal N.
    const status = ran.status ?? 128 + ({ SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGSEGV: 11 }[ran.signal] ?? 0)
    const prefix = /exit \$\?/.test(sample.expected.command) ? 'exit ' : ''
    actual = `${actual}${actual === '' ? '' : '\n'}${prefix}${status}`
  }
  const want = expectedOutput(sample.expected.text)
  if (actual === want) return { ...sample, outcome: 'output-matches' }
  return { ...sample, outcome: 'output-differs', detail: `expected:\n${want}\nactual (exit ${ran.status}${ran.signal ? `, ${ran.signal}` : ''}):\n${actual}` }
}

// True when every error is an unknown name, type or module: the excerpt leans on declarations
// elsewhere on the page.
function unknownOnly(stderr) {
  const lines = errorLines(stderr)
  return lines.length > 0 && lines.every((line) => /error\[(SEM0001|SEM0004|SEM0006|SEM0009|MOD0001)\]/.test(line))
}

const code = (line) => /error\[(\w+)\]/.exec(line)[1]

export const failing = (result) => ['check-failed', 'output-differs', 'errors-differ', 'crashed', 'release-differs'].includes(result.outcome)

export async function checkAll(docs, { filter = '', jobs = Math.max(1, cpus().length - 1), all = false, release = false } = {}) {
  runAll = all || release
  compareRelease = release
  const h = sharedHome()
  const samples = collect(docs, filter)
  const results = new Array(samples.length)
  let next = 0
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < samples.length) {
        const index = next++
        results[index] = await check(h, samples[index], index)
      }
    }),
  )
  return results
}

// Guides whose code blocks, in order, make up one whole program. A reader who pastes every block
// into src/main.silk must get a program that builds, in debug and release, and prints what the
// guide's `silk run` shows.
export const wholeGuides = [
  'guides/01-text-and-formatting.md',
  'guides/05-child-processes.md',
  'guides/12-cryptography.md',
  'guides/13-json-and-toml.md',
  'guides/14-encodings-and-compression.md',
  'guides/15-no-libc-linux-and-webassembly.md',
]

// The program a guide assembles to: every top-level block (indented ones are excerpts of a body),
// imports first and each import once.
export function guideProgram(page) {
  const blocks = fences(page).filter((block) => block.lang === 'silk' && !/^\s/.test(block.text))
  const imports = [...new Set(blocks.flatMap((block) => block.text.match(/^import .*$/gm) ?? []))]
  const rest = blocks.map((block) => block.text.replace(/^import .*\n?/gm, '').trim()).filter((text) => text !== '')
  return `${imports.join('\n')}\n\n${rest.join('\n\n')}\n`
}

// The output the guide shows for `silk run`: the last plain block right after an sh block that runs it.
export function guideOutput(page) {
  const blocks = fences(page)
  let shown
  blocks.forEach((block, index) => {
    if (block.lang === 'sh' && /^silk run\b/m.test(block.text) && isOutput(blocks[index + 1])) shown = expectedOutput(blocks[index + 1].text)
  })
  return shown
}

export async function checkGuide(docs, id) {
  const h = sharedHome()
  const page = read(join(docs, 'content', id))
  const folder = join(h.work, `guide-${id.replace(/\W+/g, '-')}`)
  write(join(folder, 'silk.toml'), '[package]\nname = "guide"\nversion = "0.1.0"\n')
  write(join(folder, 'src/main.silk'), guideProgram(page))
  const debug = await run(h, ['run', '--quiet'], folder)
  const release = await run(h, ['run', '--quiet', '--release'], folder)
  return { shown: guideOutput(page), debug, release }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [docs, ...rest] = process.argv.slice(2)
  if (docs === undefined) {
    console.error('usage: docs-samples.mjs <docs checkout> [--filter <text>] [--run-all] [--release] [--json <file>]')
    process.exit(2)
  }
  const option = (flag) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined)
  const results = await checkAll(docs, { filter: option('--filter') ?? '', all: rest.includes('--run-all'), release: rest.includes('--release') })
  const failed = results.filter(failing)
  for (const result of results) {
    const mark = failing(result) ? 'FAIL' : 'ok  '
    console.log(`${mark} ${result.outcome.padEnd(15)} ${result.excerpt ? '(excerpt) ' : ''}${result.id}`)
  }
  for (const result of failed) console.log(`\n=== ${result.id} ${result.outcome}${result.excerpt ? ' (excerpt)' : ''}\n${result.detail.trimEnd()}`)
  const unformatted = results.filter((result) => result.formatted === false)
  if (unformatted.length > 0) console.log(`\nNot in \`silk format\` style:\n${unformatted.map((result) => `  ${result.id}`).join('\n')}`)
  console.log(`\n${results.length} samples, ${failed.length} failed, ${unformatted.length} of ${results.filter((result) => result.formatted !== undefined).length} runnable programs not formatted`)
  if (option('--json') !== undefined) writeFileSync(option('--json'), JSON.stringify(results, null, 2))
  process.exit(failed.length === 0 ? 0 : 1)
}

export { freshHome, install }
