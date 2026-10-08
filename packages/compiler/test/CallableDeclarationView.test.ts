import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as CallableDeclarationView from '../src/CallableDeclarationView.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import type * as DeclarationIndex from '../src/DeclarationIndex.js'
import * as Lifetime from '../src/Lifetime.js'
import type * as Mir from '../src/Mir.js'
import * as Type from '../src/Type.js'
import * as TypeInference from '../src/internal/TypeInference.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { unreachable } from './support/raise.js'

it.effect(
  'replays original header inputs without borrowing a contextual invocation designation',
  () =>
    Effect.gen(function* () {
      const self = yield* AnalysisFixture.frontend(
        'callable-declaration-view',
        new TextEncoder().encode(`import silk.effect { Effect }
effect<'env> fn failed<E: 'env, 'env>(error: E) -> i32 { drop error return 42 }
fn ordinary(value: i32) -> i32 { return value }
fn fresh(value: i32) -> once Effect<'static; i32> { return effect { return value } }
fn invoke(handler: for<use 'call> fn(i32) -> once Effect<'call; i32>) -> i32 {
  return run handler(42)
}
pub fn main() -> i32 {
  return invoke(fn(value: i32) -> once Effect<'static; i32> { return effect { return value } })
}`),
      )
      assert.deepEqual(Analysis.diagnostics(self), [])
      const module = self.index.modules.find(
        (module) => module.module === 'callable-declaration-view',
      )
      if (module === undefined) return unreachable('expected original source headers')
      const declaration =
        module.declarations.find(
          (declaration) =>
            declaration.canonical._tag === 'Canonical' &&
            declaration.canonical.id.name === 'failed',
        ) ?? unreachable('expected original generic recovery header')
      const canonical = declaration.canonical
      if (canonical._tag !== 'Canonical') return unreachable('expected canonical header')
      const contract = DeclarationFacts.callableContract(declaration)
      const use = Lifetime.bound({ module: 'consumer', name: 'recover' }, 0, 'call')
      const formation = Lifetime.local({ module: 'caller', name: 'main' }, 'formation', 1)
      const arguments_: ReadonlyArray<Type.GenericArgument> = [
        'i32',
        Lifetime.intersection([use, formation]),
      ]
      const substitution =
        TypeInference.substitution(contract.binders, arguments_) ??
        unreachable('expected source slots')
      const selected = Type.substitute(contract.result, substitution)
      if (!Type.isEffect(selected)) return unreachable('expected source Effect result')
      const actual: Extract<Mir.Type, { readonly _tag: 'CallableValue' }> = {
        _tag: 'CallableValue',
        target: { _tag: 'DeclarationCallableTarget', declaration: canonical.id },
        typeArguments: arguments_,
        type: Type.callable(
          ['i32'],
          { ...selected, access: 'Take', typeOutlives: [] },
          {
            environment: formation,
            lifetimeBinders: [use],
            invocationUse: { lifetime: use, parameters: [0] },
          },
        ),
      }
      const source =
        CallableDeclarationView.original(self.index, actual) ??
        unreachable('expected source header')
      assert.strictEqual(source.declaration, declaration)
      assert.deepEqual(source.inputs, [0])
      assert.deepEqual(source.parameters, ['i32'])
      assert.isUndefined(source.contract.invocationUse)
      assert.deepEqual(
        source.contract.binders.map((binder) => binder.ordinal),
        [0, 1],
      )
      assert.deepEqual(source.contract.typeOutlives, contract.typeOutlives)
      assert.isUndefined(
        CallableDeclarationView.original(self.index, {
          ...actual,
          type: { ...actual.type, result: { ...selected, success: 'bool' } },
        }),
      )
      assert.isUndefined(
        CallableDeclarationView.original(self.index, {
          ...actual,
          type: { ...actual.type, result: Type.effect('i32', ['bool'], selected) },
        }),
      )
      assert.isUndefined(
        CallableDeclarationView.original(self.index, {
          ...actual,
          type: {
            ...actual.type,
            result: Type.effect('i32', [], selected, 'Take', [
              {
                capability: Type.nominal('foreign', 'Requirement', []),
                access: 'Shared',
                role: 'DefaultRole',
              },
            ]),
          },
        }),
      )

      const replace = (replacement: DeclarationFacts.DeclarationFact): DeclarationIndex.Index => ({
        ...self.index,
        modules: self.index.modules.map((value) =>
          value === module
            ? {
                ...value,
                declarations: value.declarations.map((value) =>
                  value === declaration ? replacement : value,
                ),
              }
            : value,
        ),
      })
      assert.isUndefined(
        CallableDeclarationView.original({ ...self.index, stage: 'Collected' }, actual),
      )
      assert.isUndefined(
        CallableDeclarationView.original(self.index, { ...actual, typeArguments: ['i32'] }),
      )
      assert.isUndefined(
        CallableDeclarationView.original(self.index, {
          ...actual,
          typeArguments: [formation, 'i32'],
        }),
      )
      assert.isUndefined(
        CallableDeclarationView.original(self.index, {
          ...actual,
          typeArguments: ['bool', arguments_[1] ?? unreachable()],
        }),
      )
      assert.isUndefined(
        CallableDeclarationView.original(self.index, {
          ...actual,
          target: {
            _tag: 'DeclarationCallableTarget',
            declaration: { ...canonical.id, name: 'missing' },
          },
        }),
      )
      assert.isUndefined(
        CallableDeclarationView.original(replace({ ...declaration, parameterCount: 2 }), actual),
      )
      assert.isUndefined(
        CallableDeclarationView.original(
          replace({
            ...declaration,
            parameters: declaration.parameters.map((parameter) => ({
              ...parameter,
              phase: 'Static',
            })),
          }),
          actual,
        ),
      )
      assert.isUndefined(
        CallableDeclarationView.original(
          replace({
            ...declaration,
            anchor: {
              ...declaration.anchor,
              owner: AuthoredIdentity.module('foreign', 'foreign'),
            },
          }),
          actual,
        ),
      )
      assert.isUndefined(
        CallableDeclarationView.original(
          replace({
            ...declaration,
            parameters: declaration.parameters.map((parameter) => ({
              ...parameter,
              id: { ...parameter.id, ordinal: 7 },
            })),
          }),
          actual,
        ),
      )
      assert.isUndefined(
        CallableDeclarationView.original(
          replace({
            ...declaration,
            parameters: declaration.parameters.map((parameter) => ({
              ...parameter,
              declaredType: {
                _tag: 'Resolved',
                type: 'bool',
                spelling: 'bool',
                anchor: parameter.anchor,
              },
            })),
          }),
          actual,
        ),
      )
      assert.isUndefined(
        CallableDeclarationView.original(
          replace({
            ...declaration,
            returnType: {
              _tag: 'Resolved',
              type: 'bool',
              spelling: 'bool',
              anchor: declaration.anchor,
            },
          }),
          actual,
        ),
      )
      assert.isUndefined(
        CallableDeclarationView.original(
          {
            ...self.index,
            modules: self.index.modules.map((value) =>
              value === module
                ? { ...value, declarations: [...value.declarations, declaration] }
                : value,
            ),
          },
          actual,
        ),
      )

      const ordinary =
        module.declarations.find(
          (declaration) =>
            declaration.name._tag === 'Present' && declaration.name.spelling === 'ordinary',
        ) ?? unreachable('expected ordinary header')
      if (ordinary.canonical._tag !== 'Canonical') return unreachable()
      assert.isUndefined(
        CallableDeclarationView.original(self.index, {
          ...actual,
          target: { _tag: 'DeclarationCallableTarget', declaration: ordinary.canonical.id },
        }),
      )
      const fresh =
        module.declarations.find(
          (declaration) =>
            declaration.name._tag === 'Present' && declaration.name.spelling === 'fresh',
        ) ?? unreachable('expected originally Static result header')
      if (fresh.canonical._tag !== 'Canonical') return unreachable()
      const freshContract = DeclarationFacts.callableContract(fresh)
      if (!Type.isEffect(freshContract.result)) return unreachable()
      const freshView: Extract<Mir.Type, { readonly _tag: 'CallableValue' }> = {
        ...actual,
        target: { _tag: 'DeclarationCallableTarget', declaration: fresh.canonical.id },
        typeArguments: [],
        type: {
          ...actual.type,
          result: { ...freshContract.result, environment: selected.environment },
        },
      }
      const freshSource =
        CallableDeclarationView.original(self.index, freshView) ??
        unreachable('expected original source channels')
      assert.strictEqual(freshSource.contract.result, freshContract.result)
      assert.strictEqual(
        Type.isEffect(freshSource.contract.result) && freshSource.contract.result.environment._tag,
        'StaticLifetime',
      )

      const marked =
        [...self.results.values()]
          .flatMap((result) => result.bodies)
          .find(
            (body) =>
              body.hidden && body.declaration.lifetimeElaboration?.invocationUse !== undefined,
          )?.declaration ?? unreachable('expected source-owned hidden marked header')
      if (marked.canonical._tag !== 'Canonical') return unreachable()
      const markedContract = DeclarationFacts.callableContract(marked)
      const markedActual: Extract<Mir.Type, { readonly _tag: 'CallableValue' }> = {
        _tag: 'CallableValue',
        target: { _tag: 'DeclarationCallableTarget', declaration: marked.canonical.id },
        typeArguments: markedContract.binders.map(Type.parameterArgument),
        type: Type.callable(
          markedContract.parameters.map((parameter) => parameter.type),
          markedContract.result,
          markedContract,
        ),
      }
      // Runtime completion publishes these exact checked hidden headers into its owning index.
      const markedIndex: DeclarationIndex.Index = {
        ...self.index,
        modules: self.index.modules.map((value) =>
          value === module ? { ...value, declarations: [...value.declarations, marked] } : value,
        ),
      }
      const markedSource =
        CallableDeclarationView.original(markedIndex, markedActual) ??
        unreachable('expected original marked source header')
      assert.strictEqual(
        markedSource.contract.invocationUse?.lifetime,
        markedContract.invocationUse?.lifetime,
      )
      const elaboration = marked.lifetimeElaboration ?? unreachable('expected authored use owner')
      const designation = elaboration.invocationUse ?? unreachable('expected authored use role')
      const { invocationUse: actualUse, ...unmarkedType } = markedActual.type
      assert.isDefined(actualUse)
      assert.isUndefined(
        CallableDeclarationView.original(markedIndex, { ...markedActual, type: unmarkedType }),
      )
      assert.isUndefined(
        CallableDeclarationView.original(markedIndex, {
          ...markedActual,
          type: {
            ...markedActual.type,
            invocationUse: {
              ...designation,
              lifetime: Lifetime.bound(marked.canonical.id, 99, 'call'),
            },
          },
        }),
      )
      assert.isUndefined(
        CallableDeclarationView.original(
          {
            ...markedIndex,
            modules: markedIndex.modules.map((value) =>
              value === markedIndex.modules.find((value) => value.module === module.module)
                ? {
                    ...value,
                    declarations: value.declarations.map((value) =>
                      value === marked
                        ? {
                            ...value,
                            lifetimeElaboration: {
                              ...elaboration,
                              invocationUse: {
                                ...designation,
                                lifetime: Lifetime.bound(
                                  { module: 'foreign', name: 'other' },
                                  0,
                                  'call',
                                ),
                              },
                            },
                          }
                        : value,
                    ),
                  }
                : value,
            ),
          },
          markedActual,
        ),
      )
    }),
)
