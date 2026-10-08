import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as Instances from '../src/Instances.js'
import * as SourceCallView from '../src/SourceCallView.js'
import * as Stdlib from '../src/Stdlib.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'
import { raise } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const documentationRoot = fileURLToPath(
  new URL('../../../apps/docs/content/language/', import.meta.url),
)
const languageReferenceRoot = fileURLToPath(
  new URL('../../../apps/docs/content/reference/', import.meta.url),
)
const diagnosticSource = fileURLToPath(new URL('../src/Diagnostic.ts', import.meta.url))

interface Block {
  readonly file: string
  readonly line: number
  readonly source: string
}

/**
 * Collects every fenced Silk block of one document.
 *
 * A block fenced ```silk is compiled whole. A block fenced ```silk ignore documents a rejected
 * form and is only checked for its presence, because the compiler is expected to refuse it.
 */
const blocksOf = (root: string, file: string): ReadonlyArray<Block> => {
  const text = readFileSync(join(root, file), 'utf8')
  const lines = text.split('\n')
  const blocks: Array<Block> = []
  let start: number | undefined
  let collected: Array<string> = []
  for (const [index, line] of lines.entries()) {
    if (start === undefined) {
      if (line.trimEnd() === '```silk') start = index + 2
      continue
    }
    if (line.trimStart().startsWith('```')) {
      blocks.push({ file, line: start, source: collected.join('\n') })
      start = undefined
      collected = []
      continue
    }
    collected.push(line)
  }
  assert.strictEqual(start, undefined, `${file} leaves a Silk block unterminated`)
  return blocks
}

// The prose documents carry complete programs. diagnostics.md and the stdlib/ tree are generated;
// generated signature fences are not standalone modules and stdlib examples have their own gate.
const generated = new Set(['diagnostics.md'])

const documents = readdirSync(documentationRoot)
  .filter((entry) => entry.endsWith('.md'))
  .sort()

const blocks = documents
  .filter((entry) => !generated.has(entry))
  .flatMap((file) => blocksOf(documentationRoot, file))

const diagnosticText = readFileSync(diagnosticSource, 'utf8')

interface Declaration {
  readonly name: string
  readonly code: string
}

// Every stable code is declared as `export const <name>Code = '<CODE>' as const`. Reading the
// source rather than the module keeps the constant name, which a collision report has to carry.
const declarations: ReadonlyArray<Declaration> = [
  ...diagnosticText.matchAll(/export const (\w+Code) = '([A-Z]{3}[0-9]{4})' as const/g),
].map((match) => ({
  name: match[1] ?? raise('the declaration pattern must capture a constant name'),
  code: match[2] ?? raise('the declaration pattern must capture a stable code'),
}))

const codeLiterals = [...diagnosticText.matchAll(/'([A-Z]{3}[0-9]{4})' as const/g)].map(
  (match) => match[1] ?? raise('the literal pattern must capture a stable code'),
)

it('finds Silk examples and both documentation entrypoints', () => {
  assert.isTrue(
    documents.includes('tutorial.md'),
    'the getting-started tutorial must live in the language section',
  )
  assert.isTrue(documents.includes('index.md'), 'the language section entrypoint must exist')
  assert.isTrue(
    readdirSync(languageReferenceRoot).includes('index.md'),
    'the language reference entrypoint must exist',
  )
  assert.isAbove(blocks.length, 0, 'the documentation must carry compilable Silk examples')
})

it('documents every standard library module and every diagnostic code', () => {
  const stdlib = readFileSync(join(documentationRoot, 'stdlib', 'index.md'), 'utf8')
  for (const module of Stdlib.manifest)
    assert.include(
      stdlib,
      `\`${module.module}\``,
      `${module.module} is missing from stdlib/index.md`,
    )

  const diagnostics = readFileSync(join(documentationRoot, 'diagnostics.md'), 'utf8')
  const declared = new Set(codeLiterals)
  assert.isAbove(declared.size, 0, 'Diagnostic.ts must declare stable codes')
  for (const code of declared)
    assert.include(diagnostics, `\`${code}\``, `${code} is missing from diagnostics.md`)
})

/**
 * A stable code is a public contract: it appears in diagnostics.md, in user-facing messages, and
 * in tests that assert on it by string. Two constants holding one code ship two meanings under
 * that contract, and nothing else notices — the containment check above passes for both, since
 * both find the code present.
 *
 * Concurrent branches each take "the next free code" against a `main` that lacks the other's, so
 * a collision is only ever visible on the merge result. Git catches it only when both branches
 * happen to insert at the same line; when they do not, the merge is clean and the duplicate ships.
 * This test is the check that does not depend on that coincidence, so it must hold for constants
 * declared anywhere in the file, not just adjacent ones.
 */
it('gives every diagnostic constant a distinct stable code', () => {
  assert.isAbove(declarations.length, 0, 'Diagnostic.ts must declare stable codes')
  // A code literal the declaration pattern cannot see is a code this test cannot check.
  assert.strictEqual(
    declarations.length,
    codeLiterals.length,
    'every stable code in Diagnostic.ts must be declared as `export const <name>Code`',
  )

  const names = new Map<string, Array<string>>()
  for (const { name, code } of declarations) {
    const holders = names.get(code)
    if (holders === undefined) names.set(code, [name])
    else holders.push(name)
  }

  const collisions = [...names]
    .filter(([, holders]) => holders.length > 1)
    .map(([code, holders]) => `${code} is held by ${holders.join(' and ')}`)

  assert.deepEqual(
    collisions,
    [],
    'each stable diagnostic code must belong to exactly one constant; renumber the newer one',
  )
})

