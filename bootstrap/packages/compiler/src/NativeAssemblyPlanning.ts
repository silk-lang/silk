import * as Mir from './Mir.js'
import * as NativeAssembly from './NativeAssembly.js'
import * as Type from './Type.js'
import type * as CompilationProfile from './CompilationProfile.js'
import * as Diagnostic from './Diagnostic.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as SourceSpan from './SourceSpan.js'

const diagnostic = (detail: string, span: SourceSpan.SourceSpan): Diagnostic.Diagnostic =>
  Diagnostic.invalidConfiguration(
    ConfigurationError.make('NativeAssemblyPlanning.validate', 'InvalidInput', detail, [
      { ...ConfigurationOrigin.literal(span.sourceId), span },
    ]),
    span,
  )

/** Reports target-specific machine-contract errors before backend construction. */
const assemblyDiagnostics = (program: Mir.Module): ReadonlyArray<Diagnostic.Diagnostic> =>
  program.functions.flatMap((fn) =>
    fn.regions
      .flatMap(Mir.operationsOf)
      .flatMap(Mir.operationTree)
      .flatMap((operation) => {
        if (operation._tag !== 'NativeAssembly') return []
        if (!NativeAssembly.available(program.layout.target))
          return [
            Diagnostic.intrinsicTargetUnavailable(
              'Intrinsic.assembly',
              program.layout.target.id,
              operation.provenance.span,
            ),
          ]
        const operands = operation.arguments.flatMap((argument) => {
          const type = fn.localTypes[argument.ordinal]
          return type === undefined ? [] : [Mir.semanticType(type)]
        })
        return NativeAssembly.violations(
          operation.assembly,
          Mir.semanticType(operation.type),
          operands,
          program.layout.target,
        ).map((detail) =>
          Diagnostic.invalidConfiguration(
            ConfigurationError.make('NativeAssembly.program', 'InvalidInput', detail, [
              {
                ...ConfigurationOrigin.literal(operation.provenance.span.sourceId),
                span: operation.provenance.span,
              },
            ]),
            operation.provenance.span,
          ),
        )
      }),
  )

/** Independently guards the exact naked MIR shape and unavailable instrumentation modes. */
const machineDiagnostics = (
  program: Mir.Module,
  profile: CompilationProfile.Facts | undefined,
): ReadonlyArray<Diagnostic.Diagnostic> =>
  program.functions.flatMap((fn) => {
    const properties = fn.machine
    if (properties === undefined) return []
    const operations = fn.regions.flatMap(Mir.operationsOf)
    const assembly = operations[0]
    if (
      profile === undefined ||
      !NativeAssembly.available(profile.target) ||
      profile.sanitizers.length > 0 ||
      profile.unwind !== 'none'
    )
      return [
        diagnostic('naked function target, unwind or instrumentation profile', properties.span),
      ]
    if (
      fn.parameterCount !== 0 ||
      !Type.equals(Mir.semanticType(fn.result), Type.unit) ||
      operations.length !== 1 ||
      assembly?._tag !== 'NativeAssembly' ||
      !assembly.assembly.noReturn ||
      !assembly.assembly.sideEffects ||
      assembly.arguments.length !== 0 ||
      !Type.equals(Mir.semanticType(assembly.type), Type.unit) ||
      fn.regions.some(
        (region) => region._tag !== 'OperationRegion' || region.outcome._tag !== 'Trap',
      )
    )
      return [
        diagnostic(
          'naked MIR requires one terminal operand-free assembly operation',
          properties.span,
        ),
      ]
    return []
  })

/** Validates retained machine operations and naked bodies against the completed request. */
export const diagnostics = (
  program: Mir.Module,
  profile: CompilationProfile.Facts | undefined,
): ReadonlyArray<Diagnostic.Diagnostic> => [
  ...assemblyDiagnostics(program),
  ...machineDiagnostics(program, profile),
]
