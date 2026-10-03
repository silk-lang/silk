import { records } from './records.js'
import * as OpaqueRealization from '../../src/OpaqueRealization.js'
import * as Analysis from '../../src/Analysis.js'
import type * as DeclarationFacts from '../../src/DeclarationFacts.js'
import * as Tir from '../../src/Tir.js'
import * as Layout from '../../src/Layout.js'
import * as Mir from '../../src/Mir.js'
import * as ModuleTooling from '../../src/ModuleTooling.js'
import * as ProvisionalMir from '../../src/ProvisionalMir.js'
import * as SuspensionOwnership from '../../src/SuspensionOwnership.js'
import * as Type from '../../src/Type.js'

export const syntaxOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Analysis.moduleSyntax(self, module)

const nestedStatements = (statement: Tir.Statement): ReadonlyArray<Tir.Statement> => {
  switch (statement._tag) {
    case 'Unsafe':
      return Object.freeze([statement, ...statement.statements.flatMap(nestedStatements)])
    case 'If':
    case 'IfLet':
      return Object.freeze([
        statement,
        ...statement.taken.flatMap(nestedStatements),
        ...statement.otherwise.flatMap(nestedStatements),
      ])
    case 'While':
      return Object.freeze([statement, ...statement.body.flatMap(nestedStatements)])
    default:
      return Object.freeze([statement])
  }
}

export const statementsOf = (
  self: Analysis.FrontendSnapshot,
  module: string,
): ReadonlyArray<Tir.Statement> =>
  Object.freeze(
    records(self.results.get(module))?.functions.flatMap((fn) =>
      fn.statements.flatMap(nestedStatements),
    ) ?? [],
  )

export const bindingsOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(records(self.results.get(module))?.functions.flatMap((fn) => fn.bindings) ?? [])

export const writesOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(
    statementsOf(self, module).filter(
      (statement): statement is Extract<Tir.Statement, { readonly _tag: 'Write' }> =>
        statement._tag === 'Write',
    ),
  )

export const loopsOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(
    statementsOf(self, module).filter(
      (statement): statement is Extract<Tir.Statement, { readonly _tag: 'While' }> =>
        statement._tag === 'While',
    ),
  )

export const transfersOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(
    statementsOf(self, module).filter(
      (statement): statement is Extract<Tir.Statement, { readonly _tag: 'Break' | 'Continue' }> =>
        statement._tag === 'Break' || statement._tag === 'Continue',
    ),
  )

const expressionsOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(
    records(self.results.get(module))?.functions.flatMap((fn) =>
      fn.statements.flatMap(ModuleTooling.statementExpressions),
    ) ?? [],
  )

export const matchesOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(
    expressionsOf(self, module).filter(
      (expression): expression is Extract<Tir.Expression, { readonly _tag: 'Match' }> =>
        expression._tag === 'Match',
    ),
  )

export const tirOf = (self: Analysis.FrontendSnapshot, module: string) =>
  self.results.get(module)?.tir

export const ownershipFixedPointsOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(self.ownership.get(module)?.functions.flatMap((fn) => fn.fixedPoints) ?? [])

export const cleanupExitsOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(self.ownership.get(module)?.functions.flatMap((fn) => fn.exits) ?? [])

export const genericDeclarationsOf = (
  self: Analysis.FrontendSnapshot,
): ReadonlyArray<DeclarationFacts.MemberFact> =>
  Object.freeze(
    self.index.modules.flatMap((module) =>
      module.members.filter((member) => member.typeParameters.length > 0),
    ),
  )

export const genericCallsOf = (self: Analysis.FrontendSnapshot) =>
  Object.freeze(
    [...self.results.values()].flatMap((result) =>
      result.tir.functions.flatMap((fn) =>
        fn.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .flatMap((expression) =>
            expression._tag === 'Call' && expression.typeArguments.length > 0 ? [expression] : [],
          ),
      ),
    ),
  )

