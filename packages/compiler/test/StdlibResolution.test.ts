import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SourceCatalog from '../src/SourceCatalog.js'
import * as Target from '../src/Target.js'
import * as PlatformCatalog from '../src/PlatformCatalog.js'
import * as Analysis from '../src/Analysis.js'
import * as Lexer from '../src/Lexer.js'
import * as ModuleClosure from '../src/ModuleClosure.js'
import * as NameResolution from '../src/NameResolution.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Stdlib from '../src/Stdlib.js'
import * as SourceOrigin from '../src/SourceOrigin.js'
import * as ToolchainIntegrity from '../src/ToolchainIntegrity.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const targetSourceUrl = new URL('../stdlib/silk/target.silk', import.meta.url)
const targetSource = new Uint8Array(readFileSync(targetSourceUrl))

it.effect('validates descriptive catalog provenance without claiming planned fixtures ran', () =>
  Effect.gen(function* () {
    const record = {
      identity: 'fixture/scalar-catalog',
      production: 'HandAuthored',
      authorities: [{ identity: 'fixture-spec', version: '1' }],
      headers: [{ identity: 'fixture.h', version: 'sha256:fixture-source-v1' }],
      scope: [
        { target: 'aarch64-apple-darwin', minimumDeployment: '11.0', maximumDeployment: '15.5' },
      ],
      declarations: [
        {
          identity: 'fixture_value',
          targets: ['aarch64-apple-darwin'],
          evidence: [
            {
              claim: 'Signature',
              authority: 'fixture-spec',
              reference: 'section 1',
              fixture: 'scalar-fixture',
              status: 'Planned',
            },
          ],
        },
      ],
      fixtures: [
        {
          identity: 'scalar-fixture',
          version: '1',
          tools: [{ identity: 'clang', version: '22.1.8' }],
        },
      ],
      generationInputs: [],
      review: {
        identity: 'record-shape-test',
        revision: '1',
        updateProcedure: 'Review fixture declaration edits',
        driftCheck: 'Compare independent signature fixture',
      },
    }
    const valid = yield* PlatformCatalog.decode(record)
    assert.strictEqual(valid.declarations[0]?.evidence[0]?.status, 'Planned')
    for (const [input, field] of [
      [{ ...record, authorities: [] }, 'authorities'],
      [{ ...record, production: 'Generated' }, 'generationInputs'],
      [{ ...record, scope: [{ ...record.scope[0], minimumDeployment: '16' }] }, 'scope'],
      [
        {
          ...record,
          declarations: [{ ...record.declarations[0], targets: ['x86_64-unknown-linux-gnu'] }],
        },
        'declarations.fixture_value.targets',
      ],
      [
        {
          ...record,
          declarations: [
            {
              ...record.declarations[0],
              evidence: [{ ...record.declarations[0]?.evidence[0], status: 'Verified' }],
            },
          ],
        },
        'declarations.fixture_value.evidence',
      ],
      [{ ...record, providerTargets: ['aarch64-apple-darwin'] }, 'record'],
    ] as const) {
      const error = yield* Effect.flip(PlatformCatalog.decode(input))
      assert.strictEqual(error.field, field)
    }
  }),
)

const importing = `import silk.vector { Vector }

pub fn main() -> i32 {
  return 42
}`

it('keeps the generated manifest ordered and byte-identical to canonical Silk files', () => {
  assert.deepEqual(
    Stdlib.manifest.map((entry) => entry.module),
    Stdlib.manifest.map((entry) => entry.module).sort(),
  )
  assert.include(
    Stdlib.manifest.map((entry) => entry.module),
    'silk/logger',
  )
  for (const entry of Stdlib.manifest) {
    assert.strictEqual(entry.path, `${entry.module}.silk`)
    assert.deepEqual(entry.bytes, new Uint8Array(readFileSync(entry.sourceUrl)))
    assert.deepEqual(Stdlib.sources.get(entry.module), entry.bytes)
  }
})

