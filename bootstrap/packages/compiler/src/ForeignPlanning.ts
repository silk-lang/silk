/**
 * Executable-wide planning checks for native exports (`export "C"`) over `Mir.Module`, run at the
 * same gates as `ForeignAvailability.select` before any backend is constructed: the closure-wide
 * symbol map over imports and exports, the non-native rejection, and the post-MIR suspension
 * restriction.
 */
import * as Diagnostic from './Diagnostic.js'
import * as CAbi from './CAbi.js'
import * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as Target from './Target.js'

/**
 * Reports one conflicting-foreign-signature diagnostic per export whose symbol an import or an
 * earlier export already claims, one target-unavailable diagnostic per export off a native
 * target, and one export-suspends diagnostic per export whose MIR function is not synchronous.
 * Matching data imports share a symbol; definitions and incompatible C value types still collide.
 */
export const check = (
  program: Mir.Module,
  target: Target.Target,
): ReadonlyArray<Diagnostic.Diagnostic> => {
  const surface = target.id
  const claimed = new Map<
    string,
    { readonly span: SourceSpan.SourceSpan; readonly importedDataType?: string }
  >(program.foreignCalls.map((call) => [call.symbol, { span: call.declarationSpan }]))
  const callbackAddresses = program.functions.flatMap((fn) =>
    MirVerification.operations(fn).filter(
      (operation) => operation._tag === 'ForeignFunctionAddress',
    ),
  )
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  if (target.kind !== 'Native')
    for (const fn of program.functions)
      for (const operation of MirVerification.operations(fn))
        if (operation._tag === 'ForeignIndirectCall')
          diagnostics.push(
            Diagnostic.foreignFunctionTargetUnavailable(
              'indirect C address',
              surface,
              operation.provenance.span,
            ),
          )
  for (const record of program.foreignExports) {
    const other = claimed.get(record.symbol)
    if (other === undefined) claimed.set(record.symbol, { span: record.declarationSpan })
    else
      diagnostics.push(
        Diagnostic.conflictingForeignSignature(record.symbol, record.declarationSpan, other.span),
      )
    if (!CAbi.available(target, record.signature))
      diagnostics.push(
        Diagnostic.foreignFunctionTargetUnavailable(record.symbol, surface, record.declarationSpan),
      )
    const fn = program.functions.find((candidate) => Mir.matchesInstanceKey(candidate, record.key))
    if (fn?.suspension !== undefined && fn.suspension.classification !== 'Synchronous') {
      diagnostics.push(
        Diagnostic.exportSuspends(
          record.symbol,
          record.declarationSpan,
          fn.suspension.regions.at(0)?.provenance.span,
        ),
      )
      for (const callback of callbackAddresses) {
        if (
          callback.target._tag === 'DeclarationCallableTarget' &&
          callback.target.declaration.module === record.declaration.module &&
          callback.target.declaration.name === record.declaration.name
        )
          diagnostics.push(
            Diagnostic.invalidForeignCallback(
              record.declaration.name,
              'the exported function may suspend and has no synchronous C callback address',
              callback.provenance.span,
            ),
          )
      }
    }
  }
  for (const record of program.foreignStatics) {
    const other = claimed.get(record.symbol)
    const importedDataType =
      record.direction === 'Import'
        ? CAbi.typeText(CAbi.classify(record.type, target, 'Parameter'))
        : undefined
    if (other === undefined)
      claimed.set(record.symbol, {
        span: record.declarationSpan,
        ...(importedDataType === undefined ? {} : { importedDataType }),
      })
    else if (importedDataType === undefined || other.importedDataType !== importedDataType)
      diagnostics.push(
        Diagnostic.conflictingForeignSignature(record.symbol, record.declarationSpan, other.span),
      )
  }
  return Diagnostic.merge(diagnostics)
}
