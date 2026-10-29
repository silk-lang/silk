import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

// Regenerates the packed tables in stdlib/silk/text/unicode_tables.silk from the Unicode
// Character Database. Run: node compiler/scripts/UnicodeTables.mjs <directory with the UCD files>
// The files are the ones published at https://www.unicode.org/Public/17.0.0/ucd/.

export class UnicodeTablesError extends Data.TaggedError('UnicodeTablesError') {}

export const version = '17.0.0'

export const pinnedFiles = {
  'UnicodeData.txt': '2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c',
  'DerivedNormalizationProps.txt':
    '71fd6a206a2c0cdd41feb6b7f656aa31091db45e9cedc926985d718397f9e488',
}

const tablePath = 'stdlib/silk/text/unicode_tables.silk'

const bytes = (value, width) =>
  Array.from({ length: width }, (_, index) => (value >> (8 * (width - 1 - index))) & 255)

const literal = (values) =>
  `b"${values.map((value) => `\\x${value.toString(16).padStart(2, '0')}`).join('')}"`

// Hangul syllables are algorithmic and the ranges in UnicodeData.txt carry no per-scalar data, so
// both are left out.
const parseUnicodeData = (text) => {
  const classes = new Map()
  const decompositions = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const fields = line.split(';')
    if (fields[1].endsWith(', First>') || fields[1].endsWith(', Last>')) continue
    const scalar = Number.parseInt(fields[0], 16)
    const combiningClass = Number(fields[3])
    if (combiningClass !== 0) classes.set(scalar, combiningClass)
    if (fields[5] !== '' && !fields[5].startsWith('<')) {
      decompositions.set(
        scalar,
        fields[5].split(' ').map((part) => Number.parseInt(part, 16)),
      )
    }
  }
  return { classes, decompositions }
}

const parseCompositionExclusions = (text) => {
  const excluded = new Set()
  for (const line of text.split('\n')) {
    const [range, property] = line
      .split('#')[0]
      .split(';')
      .map((part) => part.trim())
    if (property !== 'Full_Composition_Exclusion') continue
    const [first, last = first] = range.split('..').map((part) => Number.parseInt(part, 16))
    for (let scalar = first; scalar <= last; scalar += 1) excluded.add(scalar)
  }
  return excluded
}

/** Builds the four tables in the layout that unicode_tables.silk reads. */
export const tables = ({ unicodeData, normalizationProps }) => {
  const { classes, decompositions } = parseUnicodeData(unicodeData)
  const excluded = parseCompositionExclusions(normalizationProps)
  // Runs of consecutive scalars with one class: start (3 bytes), length - 1, class.
  const runs = []
  for (const scalar of [...classes.keys()].sort((left, right) => left - right)) {
    const last = runs.at(-1)
    const combiningClass = classes.get(scalar)
    if (
      last &&
      last.start + last.length === scalar &&
      last.combiningClass === combiningClass &&
      last.length < 256
    ) {
      last.length += 1
    } else {
      runs.push({ start: scalar, length: 1, combiningClass })
    }
  }
  const sorted = [...decompositions.entries()].sort(([left], [right]) => left - right)
  const singletons = sorted.filter(([, parts]) => parts.length === 1)
  const pairs = sorted.filter(([, parts]) => parts.length === 2)
  // Composition looks pairs up by (first, second) through indices into the pair table.
  const composition = pairs
    .map(([scalar, parts], index) => ({ scalar, parts, index }))
    .filter(({ scalar }) => !excluded.has(scalar))
    .sort((left, right) => left.parts[0] - right.parts[0] || left.parts[1] - right.parts[1])
  return {
    combiningClass: {
      count: runs.length,
      data: runs.flatMap((run) => [...bytes(run.start, 3), run.length - 1, run.combiningClass]),
    },
    singletons: {
      count: singletons.length,
      data: singletons.flatMap(([scalar, [target]]) => [...bytes(scalar, 3), ...bytes(target, 3)]),
    },
    composition: {
      count: composition.length,
      data: composition.flatMap(({ index }) => bytes(index, 2)),
    },
    pairs: {
      count: pairs.length,
      data: pairs.flatMap(([scalar, [first, second]]) => [
        ...bytes(scalar, 3),
        ...bytes(first, 3),
        ...bytes(second, 3),
      ]),
    },
  }
}

const replaceOnce = (source, pattern, replacement, issues, what) => {
  let count = 0
  const result = source.replace(pattern, (...match) => {
    count += 1
    return typeof replacement === 'function' ? replacement(...match) : replacement
  })
  if (count !== 1) issues.push(`expected one ${what}, found ${count}`)
  return result
}

/** Rewrites the table literals and their record counts in the module source. */
export const rewrite = (source, generated) => {
  const issues = []
  let result = source
  // The first three tables are each followed by the binary search bound over their records.
  for (const [name, binding] of [
    ['combiningClass', 'data'],
    ['singletons', 'singletons'],
    ['composition', 'index'],
  ]) {
    const table = generated[name]
    result = replaceOnce(
      result,
      new RegExp(`let ${binding} = b"[^"]*"(\\n(?:(?!b")[\\s\\S])*?usize\\.add\\(0, )\\d+\\)`),
      (_, between) => `let ${binding} = ${literal(table.data)}${between}${table.count})`,
      issues,
      `${name} table`,
    )
  }
  const pairs = generated.pairs
  result = replaceOnce(
    result,
    /(fn pairRecord\(index: usize\) -> PairRecord \{\n {2}let data = )b"[^"]*"/,
    (_, head) => `${head}${literal(pairs.data)}`,
    issues,
    'pair table',
  )
  result = replaceOnce(
    result,
    /(fn pairIndexOf\(scalar: u32\) -> usize \{\n {2}let mut low = usize\.ZERO\n {2}let mut high = usize\.add\(0, )\d+\)([\s\S]*?\n {2}return )\d+\n/,
    (_, head, middle) => `${head}${pairs.count})${middle}${pairs.count}\n`,
    issues,
    'pair search bound',
  )
  result = replaceOnce(
    result,
    /if found == \d+ \{/,
    `if found == ${pairs.count} {`,
    issues,
    'pair absence check',
  )
  return { source: result, issues }
}

export const generate = Effect.fn('UnicodeTables.generate')(
  function* (/** @type {string | undefined} */ directory) {
    if (directory === undefined) {
      return yield* new UnicodeTablesError({
        issues: ['Usage: node compiler/scripts/UnicodeTables.mjs <Unicode database directory>'],
      })
    }
    const fs = yield* FileSystem.FileSystem
    const files = {}
    for (const [name, digest] of Object.entries(pinnedFiles)) {
      const contents = yield* fs.readFile(`${directory}/${name}`)
      const actual = createHash('sha256').update(contents).digest('hex')
      if (actual !== digest) {
        return yield* new UnicodeTablesError({
          issues: [`${name} has SHA-256 ${actual}, expected Unicode ${version} ${digest}`],
        })
      }
      files[name] = new TextDecoder().decode(contents)
    }
    const generated = tables({
      unicodeData: files['UnicodeData.txt'],
      normalizationProps: files['DerivedNormalizationProps.txt'],
    })
    const { source, issues } = rewrite(yield* fs.readFileString(tablePath), generated)
    if (issues.length > 0) return yield* new UnicodeTablesError({ issues })
    yield* fs.writeFileString(tablePath, source)
    return yield* Console.log(`Wrote ${tablePath} from Unicode ${version}`)
  },
)

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const require = createRequire(new URL('../../package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  await Effect.runPromise(generate(process.argv[2]).pipe(Effect.provide(NodeServices.layer)))
}