for (const block of blocks) {
  // The complete Fiber walkthrough exceeded the shared minute under the saturated compiler
  // suite. Its scheduler realization needs a larger correctness deadline than the small examples.
  const timeout = block.file === 'fibers.md' ? 120_000 : undefined
  it.effect(
    `compiles ${block.file}:${block.line} without a diagnostic`,
    () =>
      Effect.gen(function* () {
        const snapshot = yield* Analysis.ofSourceRealized(
          `documentation/${block.file.replace(/[^A-Za-z0-9_-]/g, '-')}/${block.line}`,
          ascii(block.source),
          'wasm32-unknown-unknown',
        )
        const diagnostics = Analysis.diagnostics(snapshot)
        assert.deepEqual(
          diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
          [],
          `${block.file}:${block.line}\n${block.source}`,
        )
        if (block.file === 'fibers.md' && block.line === 16) {
          const discovery = Analysis.instancesOf(snapshot)
          const caller = discovery.instances.find(
            (instance) => instance.key.declaration.name === 'Fiber.forkChild',
          )
          if (caller === undefined) return raise('missing original fork caller')
          const subject = caller.function.statements
            .flatMap(Tir.statementExpressions)
            .flatMap(Tir.expressionTree)
            .find(
              (
                node,
              ): node is Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }> =>
                node._tag === 'ServiceEffectConstruct' && node.operation === 'prepare',
            )
          if (subject === undefined) return raise('missing original prepare operation')
          const call = discovery.calls.find(
            (candidate) =>
              Instances.keyText(candidate.owner) === Instances.keyText(caller.key) &&
              candidate.node?.ordinal === subject.id?.ordinal,
          )
          if (call === undefined) return raise('missing original selected prepare call')
          const implementation = discovery.instances.find(
            (instance) => Instances.keyText(instance.key) === Instances.keyText(call.target),
          )
          if (implementation === undefined) return raise('missing original prepare implementation')
          const root = implementation.function.statements
            .flatMap(Tir.statementExpressions)
            .find((node) => node._tag === 'EffectBlock')
          if (root?._tag !== 'EffectBlock') return raise('missing original prepare Effect body')
          const capture = root.captures.find((entry) => entry.parameter?.ordinal === 1)
          assert.strictEqual(capture?.access, 'Take')
          const layout = Analysis.loweredMir(snapshot).layout
          const environment = layout.effectEnvironments.find(
            (candidate) =>
              candidate._tag === 'EffectEnvironment' &&
              Instances.keyText(candidate.instance) === Instances.keyText(call.target) &&
              Instances.effectIdentity(candidate.instance, candidate.site) === call.resultEffect,
          )
          if (environment?._tag !== 'EffectEnvironment')
            return raise('missing actual prepare environment')
          const child = environment.fields.find((field) => field.ordinal === 1)
          if (child === undefined || !Type.isEffect(child.type))
            return raise('missing actual child Effect field')
          assert.strictEqual(child.access, 'Shared')
          assert.strictEqual(child.type.access, 'Shared')
          const receiver = implementation.specialization.parameters.at(0)
          if (
            receiver === undefined ||
            !Type.isReference(receiver) ||
            !Type.isNominal(receiver.target)
          )
            return raise('missing original scheduler client receiver')
          const capability = Type.substitute(subject.service, caller.substitution)
          if (!Type.isNominal(capability)) return raise('missing original Scheduler capability')
          const witness = ConformanceProof.witness(
            Analysis.declarationIndex(snapshot),
            receiver.target,
            capability,
          )
          if (witness?._tag !== 'SourceConformanceWitness')
            return raise('missing original Scheduler witness')
          const provider = {
            capability,
            providerType: receiver.target,
            witness,
            role: subject.role,
            access: subject.access,
            requirementAccess: subject.access,
          }
          const held = {
            owner: caller,
            index: Analysis.declarationIndex(snapshot),
            instances: discovery.instances,
            calls: discovery.calls,
            layout,
            semantic: (type: Type.Type) => Type.substitute(type, caller.substitution),
          }
          assert.isDefined(
            SourceCallView.service(held, subject, call, provider, environment.effect),
          )
          for (const forged of [
            { ...child, access: 'Take' as const },
            { ...child, effectIdentity: 'foreign-child' },
          ]) {
            const altered = {
              ...layout,
              effectEnvironments: layout.effectEnvironments.map((candidate) =>
                candidate === environment
                  ? {
                      ...environment,
                      fields: environment.fields.map((field) => (field === child ? forged : field)),
                    }
                  : candidate,
              ),
            }
            assert.isUndefined(
              SourceCallView.service(
                { ...held, layout: altered },
                subject,
                call,
                provider,
                environment.effect,
              ),
            )
          }
        }
      }),
    timeout,
  )
}