it('keeps the ordinary target actor manifest entry, syntax, and intrinsic phase inventory exact', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../stdlib/manifest.json', import.meta.url), 'utf8'),
  ) as ReadonlyArray<{
    readonly module: string
    readonly path: string
    readonly namespace?: string
    readonly aliases?: ReadonlyArray<string>
  }>
  const entry = manifest.find((candidate) => candidate.module === 'silk/target')
  assert.deepEqual(entry, {
    module: 'silk/target',
    path: 'silk/target.silk',
    namespace: 'Target',
    aliases: ['Arch'],
  })

  const syntax = Parser.parse(Lexer.lex(SourceFile.make('silk/target', targetSource)))
  assert.deepEqual(syntax.lexicalDiagnostics, [])
  assert.deepEqual(syntax.parserDiagnostics, [])

  const generator = fileURLToPath(new URL('../scripts/generate-stdlib.mjs', import.meta.url))
  const generated = spawnSync(process.execPath, [generator, '--stdout'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  assert.strictEqual(generated.status, 0, generated.stderr)
  const targetEntry = generated.stdout.slice(
    generated.stdout.indexOf("module: 'silk/target'"),
    generated.stdout.indexOf("module: 'silk/u16'"),
  )
  assert.include(targetEntry, "'targetPointerBits'")
  assert.include(targetEntry, 'runtimeInventory: []')
})

it.effect(
  'publishes nominal target headers and primitive static facts without name privilege',
  () =>
    Effect.gen(function* () {
      const closure = yield* ModuleClosure.load({
        root: 'silk/target',
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('silk/target', targetSource)]).pipe(
            Layer.provideMerge(SourceResolver.memory(new Map())),
          ),
        ),
      )
      const index = NameResolution.analyze(closure).index
      const module = index.modules.find((candidate) => candidate.module === 'silk/target')

      assert.deepEqual(index.diagnostics, [])
      assert.deepEqual(
        module?.enums.map((declaration) => ({
          name: declaration.name._tag === 'Present' ? declaration.name.spelling : undefined,
          visibility: declaration.visibility,
          members: declaration.members.map((member) => ({
            name: member.name._tag === 'Present' ? member.name.spelling : undefined,
            value:
              member.discriminant._tag === 'Available'
                ? member.discriminant.value
                : member.discriminant._tag,
          })),
        })),
        [
          {
            name: 'Arch',
            visibility: 'Public',
            members: [
              { name: 'Aarch64', value: 0n },
              { name: 'Wasm32', value: 1n },
              { name: 'X86_64', value: 2n },
            ],
          },
          {
            name: 'OperatingSystem',
            visibility: 'Public',
            members: [
              { name: 'Darwin', value: 0n },
              { name: 'Linux', value: 1n },
              { name: 'Freestanding', value: 2n },
            ],
          },
          {
            name: 'Abi',
            visibility: 'Public',
            members: [
              { name: 'Apple', value: 0n },
              { name: 'Gnu', value: 1n },
              { name: 'Wasm', value: 2n },
            ],
          },
          {
            name: 'ObjectFormat',
            visibility: 'Public',
            members: [
              { name: 'MachO', value: 0n },
              { name: 'Elf', value: 1n },
              { name: 'Wasm', value: 2n },
            ],
          },
          { name: 'Endianness', visibility: 'Public', members: [{ name: 'Little', value: 0n }] },
        ],
      )
      assert.deepEqual(
        module?.declarations
          .filter((declaration) => declaration.visibility === 'Public')
          .map((declaration) => ({
            name: declaration.name._tag === 'Present' ? declaration.name.spelling : undefined,
            phase: declaration.phase,
            parameterCount: declaration.parameterCount,
          })),
        [
          { name: 'arch', phase: 'Static', parameterCount: 0 },
          { name: 'operatingSystem', phase: 'Static', parameterCount: 0 },
          { name: 'abi', phase: 'Static', parameterCount: 0 },
          { name: 'objectFormat', phase: 'Static', parameterCount: 0 },
          { name: 'endianness', phase: 'Static', parameterCount: 0 },
          { name: 'cpu', phase: 'Static', parameterCount: 0 },
          { name: 'deployment', phase: 'Static', parameterCount: 0 },
          { name: 'hasCpuFeature', phase: 'Static', parameterCount: 1 },
        ],
      )
      assert.deepEqual(
        module?.constants.map((constant) => ({
          name: constant.name._tag === 'Present' ? constant.name.spelling : undefined,
          visibility: constant.visibility,
          type: constant.declaredType._tag,
        })),
        [
          { name: 'pointerBits', visibility: 'Public', type: 'Resolved' },
          { name: 'usizeMax', visibility: 'Public', type: 'Resolved' },
          { name: 'isizeMax', visibility: 'Public', type: 'Resolved' },
          { name: 'isizeMin', visibility: 'Public', type: 'Resolved' },
          { name: 'pointerAlignment', visibility: 'Public', type: 'Resolved' },
        ],
      )
    }),
)

