import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Json from '../src/Json.js'
import * as Model from '../src/Model.js'
import * as Search from '../src/Search.js'
import * as Site from '../src/Site.js'
// The real standard-library-to-site integration lives in Project.test.ts. This compact DTO exercises
// writer contracts without repeating whole-toolchain semantic analysis in another worker.
const fixtureModules = ['silk/option', 'project/empty']
const encoded = Json.encodeValue({
  schema: Model.schemaName,
  experimental: true,
  modules: [
    {
      name: 'silk/option',
      sourceId: 'silk/option',
      items: [
        {
          id: 'silk/option::Option.unwrapOr',
          kind: 'Function',
          name: 'Option.unwrapOr',
          visibility: 'Public',
          signature: { text: 'pub fn unwrapOr<T>(self: Option<T>, fallback: T) -> T' },
          source: { sourceId: 'silk/option', start: 0, end: 1 },
          children: [],
        },
      ],
    },
    { name: 'project/empty', sourceId: 'project/empty', items: [] },
  ],
})

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

const rendererActors = ['Html.ts', 'Model.ts', 'Prose.ts', 'Search.ts', 'Site.ts'] as const

/**
 * The merged docgen package uses the compiler while generating and testing documentation, but the
 * renderer remains a one-way JSON boundary. Its actors must not import compiler or workspace code.
 *
 * The snippet bundle is resolved and passed as opaque text by the CLI, so editor support is not a
 * docgen runtime dependency.
 */
it('declares the compiler as its only workspace runtime dependency', () => {
  const manifest = Json.decodeSync(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.isTrue(typeof manifest === 'object' && manifest !== null)
  const dependencies =
    typeof manifest === 'object' && manifest !== null && 'dependencies' in manifest
      ? Object.keys(manifest.dependencies as Record<string, string>)
      : []
  assert.deepStrictEqual(
    dependencies.filter((name) => name.startsWith('@silklang/')),
    ['@silklang/compiler'],
    'docgen owns compiler-backed generation; snippet asset resolution belongs to the CLI',
  )
})

it('imports no compiler or workspace module from renderer actors', () => {
  const offenders = rendererActors
    .map((name) => join(packageRoot, 'src', name))
    .filter((file) => readFileSync(file, 'utf8').includes('@silklang/'))
    .map((file) => file.slice(packageRoot.length))
  assert.deepStrictEqual(offenders, [])
})

it.effect('writes distinct pages and escaped signatures for supplied documentation JSON', () =>
  Effect.gen(function* () {
    // Parsed from text, so the renderer reads what `silk doc` writes rather than what the
    // emitter happens to hold in memory.
    const parsed = yield* Json.decode(encoded)
    const decoded = Model.decode(parsed)
    assert.strictEqual(decoded._tag, 'Decoded')
    if (decoded._tag !== 'Decoded') return

    assert.deepStrictEqual(
      decoded.documentation.modules.map((module) => module.name),
      fixtureModules,
      'every supplied module is rendered',
    )

    const site = Site.render(decoded.documentation, { title: 'Silk standard library' })
    const paths = site.files.map((file) => file.path)
    assert.deepStrictEqual(
      paths.filter((path) => path.endsWith('.html')).length,
      fixtureModules.length + 1,
      'one page per module, plus the index',
    )
    assert.include(paths, 'index.html')
    assert.include(paths, 'style.css')
    assert.include(paths, 'search-index.js')
    assert.deepStrictEqual(
      paths.filter((path, index) => paths.indexOf(path) !== index),
      [],
      'every rendered file must have a distinct path',
    )

    const index = site.files.find((file) => file.path === 'index.html')
    for (const module of fixtureModules)
      assert.include(index?.contents ?? '', module, `${module} is missing from the index page`)

    const option = site.files.find((file) => file.path === 'silk-option.html')
    assert.isDefined(option)
    assert.include(option.contents, 'unwrapOr')
    assert.include(
      option.contents,
      'pub fn unwrapOr&lt;T&gt;(self: Option&lt;T&gt;, fallback: T) -&gt; T',
      'a signature must be escaped, not emitted as markup',
    )
    assert.notInclude(
      option.contents,
      '<T>',
      'no documentation value may reach the page as an element',
    )
  }),
)

it('ships the snippet element script and references it relatively when supplied', () => {
  const decoded = Model.decode({
    schema: Model.schemaName,
    experimental: true,
    modules: [{ name: 'project/main', sourceId: 'project/main', items: [] }],
  })
  assert.strictEqual(decoded._tag, 'Decoded')
  if (decoded._tag !== 'Decoded') return
  const bare = Site.render(decoded.documentation)
  assert.notInclude(
    bare.files.map((file) => file.path),
    'silk-snippet.js',
    'no bundle supplied, none shipped',
  )
  assert.notInclude(
    bare.files.find((file) => file.path === 'index.html')?.contents ?? '',
    'silk-snippet.js',
  )
  const site = Site.render(decoded.documentation, { snippetBundle: 'registered()' })
  const shipped = site.files.find((file) => file.path === 'silk-snippet.js')
  assert.strictEqual(shipped?.contents, 'registered()')
  assert.include(
    site.files.find((file) => file.path === 'index.html')?.contents ?? '',
    '<script type="module" src="silk-snippet.js"></script>',
    'pages reference the shipped script relatively',
  )
})

it.effect('renders the same bytes twice', () =>
  Effect.gen(function* () {
    const parsed = yield* Json.decode(encoded)
    const decoded = Model.decode(parsed)
    if (decoded._tag !== 'Decoded') return assert.fail('expected documentation JSON')
    const first = Site.render(decoded.documentation)
    const roundTripped = Model.decode(Json.decodeSync(Json.encodeValue(parsed)))
    if (roundTripped._tag !== 'Decoded') return assert.fail('expected documentation JSON')
    const second = Site.render(roundTripped.documentation)
    assert.deepStrictEqual(
      second.files.map((file) => [file.path, file.contents]),
      first.files.map((file) => [file.path, file.contents]),
    )
  }),
)

/**
 * The whole search path over a minimal document: the emitted index file, evaluated in a JavaScript engine,
 * searched by the same matcher the pages embed, resolving to a page the site actually wrote.
 */
it.effect('finds a declaration through the emitted index and resolves its page anchor', () =>
  Effect.gen(function* () {
    const decoded = Model.decode(yield* Json.decode(encoded))
    if (decoded._tag !== 'Decoded') return assert.fail('expected documentation JSON')
    const site = Site.render(decoded.documentation)
    const indexFile = site.files.find((file) => file.path === 'search-index.js')
    assert.isDefined(indexFile)

    const context = createContext({})
    runInContext(indexFile.contents, context)
    const loaded = runInContext(`globalThis.${Search.globalName}`, context)
    assert.isTrue(Array.isArray(loaded))
    if (!Array.isArray(loaded)) return
    assert.isAbove(loaded.length, 0)

    const found = Search.query(loaded, 'unwrapOr').at(0)
    assert.strictEqual(found?.name, 'Option.unwrapOr')
    assert.strictEqual(found?.module, 'silk/option')

    const [page, anchor] = (found?.href ?? '').split('#')
    const target = site.files.find((file) => file.path === page)
    assert.isDefined(target, `the index points at ${String(page)}, which the site did not write`)
    assert.include(target.contents, `id="${String(anchor)}"`)
    assert.include(target.contents, '<script src="search-index.js"></script>')
  }),
)
