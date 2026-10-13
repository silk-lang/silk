import * as Stdlib from '@silklang/compiler/Stdlib'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import * as Analysis from '@silklang/compiler/Analysis'
import * as WorkspaceInventory from '@silklang/compiler/WorkspaceInventory'
import * as Effect from 'effect/Effect'
import * as Console from 'effect/Console'
import * as Inspectable from 'effect/Inspectable'
import * as Workspace from '../src/Workspace.js'
import * as WorkspaceCatalog from '../src/WorkspaceCatalog.js'

const encoder = new TextEncoder()

it.live(
  'keeps exact lookup header-only and reuses every unaffected module summary',
  () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'silk-auto-import-scale-'))
      const sourceRoot = join(root, 'src')
      mkdirSync(sourceRoot)
      writeFileSync(
        join(root, 'silk.toml'),
        '[package]\nname = "scale"\nversion = "0.1.0"\nroot = "src/Main.silk"\n',
      )
      const moduleCount = 200
      const selectedOrdinal = 137
      for (let ordinal = 0; ordinal < moduleCount; ordinal += 1)
        writeFileSync(
          join(sourceRoot, `Module${ordinal}.silk`),
          `pub fn symbol${ordinal}() -> i32 { return ${ordinal} }`,
        )
      const mainText = `pub fn main() -> i32 { return symbol${selectedOrdinal}() }`
      const mainPath = join(sourceRoot, 'Main.silk')
      writeFileSync(mainPath, mainText)
      const document = yield* Workspace.open({
        uri: pathToFileURL(mainPath).href,
        version: 1,
        bytes: encoder.encode(mainText),
      })
      const analyzed = yield* Workspace.analyzeProject([document])
      const session = analyzed.get(document.uri)
      assert.isDefined(session)
      if (session === undefined) return

      assert.deepEqual(
        Analysis.modules(session.snapshot)
          .map((module) => module.name)
          .filter((name) => !Stdlib.isReserved(name)),
        ['Main'],
      )
      const inventory = yield* session.inventory.get
      const queryStartedAt = performance.now()
      const actions = Analysis.autoImportsAt(
        session.snapshot,
        inventory,
        'Main',
        mainText.indexOf(`symbol${selectedOrdinal}`) + 1,
      )
      const queryElapsedMs = performance.now() - queryStartedAt
      assert.deepEqual(
        actions.map((action) => action.candidate.module),
        [`Module${selectedOrdinal}`],
      )

      const changedPath = join(sourceRoot, `Module${selectedOrdinal}.silk`)
      writeFileSync(
        changedPath,
        `pub fn revised${selectedOrdinal}() -> i32 { return ${selectedOrdinal} }`,
      )
      const revised = yield* WorkspaceCatalog.refresh({
        configuration: {
          application: document.module,
          configuration: session.snapshot.configuration,
        },
        sourceRoot,
        documents: [document],
        previous: inventory,
        invalidation: { dirtyPaths: [changedPath], rediscover: false },
      })
      for (let ordinal = 0; ordinal < moduleCount; ordinal += 1) {
        const module = `Module${ordinal}`
        if (ordinal === selectedOrdinal)
          assert.isFalse(revised.project.get(module) === inventory.project.get(module))
        else assert.isTrue(revised.project.get(module) === inventory.project.get(module))
      }
      assert.deepEqual(WorkspaceInventory.candidates(revised, `symbol${selectedOrdinal}`), [])
      assert.deepEqual(
        WorkspaceInventory.candidates(revised, `revised${selectedOrdinal}`).map(
          (candidate) => candidate.module,
        ),
        [`Module${selectedOrdinal}`],
      )
      assert.strictEqual(revised.observation.scanned, 2)
      assert.strictEqual(revised.observation.reused, 1)
      assert.strictEqual(revised.observation.revised, 1)
      assert.strictEqual(revised.observation.removed, 0)
      assert.strictEqual(
        revised.observation.indexedModules,
        moduleCount + 1 + revised.toolchain.size,
      )
      assert.isAtLeast(revised.observation.indexedDeclarations, moduleCount + 1)
      yield* Console.log(
        Inspectable.toStringUnknown({
          modules: moduleCount + 1,
          initial: inventory.observation,
          incremental: revised.observation,
          queryElapsedMs,
        }),
      )
    }).pipe(Effect.provide([SourceResolver.empty, NodeServices.layer])),
  300_000,
)