it('derives deterministic catalog metadata and enforces portable dependency direction', () => {
  for (const entry of Stdlib.manifest) {
    const source = new TextDecoder().decode(entry.bytes)
    const intrinsicInventory = [
      ...new Set(
        [...source.matchAll(/\bIntrinsic\.([A-Za-z_][A-Za-z0-9_]*)/g)].flatMap((match) =>
          match[1] === undefined ? [] : [match[1]],
        ),
      ),
    ].sort()
    assert.strictEqual(entry.sourceIdentity, entry.module)
    assert.strictEqual(entry.documentation, entry.path)
    assert.strictEqual(createHash('sha256').update(entry.bytes).digest('hex'), entry.digest)
    assert.deepEqual(
      entry.staticInventory,
      intrinsicInventory.filter((operation) =>
        /^(target(Architecture|OperatingSystem|Abi|ObjectFormat|Endianness|PointerBits|PointerAlignment)|profile(Text|Flag|Contains))$/.test(
          operation,
        ),
      ),
    )
    assert.deepEqual(
      entry.runtimeInventory,
      intrinsicInventory.filter(
        (operation) =>
          !/^(target(Architecture|OperatingSystem|Abi|ObjectFormat|Endianness|PointerBits|PointerAlignment)|profile(Text|Flag|Contains))$/.test(
            operation,
          ),
      ),
    )
  }
})

it('publishes one deterministic matched identity graph over compiler, catalog, sources, and intrinsics', () => {
  const graph = ToolchainIntegrity.installed()
  assert.strictEqual(graph.schema, 'silk-toolchain-v1')
  assert.strictEqual(graph.digest.length, 64)
  assert.deepEqual(ToolchainIntegrity.validateFrontend(graph), {
    _tag: 'Matched',
    graph,
  })
  assert.deepEqual(
    graph.components.map((component) => `${component.kind}:${component.id}`),
    [...graph.components]
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
      .map((component) => `${component.kind}:${component.id}`),
  )
})

it('rejects stale catalog and source metadata', () => {
  const installed = ToolchainIntegrity.installed()
  const staleCatalog = ToolchainIntegrity.make(
    installed.components.map((component) =>
      component.kind === 'Catalog' ? { ...component, digest: '0'.repeat(64) } : component,
    ),
  )
  const catalogValidation = ToolchainIntegrity.validateFrontend(staleCatalog)
  assert.strictEqual(catalogValidation._tag, 'Invalid')
  if (catalogValidation._tag === 'Invalid')
    assert.isTrue(
      catalogValidation.failures.some(
        (failure) => failure.reason._tag === 'DigestMismatch' && failure.reason.kind === 'Catalog',
      ),
    )

  const staleSource = ToolchainIntegrity.make(
    installed.components.map((component) =>
      component.id === 'source/silk/vector' ? { ...component, digest: '0'.repeat(64) } : component,
    ),
  )
  const sourceValidation = ToolchainIntegrity.validateFrontend(staleSource)
  assert.strictEqual(sourceValidation._tag, 'Invalid')
  if (sourceValidation._tag === 'Invalid')
    assert.isTrue(
      sourceValidation.failures.some(
        (failure) =>
          failure.reason._tag === 'DigestMismatch' && failure.reason.id === 'source/silk/vector',
      ),
    )
})

it('computes browser-safe SHA-256 identities over exact UTF-8 bytes', () => {
  for (const value of ['', 'silk', 'λ'])
    assert.strictEqual(
      ToolchainIntegrity.contentDigest(value),
      createHash('sha256').update(value).digest('hex'),
    )
})

it.effect('keeps allocation metrics outside an unmetered program closure and MIR', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib/unmetered-allocation',
      ascii(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let block = run Allocator.allocate(Layout.of<[i32; 2]>()) |> Effect.provideMut(&mut allocator)
  drop block
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.notInclude(
      Analysis.modules(snapshot).map((module) => module.name),
      'silk/metrics',
    )
    assert.deepEqual(
      Analysis.loweredMir(snapshot)
        .functions.filter((fn) => fn.id.module === 'silk/metrics')
        .map((fn) => fn.id.name),
      [],
    )
  }),
)

