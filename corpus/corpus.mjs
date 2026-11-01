// Reads the shared acceptance corpus: one directory per program under `native/` or `invalid/`.
//
// This module depends only on Node built-ins, so a harness can run the corpus without the
// TypeScript compiler. The layout and the outcome schema are documented in README.md.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The corpus directory, next to this module. */
export const corpusRoot = fileURLToPath(new URL('.', import.meta.url))

/** The repository root that splice paths are relative to. */
export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

/** The program kinds, each a subdirectory of the corpus root. */
export const kinds = ['native', 'invalid']

const splicePattern = /\/\*@splice (\{.*?\})\*\//g

const sliceOf = (text, splice, origin) => {
  if (splice.from !== undefined) {
    const start = text.indexOf(splice.from)
    const end = start < 0 ? -1 : text.indexOf(splice.to, start)
    if (start < 0 || end < 0)
      throw new Error(`${origin}: no section from ${splice.from} to ${splice.to} in ${splice.file}`)
    return text.slice(start, end)
  }
  if (splice.declaration !== undefined) {
    const start = text.indexOf(splice.declaration)
    const end = start < 0 ? -1 : text.indexOf('\n}\n', start)
    if (start < 0 || end < 0)
      throw new Error(`${origin}: no declaration ${splice.declaration} in ${splice.file}`)
    return text.slice(start, end + 2)
  }
  return text
}

/**
 * Replaces every `/*@splice {...}*\/` directive with the text it names: a whole repository file
 * (`file`), the section of it from `from` up to `to`, or one top-level declaration from its
 * `declaration` header through its closing brace line. Splices let a program test the current
 * text of a file it shares, such as a standard-library module, without keeping a copy.
 */
export const expandSplices = (text, origin = 'corpus') =>
  text.replace(splicePattern, (_directive, json) => {
    const splice = JSON.parse(json)
    if (typeof splice.file !== 'string') throw new Error(`${origin}: a splice needs a file`)
    const content = readFileSync(join(repositoryRoot, splice.file), 'utf8')
    return sliceOf(content, splice, origin)
  })

const readSource = (path, origin) => expandSplices(readFileSync(path, 'utf8'), origin)

const filesUnder = (directory, extension) => {
  if (!existsSync(directory)) return []
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith(extension)) found.push(path)
    }
  }
  walk(directory)
  return found
}

/** The sorted program names of one kind. */
export const programNames = (kind) =>
  readdirSync(join(corpusRoot, kind))
    .filter((entry) => statSync(join(corpusRoot, kind, entry)).isDirectory())
    .sort()

/**
 * Loads one program from its own directory: the expanded `main.silk`, an optional
 * `reference.silk`, the `imports/` modules and `c/` translation units by name, the expected
 * output files when present, and `outcome.json`.
 */
export const loadProgram = (kind, name) => {
  const directory = join(corpusRoot, kind, name)
  const origin = `${kind}/${name}`
  const outcome = JSON.parse(readFileSync(join(directory, 'outcome.json'), 'utf8'))
  if (outcome.schemaVersion !== 1)
    throw new Error(`${origin}: unsupported outcome schema ${outcome.schemaVersion}`)
  const optional = (file) => {
    const path = join(directory, file)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  }
  const importsDirectory = join(directory, 'imports')
  const imports = Object.fromEntries(
    filesUnder(importsDirectory, '.silk').map((path) => [
      relative(importsDirectory, path).slice(0, -'.silk'.length).split(sep).join('/'),
      readSource(path, origin),
    ]),
  )
  const cDirectory = join(directory, 'c')
  const cSources = Object.fromEntries(
    filesUnder(cDirectory, '.c').map((path) => [
      relative(cDirectory, path).slice(0, -'.c'.length).split(sep).join('/'),
      readSource(path, origin),
    ]),
  )
  const windowsDirectory = join(directory, 'windows-imports')
  const windowsImports = Object.fromEntries(
    filesUnder(windowsDirectory, '.def').map((path) => [
      relative(windowsDirectory, path).slice(0, -'.def'.length).split(sep).join('/'),
      readFileSync(path, 'utf8'),
    ]),
  )
  const reference = optional('reference.silk')
  return {
    name,
    source: readSource(join(directory, 'main.silk'), origin),
    reference: reference === undefined ? undefined : expandSplices(reference, origin),
    imports,
    cSources,
    windowsImports,
    stdout: optional('expected.stdout'),
    stderr: optional('expected.stderr'),
    outcome,
  }
}

/** Loads every program of one kind in name order. */
export const loadPrograms = (kind) => programNames(kind).map((name) => loadProgram(kind, name))

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    )
  return value
}

const position = (text, offset) => {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return `${line}:${offset - before.lastIndexOf('\n')}`
}

/**
 * The `line:column-line:column` form of the span from `start` to `end` in `text`, both 1-based and
 * counting characters, as rejected programs record their expected diagnostics.
 */
export const formatSpan = (text, start, end) => `${position(text, start)}-${position(text, end)}`

/** The canonical `outcome.json` text: sorted keys, two-space indentation, one trailing newline. */
export const formatOutcome = (outcome) => `${JSON.stringify(sortKeys(outcome), null, 2)}\n`