export interface CallInstanceLink {
  readonly call: Extract<Tir.Expression, { readonly _tag: 'Call' }>
  readonly caller: Analysis.Snapshot['instances']['instances'][number]
  readonly target: Analysis.Snapshot['instances']['instances'][number]
}

export const instancesOfCall = (
  self: Analysis.Snapshot,
  call: Extract<Tir.Expression, { readonly _tag: 'Call' }>,
): ReadonlyArray<CallInstanceLink> =>
  Object.freeze(
    self.instances.instances.flatMap((caller): ReadonlyArray<CallInstanceLink> => {
      const ownsCall = caller.function.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .some((expression) => expression === call)
      if (!ownsCall) return []
      const arguments_ = call.typeArguments.map((argument) =>
        Type.substituteGenericArgument(argument, caller.substitution),
      )
      const target = self.instances.instances.find(
        (candidate) =>
          candidate.key.declaration.module === call.target.module &&
          candidate.key.declaration.name === call.target.name &&
          candidate.key.typeArguments.length === arguments_.length &&
          candidate.key.typeArguments.every((argument, index) => {
            const callArgument = arguments_.at(index)
            return (
              callArgument !== undefined &&
              Type.genericArgumentKey(argument) === Type.genericArgumentKey(callArgument)
            )
          }),
      )
      return target === undefined ? [] : [Object.freeze({ call, caller, target })]
    }),
  )

export const suspensionFactsOf = (self: Analysis.Snapshot) => self.instances.suspension

export const provisionalMirOf = (
  self: Analysis.Snapshot,
): Analysis.Targeted<ProvisionalMir.Module> =>
  self.layout._tag === 'Available'
    ? Object.freeze({
        _tag: 'Available',
        value: ProvisionalMir.build(self.instances, self.layout.value, self.index),
      })
    : self.layout

export const suspensionOwnershipOf = (
  self: Analysis.Snapshot,
): Analysis.Targeted<SuspensionOwnership.Module> => {
  if (self.mir._tag === 'Unavailable') return self.mir
  const provisional = provisionalMirOf(self)
  return provisional._tag === 'Unavailable'
    ? provisional
    : Object.freeze({
        _tag: 'Available',
        value: SuspensionOwnership.plan(
          self.mir.value,
          provisional.value,
          self.index,
          OpaqueRealization.catalogOf(self),
        ),
      })
}

export const tirMatchesOf = (self: Analysis.FrontendSnapshot, module: string) =>
  Object.freeze(
    (self.results.get(module)?.tir.functions ?? []).flatMap((fn) =>
      fn.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .flatMap((expression) => (expression._tag === 'Match' ? [expression] : [])),
    ),
  )

export const callingShapeOf = (self: Analysis.Snapshot, type: Type.Type) =>
  self.layout._tag === 'Available' ? Layout.callingShape(self.layout.value, type) : undefined

export interface ControlRegionFact {
  readonly function: DeclarationFacts.CanonicalId
  readonly region: Mir.Region
}

export const controlRegionsOf = (self: Analysis.Snapshot): ReadonlyArray<ControlRegionFact> =>
  self.mir._tag === 'Unavailable'
    ? Object.freeze([])
    : Object.freeze(
        self.mir.value.functions.flatMap((fn) =>
          Mir.topologicalRegions(fn).map((region) => Object.freeze({ function: fn.id, region })),
        ),
      )

export interface ControlEdgeFact {
  readonly function: DeclarationFacts.CanonicalId
  readonly edge: Mir.ControlEdge
}

export const controlEdgesOf = (self: Analysis.Snapshot): ReadonlyArray<ControlEdgeFact> =>
  self.mir._tag === 'Unavailable'
    ? Object.freeze([])
    : Object.freeze(
        self.mir.value.functions.flatMap((fn) =>
          Mir.controlEdges(fn).map((edge) => Object.freeze({ function: fn.id, edge })),
        ),
      )