it.effect('closes byte-loop helper providers over pointer and option only', () =>
  Effect.gen(function* () {
    // Every uncached native build realizes its selected helpers as a separate program, so one stray
    // import (such as `silk.i32`) re-elaborates the numeric, format and allocator closure each time.
    // `memset` still needs `i32.toU8` and is excluded until its conversion stops pulling that in.
    for (const symbol of ['bcmp', 'bzero', 'memcmp', 'memcpy', 'memmove']) {
      const closure = yield* ModuleClosure.load({ root: `silk/support/${symbol}` }).pipe(
        Effect.provide(SourceResolver.empty),
      )
      assert.deepEqual(
        [...closure.sources.keys()].sort(),
        ['silk/option', 'silk/pointer', `silk/support/${symbol}`],
        symbol,
      )
    }
  }),
)

it('declares discoverable namespaces for public modules and keeps C-only support private', () => {
  // Catalog namespaces drive tooling discovery only; they never enter source scope implicitly.
  assert.deepEqual(
    Stdlib.manifest.filter((entry) => entry.namespace === undefined).map((entry) => entry.module),
    [
      'silk/support/bcmp',
      'silk/support/bzero',
      'silk/support/memcmp',
      'silk/support/memcpy',
      'silk/support/memmove',
      'silk/support/memset',
    ],
  )
  assert.strictEqual(Stdlib.findNamespace('Uninitialized')?.module, 'silk/output')
  assert.deepEqual(Stdlib.find('silk/output')?.aliases, ['Initialized'])
  assert.strictEqual(Stdlib.findNamespace('Option')?.module, 'silk/option')
  assert.strictEqual(Stdlib.findNamespace('Result')?.module, 'silk/result')
  assert.strictEqual(Stdlib.findNamespace('Vector')?.module, 'silk/vector')
  assert.strictEqual(Stdlib.findNamespace('Effect')?.module, 'silk/effect')
  assert.strictEqual(Stdlib.findNamespace('Random')?.module, 'silk/random')
  assert.strictEqual(Stdlib.findNamespace('InsecureRandom')?.module, 'silk/insecure_random')
  assert.strictEqual(Stdlib.findNamespace('InsecureSeed')?.module, 'silk/insecure_seed')
  assert.strictEqual(Stdlib.findNamespace('OsRandom')?.module, 'silk/os_random')
  assert.strictEqual(Stdlib.findNamespace('Fiber')?.module, 'silk/fiber')
  assert.strictEqual(Stdlib.findNamespace('LocalScheduler')?.module, 'silk/local_scheduler')
  assert.strictEqual(Stdlib.findNamespace('Scheduler')?.module, 'silk/scheduler')
  assert.isDefined(Stdlib.find('silk/effect'))
  assert.isUndefined(Stdlib.find('silk/effects'))
  assert.deepEqual(Stdlib.find('silk/option')?.aliases, ['None', 'Some'])
  assert.deepEqual(Stdlib.find('silk/insecure_random')?.aliases, ['Xoshiro256StarStar'])
  assert.deepEqual(Stdlib.find('silk/insecure_seed')?.aliases, ['FixedInsecureSeed', 'Seed'])
  assert.isUndefined(Stdlib.find('silk/random')?.aliases)
  assert.includeMembers([...(Stdlib.find('silk/fiber')?.aliases ?? [])], ['Cancelled', 'Outcome'])
  assert.deepEqual(Stdlib.find('silk/local_scheduler')?.aliases, ['StalledError'])
  assert.includeMembers(
    [...(Stdlib.find('silk/scheduler')?.aliases ?? [])],
    ['PendingPublication', 'TaskId', 'TaskIdExhaustedError'],
  )
})

const insecureRandomImporter = `import silk.insecure_random { InsecureRandom }

pub fn main() -> i32 {
  let provider = InsecureRandom.seeded(0)
  drop provider
  return 42
}`

it.effect('resolves the complete InsecureRandom surface to canonical portable Silk source', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib/insecure-random-importer',
      ascii(insecureRandomImporter),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])

    const entry = Stdlib.find('silk/insecure_random')
    assert.isDefined(entry)
    assert.deepEqual(entry?.runtimeInventory, [])
    assert.isTrue(entry?.sourceUrl.pathname.endsWith('/stdlib/silk/insecure_random.silk') ?? false)

    const module = Analysis.declarationIndex(snapshot).modules.find(
      (candidate) => candidate.module === 'silk/insecure_random',
    )
    assert.isDefined(module)
    const canonicals = [
      ...(module?.declarations ?? []),
      ...(module?.services ?? []),
      ...(module?.structs ?? []),
    ].flatMap((declaration) =>
      declaration.canonical._tag === 'Canonical' ? [declaration.canonical.id] : [],
    )
    assert.includeMembers(
      canonicals.map((canonical) => canonical.name),
      [
        'InsecureRandom',
        'Xoshiro256StarStar',
        'InsecureRandom.seeded',
        'InsecureRandom.nextBool',
        'InsecureRandom.below',
        'InsecureRandom.fillBytes',
      ],
    )
    assert.isTrue(canonicals.every((canonical) => canonical.module === 'silk/insecure_random'))
  }),
)

it.effect('resolves secure Random and InsecureSeed to distinct canonical portable source', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib/random-capabilities-importer',
      ascii(`import silk.insecure_seed { InsecureSeed }
import silk.random { Random }
pub fn main() -> i32 {
  let provider = InsecureSeed.fixed(20, 22)
  drop provider
  return 42
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    for (const moduleName of ['silk/random', 'silk/insecure_seed']) {
      const entry = Stdlib.find(moduleName)
      assert.deepEqual(entry?.runtimeInventory, [])
    }
    const modules = Analysis.declarationIndex(snapshot).modules
    const names = (moduleName: string): Array<string> => {
      const module = modules.find((candidate) => candidate.module === moduleName)
      return [
        ...(module?.declarations ?? []),
        ...(module?.services ?? []),
        ...(module?.structs ?? []),
      ].flatMap((declaration) =>
        declaration.canonical._tag === 'Canonical' ? [declaration.canonical.id.name] : [],
      )
    }
    assert.includeMembers(names('silk/random'), [
      'Random',
      'Random.nextU64',
      'Random.nextBool',
      'Random.below',
    ])
    assert.notInclude(names('silk/random'), 'seeded')
    assert.notInclude(names('silk/random'), 'Xoshiro256StarStar')
    assert.includeMembers(names('silk/insecure_seed'), [
      'Seed',
      'InsecureSeed',
      'FixedInsecureSeed',
      'InsecureSeed.first',
      'InsecureSeed.second',
      'InsecureSeed.fixed',
      'InsecureSeed.fromRandom',
    ])
  }),
)

/** A namespace named only in a comment is prose, not a qualified actor. */
const commented = `// TODO: replace with Result.succeed once effect rows land
pub struct Result<A, F> { value: A }

pub fn main() -> i32 {
  return 0
}`

/** A namespace named only inside a static literal is inert text, not a qualified actor. */
const quoted = `pub fn label() -> string<'static> {
  return "Result.succeed"
}

pub struct Result<A, F> { value: A }

pub fn main() -> i32 {
  return 0
}`

/** A qualified call without an import remains unresolved. */
const called = `pub fn main() -> i32 {
  let outcome = Result.succeed<i32, i32>(42)
  drop outcome
  return 0
}`

it.effect('never injects a namespace named only inside a comment', () =>
  Effect.gen(function* () {
    // The closure scan is lexical: a commented mention leaves the user's own Result alone.
    const snapshot = yield* AnalysisFixture.retainingMain('stdlib/commented', ascii(commented))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.notInclude(
      Analysis.modules(snapshot).map((module) => module.name),
      'silk/result',
    )
  }),
)

it.effect('never injects a namespace named only inside a static literal', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource('stdlib/quoted', ascii(quoted))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.notInclude(
      Analysis.modules(snapshot).map((module) => module.name),
      'silk/result',
    )
  }),
)

it.effect('requires an explicit import for a qualified standard-library call', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain('stdlib/called', ascii(called))
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0009'],
    )
    assert.notInclude(
      Analysis.modules(snapshot).map((module) => module.name),
      'silk/result',
    )
  }),
)

it.effect('resolves standard-library imports without vendoring source', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain('stdlib/importer', ascii(importing))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    // `usize` renders and reads decimal text, so naming it reaches the formatting, writer, Effect,
    // and standard-service stack. The closure is an analysis fact, not an artifact cost: codegen
    // still emits only what `main` reaches.
    assert.deepEqual(
      Analysis.modules(snapshot).map((module) => module.name),
      [
        'silk/allocator',
        'silk/bool',
        'silk/bytes',
        'silk/char',
        'silk/effect',
        'silk/f32',
        'silk/f64',
        'silk/format',
        'silk/i16',
        'silk/i32',
        'silk/i64',
        'silk/i8',
        'silk/isize',
        'silk/layout',
        'silk/logger',
        'silk/monotonic_clock',
        'silk/option',
        'silk/order',
        'silk/raw_buffer',
        'silk/reflect',
        'silk/result',
        'silk/slice',
        'silk/slot',
        'silk/static_sequence',
        'silk/static_text',
        'silk/string',
        'silk/system_clock',
        'silk/target',
        'silk/u16',
        'silk/u32',
        'silk/u64',
        'silk/u8',
        'silk/usize',
        'silk/vector',
        'silk/writer',
        'stdlib/importer',
      ],
    )
    // The resolved declarations carry the library's canonical module identity.
    const index = Analysis.declarationIndex(snapshot)
    const library = index.modules.find((module) => module.module === 'silk/vector')
    assert.isDefined(library)
    assert.isTrue(
      library?.structs.some(
        (struct) => struct.canonical._tag === 'Canonical' && struct.canonical.id.name === 'Vector',
      ),
    )
  }),
)

it.effect('never consults a user resolver inside the reserved namespace', () =>
  Effect.gen(function* () {
    // A user resolver claims to supply silk/vector with hostile bytes; the closure must take
    // the compiler-shipped source instead.
    const hostile = new Map([['silk/vector', ascii('pub fn stolen() -> i32 { return 0 }')]])
    const closure = yield* ModuleClosure.load({
      root: 'stdlib/hostile-importer',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('stdlib/hostile-importer', ascii(importing))]).pipe(
          Layer.provideMerge(SourceResolver.memory(hostile)),
        ),
      ),
    )
    const library = closure.modules.find((module) => module.name === 'silk/vector')
    assert.isDefined(library)
    const librarySource = closure.sources.get('silk/vector')
    assert.isTrue(
      librarySource !== undefined &&
        new TextDecoder()
          .decode(SourceFile.toUint8Array(librarySource))
          .includes('struct Vector<T>'),
    )
    assert.strictEqual(librarySource?.origin._tag, 'Memory')
  }),
)

it.effect('resolves reserved roots exclusively through toolchain authority', () =>
  Effect.gen(function* () {
    const missing = yield* Effect.flip(
      ModuleClosure.load({ root: 'silk/impostor' }).pipe(
        Effect.provide(
          SourceResolver.memory(
            new Map([['silk/impostor', ascii('pub fn main() -> i32 { return 0 }')]]),
          ),
        ),
      ),
    )
    assert.deepEqual(missing.reason, { _tag: 'MissingRoot', module: 'silk/impostor' })
    const supplied = yield* ModuleClosure.load({ root: 'silk/bool' }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'silk/bool',
            ascii('pub fn stolen() -> i32 { return 0 }'),
            SourceOrigin.toolchainFile('forged'),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    const source = supplied.sources.get('silk/bool') ?? unreachable('toolchain root')
    assert.deepEqual(SourceFile.toUint8Array(source), Stdlib.sources.get('silk/bool'))
    assert.strictEqual(source.origin._tag, 'Memory')
    assert.deepEqual(supplied.diagnostics, [])
  }),
)

it.effect('compiles library source with ordinary diagnostics and no privilege', () =>
  Effect.gen(function* () {
    // Inject a defect into the shipped library table for this test only: it must surface as an
    // ordinary semantic diagnostic attributed to the library module, exactly like user code.
    const sources = Stdlib.sources as Map<string, Uint8Array>
    const original = sources.get('silk/vector')
    assert.isDefined(original)
    if (original === undefined) return
    sources.set('silk/vector', ascii('pub fn broken() -> Missing { return 0 }'))
    try {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'stdlib/defective-importer',
        ascii(importing),
      )
      const attributed = Analysis.diagnostics(snapshot).filter(
        (diagnostic) => diagnostic.span.sourceId === 'silk/vector',
      )
      assert.isAbove(attributed.length, 0)
      assert.include(
        attributed.map((diagnostic) => diagnostic.code),
        'SEM0001',
      )
      assert.strictEqual(Analysis.sources(snapshot).get('silk/vector')?.origin._tag, 'Memory')
    } finally {
      sources.set('silk/vector', original)
    }
  }),
)

/**
 * `app/helper` explicitly imports the standard library's `Result`. That ordinary dependency enters
 * the closure, but its catalog namespace does not enter the root module's scope.
 */
const shadowingRoot = `import app.helper { helped }

pub struct Result<A, F> { value: A }

fn own(value: Result<i32, i32>) -> i32 {
  drop value
  return 1
}

pub fn main() -> i32 {
  return helped()
}`

const shadowedHelper = `import silk.result { Result }

pub fn helped() -> i32 {
  let outcome = Result.succeed<i32, i32>(42)
  drop outcome
  return 0
}`

/** The shadowing module reaches the standard-library type it shadowed through a selected alias. */
const shadowingWithAlias = `import app.helper { helped }
import silk.result { Result as StdResult }

pub struct Result<A, F> { value: A }

fn own(value: Result<i32, i32>) -> i32 {
  drop value
  return 1
}

pub fn main() -> i32 {
  let outcome = StdResult.succeed<i32, i32>(7)
  drop outcome
  return helped()
}`

const withHelper = (
  root: string,
): Effect.Effect<Analysis.Snapshot, ModuleClosure.ModuleClosureError> =>
  Analysis.makeRealized({
    root: 'app/main',
    configuration: AnalysisFixture.configuration('app/main'),
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('app/main', ascii(root))]).pipe(
        Layer.provideMerge(SourceResolver.memory(new Map([['app/helper', ascii(shadowedHelper)]]))),
      ),
    ),
  )

it.effect('keeps catalog declarations out of an importing sibling module', () =>
  Effect.gen(function* () {
    const snapshot = yield* withHelper(shadowingRoot)
    // `silk/result` is in the closure only because the helper imported it.
    assert.include(
      Analysis.modules(snapshot).map((module) => module.name),
      'silk/result',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const lookup = Analysis.lookupName(snapshot, 'app/main', 'Result')
    assert.strictEqual(lookup._tag, 'Resolved')
    if (lookup._tag !== 'Resolved') return
    assert.strictEqual(lookup.declaration.canonical._tag, 'Canonical')
    if (lookup.declaration.canonical._tag !== 'Canonical') return
    assert.strictEqual(lookup.declaration.canonical.id.module, 'app/main')
    const helperImport = Analysis.lookupName(snapshot, 'app/helper', 'Result')
    assert.strictEqual(
      helperImport._tag === 'Resolved' && helperImport.declaration.canonical._tag === 'Canonical'
        ? helperImport.declaration.canonical.id.module
        : helperImport._tag,
      'silk/result',
    )
  }),
)

it.effect('reaches a shadowed standard-library module through an ordinary import', () =>
  Effect.gen(function* () {
    const snapshot = yield* withHelper(shadowingWithAlias)
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const alias = Analysis.lookupName(snapshot, 'app/main', 'StdResult')
    assert.deepEqual(
      alias._tag === 'Resolved' && alias.declaration.canonical._tag === 'Canonical'
        ? alias.declaration.canonical.id
        : alias._tag,
      { _tag: 'CanonicalDeclarationId', module: 'silk/result', name: 'Result' },
    )
    // The local declaration keeps the bare spelling.
    const local = Analysis.lookupName(snapshot, 'app/main', 'Result')
    assert.strictEqual(
      local._tag === 'Resolved' && local.declaration.canonical._tag === 'Canonical'
        ? local.declaration.canonical.id.module
        : undefined,
      'app/main',
    )
  }),
)

it.effect(
  'lists unconditional providers and selects other native providers and facade imports by profile',
  () =>
    Effect.gen(function* () {
      const providers = [
        'child_process',
        'filesystem',
        'host_input',
        'monotonic_clock',
        'random',
        'standard_input',
        'system_clock',
      ]
      const root = SourceFile.make(
        'project/providers',
        ascii(
          providers.map((name, index) => `import silk.os_${name} as provider${index}`).join('\n'),
        ),
      )
      const facade = SourceFile.make(
        'project/facade',
        ascii(`
      static if Intrinsic.targetOperatingSystem() == "darwin" {
        pub import silk.os_filesystem { OsFileSystem }
      }
    `),
      )
      for (const target of Target.all) {
        const selection = yield* SourceCatalog.analyze({
          roots: [root.id, facade.id],
          configuration: {
            profile: { target: target.id, artifact: 'object', runtime: { kind: 'none' } },
          },
        }).pipe(
          Effect.provide(
            SourceResolver.overlay([root, facade]).pipe(Layer.provideMerge(SourceResolver.empty)),
          ),
        )
        assert.deepEqual(selection.closure.resolutionFailures, [])
        assert.deepEqual(selection.closure.diagnostics, [])
        for (const name of providers) {
          const summary = selection.catalog?.modules.get(`silk/os_${name}`)
          assert.isDefined(summary, name)
          assert.strictEqual(
            (summary?.publicDeclarations.length ?? 0) > 0,
            target.kind === 'Native' || name === 'monotonic_clock' || name === 'random',
            `${target.id}: ${name}`,
          )
        }
        assert.strictEqual(
          (selection.catalog?.modules.get('project/facade')?.publicDeclarations.length ?? 0) > 0,
          target.operatingSystem === 'darwin',
        )
      }
    }),
)

it.effect('resolves all TOML modules in every supported target profile', () =>
  Effect.gen(function* () {
    const modules = ['toml_scanner', 'toml_text', 'toml_value', 'toml_output', 'toml_codec']
    const source = SourceFile.make(
      'project/toml-imports',
      ascii(modules.map((name, index) => `import silk.${name} as Toml${index}`).join('\n')),
    )
    for (const target of Target.all) {
      for (const libc of target.operatingSystem === 'linux'
        ? [undefined, 'none' as const]
        : [undefined]) {
        const selection = yield* SourceCatalog.analyze({
          roots: [source.id],
          configuration: {
            profile: libc === undefined ? { target: target.id } : { target: target.id, libc },
          },
        }).pipe(
          Effect.provide(
            SourceResolver.overlay([source]).pipe(Layer.provideMerge(SourceResolver.empty)),
          ),
        )
        const profile = `${target.id}${libc === undefined ? '' : '-no-libc'}`
        assert.deepEqual(selection.closure.resolutionFailures, [], profile)
        assert.deepEqual(selection.closure.diagnostics, [], profile)
        for (const name of modules) {
          assert.isAbove(
            selection.catalog?.modules.get(`silk/${name}`)?.publicDeclarations.length ?? 0,
            0,
            `${profile}: ${name}`,
          )
        }
      }
    }
  }),
)

it.effect(
  'selects native file trust on exactly three libc profiles and rejects other reachability',
  () =>
    Effect.gen(function* () {
      const supported = [
        'aarch64-apple-darwin',
        'aarch64-unknown-linux-gnu',
        'x86_64-unknown-linux-gnu',
      ]
      const source = `import silk.memory_trust_source { MemoryTrustSource }
import silk.native_file_trust_source { NativeFileTrustSource }
pub fn nativeProvider(value: NativeFileTrustSource) -> () { return () }
pub fn portableProvider(value: MemoryTrustSource) -> () { return () }`
      const selected: Array<string> = []
      for (const target of Target.all) {
        const selection = yield* SourceCatalog.analyze({
          roots: [`native-file-trust/${target.id}`],
          configuration: {
            profile: { target: target.id, artifact: 'object', runtime: { kind: 'none' } },
          },
        }).pipe(
          Effect.provide(
            SourceResolver.overlay([
              SourceFile.make(`native-file-trust/${target.id}`, ascii(source)),
            ]).pipe(Layer.provideMerge(SourceResolver.empty)),
          ),
        )
        assert.deepEqual(selection.closure.resolutionFailures, [], target.id)
        const native = selection.catalog?.modules.get('silk/native_file_trust_source')
        const portable = selection.catalog?.modules.get('silk/memory_trust_source')
        assert.isDefined(portable, target.id)
        assert.isAbove(portable?.publicDeclarations.length ?? 0, 0, target.id)
        if ((native?.publicDeclarations.length ?? 0) > 0) {
          selected.push(target.id)
        }
      }
      assert.deepEqual(selected.sort(), supported)

      const unavailable = [
        { target: 'wasm32-unknown-unknown', libc: undefined },
        { target: 'x86_64-unknown-linux-gnu', libc: 'none' as const },
      ]
      for (const profile of unavailable) {
        const snapshot = yield* Analysis.makeRealized({
          root: `native-file-trust/unavailable/${profile.target}/${profile.libc ?? 'default'}`,
          configuration: {
            profile: {
              target: profile.target,
              artifact: 'object',
              ...(profile.libc === undefined ? {} : { libc: profile.libc }),
              runtime: { kind: 'none' },
              entry: { kind: 'none' },
            },
          },
        }).pipe(
          Effect.provide(
            SourceResolver.overlay([
              SourceFile.make(
                `native-file-trust/unavailable/${profile.target}/${profile.libc ?? 'default'}`,
                ascii(source),
              ),
            ]).pipe(Layer.provideMerge(SourceResolver.empty)),
          ),
        )
        assert.deepEqual(
          Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
          ['SEM0014'],
          `${profile.target}/${profile.libc ?? 'default'}`,
        )
      }
    }),
  // This intentionally resolves every target plus two realized unavailable-member programs. The
  // complete stdlib crosses the 60s default while CI shards saturate the host; this is contention
  // headroom, not a performance assertion or an expanded test matrix.
  120_000,
)
