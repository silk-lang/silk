import * as Diagnostic from './Diagnostic.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as ExecutionPackage from './ExecutionPackage.js'
import * as Tir from './Tir.js'
import type {
  CallingScalar,
  Catalog,
  Entry,
  Plan,
  Representation,
  UnavailableEntry,
} from './Layout.js'
import * as Target from './Target.js'
import * as Type from './Type.js'
import * as ValueStorage from './ValueStorage.js'

const representationText = (representation: Representation): string => {
  switch (representation._tag) {
    case 'SignedInteger':
      return `signed-i${representation.bits}`
    case 'UnsignedInteger':
      return `unsigned-i${representation.bits}`
    case 'ScalarEnum':
      return `scalar-enum ${representation.enum.module}.${representation.enum.name} lane=${representation.scalar} bits=${representation.bits} signedness=${representation.signedness.toLowerCase()} members=${representation.members.map((member) => `${member.member.name}=${member.discriminant}`).join(',')}`
    case 'Floating':
      return `float${representation.bits}`
    case 'Boolean':
      return `bool-i${representation.bits} false=${representation.falseValue} true=${representation.trueValue}`
    case 'CallableEnvironment': {
      const target =
        representation.realization.target._tag === 'Declaration'
          ? `${representation.realization.target.module}.${representation.realization.target.name}`
          : `${representation.realization.target.actor}.${representation.realization.target.operation}`
      const environment =
        representation.realization.environment === undefined
          ? 'none'
          : Type.callableEnvironmentKey(representation.realization.environment)
      return `callable-environment target=${target} environment=${environment} tail-padding=${representation.tailPadding}`
    }
    case 'StoredEffectEnvironment':
      return `stored-effect-environment runner=${representation.realization.runner.module}.${representation.realization.runner.name} identity=${representation.realization.runnerIdentity} access=${representation.realization.access.toLowerCase()} suspendable=${representation.realization.suspendable ? 'yes' : 'no'} tail-padding=${representation.tailPadding}`
    case 'Repeated':
      return `repeated element=${Type.encode(representation.element)} length=${representation.length} stride=${representation.stride}`
    case 'Slice':
      return `slice element=${Type.encode(representation.element)} address=i${representation.address.bits}@${representation.address.offset}/${representation.address.size}/${representation.address.alignment} length=usize@${representation.length.offset}/${representation.length.size} address-padding=${representation.addressPadding} tail-padding=${representation.tailPadding} stride=${representation.stride}`
    case 'String':
      return `string storage=${representation.storage.provenance}:i${representation.storage.bits}@${representation.storage.offset}/${representation.storage.size}/${representation.storage.alignment} byte-length=usize@${representation.byteLength.offset}/${representation.byteLength.size} storage-padding=${representation.storagePadding} tail-padding=${representation.tailPadding}`
    case 'Reference':
      return `reference target=${Type.encode(representation.target)} address=i${representation.address.bits}@${representation.address.offset}/${representation.address.size}/${representation.address.alignment}`
    case 'Union':
      return `union tag=i${representation.tag.bits} payload-offset=${representation.payloadOffset} payload-size=${representation.payloadSize} payload-align=${representation.payloadAlignment} tag-padding=${representation.tagPadding} tail-padding=${representation.tailPadding}`
    case 'NominalUnion': {
      const cleanupHook =
        representation.cleanupHook === undefined
          ? 'none'
          : `${representation.cleanupHook.hook.module}.${representation.cleanupHook.hook.name}<${representation.cleanupHook.typeArguments.map(Type.encodeGenericArgument).join(',')}>`
      return `nominal-union ${representation.union.module}.${representation.union.name} tag=i${representation.tag.bits} payload-offset=${representation.payloadOffset} payload-size=${representation.payloadSize} payload-align=${representation.payloadAlignment} tag-padding=${representation.tagPadding} tail-padding=${representation.tailPadding} cleanup-hook=${cleanupHook}`
    }
    case 'Aggregate': {
      const cleanupHook =
        representation.cleanupHook === undefined
          ? 'none'
          : `${representation.cleanupHook.hook.module}.${representation.cleanupHook.hook.name}<${representation.cleanupHook.typeArguments.map(Type.encodeGenericArgument).join(',')}>`
      return `aggregate cleanup-hook=${cleanupHook} tail-padding=${representation.tailPadding}`
    }
  }
}

const entryLines = (candidate: Entry): ReadonlyArray<string> => {
  const header = `layout ${Type.encode(candidate.type)} size=${candidate.size} align=${candidate.alignment} repr=${representationText(candidate.representation)}${candidate.executable === undefined ? '' : ` executable=${candidate.executable._tag.toLowerCase()}`}`
  if (candidate.executable !== undefined) {
    return [
      header,
      ...candidate.executable.fields.map(
        (field) =>
          `  ${candidate.executable?._tag.toLowerCase()}-capture ${field.capture}: ${Type.encode(field.type)} access=${field.access.toLowerCase()} representation=${field.representation.toLowerCase()} offset=${field.offset} size=${field.size} align=${field.alignment} padding=${field.padding}`,
      ),
    ]
  }
  switch (candidate.representation._tag) {
    case 'Aggregate':
      return [
        header,
        ...candidate.representation.fields.map(
          (field) =>
            `  field ${field.id.ordinal} ${field.name}: ${Type.encode(field.type)} offset=${field.offset} size=${field.size} align=${field.alignment} padding=${field.padding}`,
        ),
      ]
    case 'CallableEnvironment':
      return [
        header,
        ...candidate.representation.fields.map(
          (field) =>
            `  capture ${field.ordinal}->p${field.parameterOrdinal}: ${Type.encode(field.type)} access=${field.access.toLowerCase()} representation=${field.representation.toLowerCase()} offset=${field.offset} size=${field.size} align=${field.alignment} padding=${field.padding}`,
        ),
      ]
    case 'StoredEffectEnvironment':
      return [
        header,
        ...candidate.representation.fields.map(
          (field) =>
            `  effect-capture ${field.capture} ${field.source.toLowerCase()}${field.ordinal}: ${Type.encode(field.type)} access=${field.access.toLowerCase()} representation=${field.representation.toLowerCase()} offset=${field.offset} size=${field.size} align=${field.alignment} padding=${field.padding}`,
        ),
      ]
    case 'Repeated':
      return [
        header,
        `  elements ${Type.encode(candidate.representation.element)} count=${candidate.representation.length} stride=${candidate.representation.stride}`,
      ]
    case 'Slice':
      return [
        header,
        `  address Address<${Type.encode(candidate.representation.element)}> bits=${candidate.representation.address.bits} offset=${candidate.representation.address.offset} size=${candidate.representation.address.size} align=${candidate.representation.address.alignment}`,
        `  length usize offset=${candidate.representation.length.offset} size=${candidate.representation.length.size} stride=${candidate.representation.stride}`,
      ]
    case 'String':
      return [
        header,
        `  storage StringUtf8 bits=${candidate.representation.storage.bits} offset=${candidate.representation.storage.offset} size=${candidate.representation.storage.size} align=${candidate.representation.storage.alignment}`,
        `  byte-length usize offset=${candidate.representation.byteLength.offset} size=${candidate.representation.byteLength.size}`,
      ]
    case 'Reference':
      return [
        header,
        `  address Address<${Type.encode(candidate.representation.target)}> bits=${candidate.representation.address.bits} offset=0 size=${candidate.representation.address.size} align=${candidate.representation.address.alignment}`,
      ]
    case 'Union':
      return [
        header,
        ...candidate.representation.members.map(
          (member) =>
            `  member ${member.ordinal} ${Type.encode(member.type)} size=${member.size} align=${member.alignment}`,
        ),
      ]
    case 'NominalUnion':
      return [
        header,
        ...candidate.representation.variants.flatMap((variant) => [
          `  variant ${variant.ordinal} ${variant.variant.name} size=${variant.size} align=${variant.alignment} tail-padding=${variant.tailPadding}`,
          ...variant.fields.map(
            (field) =>
              `    field ${DeclarationFacts.fieldIdKey(field.id)} ${field.name}: ${Type.encode(field.type)} offset=${field.offset} size=${field.size} align=${field.alignment} padding=${field.padding}`,
          ),
        ]),
      ]
    default:
      return [header]
  }
}

/** Deterministic textual encoding of a complete runtime layout plan. */
const callingScalarText = (scalar: CallingScalar): string =>
  typeof scalar === 'string' ? scalar : `Address<${Type.encode(scalar.element)},i${scalar.bits}>`

export const encode = (self: Plan): string =>
  [
    `target ${Target.encode(self.target)}`,
    ...self.entries.flatMap(entryLines),
    ...self.valueStorage.map((view) => `value-storage ${ValueStorage.encode(view)}`),
    ...self.executionPackages.plans.map(ExecutionPackage.encode),
    ...self.executionPackages.unavailable.map(
      (candidate) =>
        `execution-package unavailable target=${candidate.target} specialization=${ExecutionPackage.specializationKey(candidate.specialization)} reason=${candidate.reason}`,
    ),
    ...self.effectEnvironments.map((environment) =>
      environment._tag === 'UnavailableEffectEnvironment'
        ? `effect-environment ${environment.instance.declaration.module}.${environment.instance.declaration.name}@${Tir.executableSiteLabel(environment.site)} unavailable=${environment.reason}`
        : `effect-environment ${environment.instance.declaration.module}.${environment.instance.declaration.name}@${Tir.executableSiteLabel(environment.site)} size=${environment.size} align=${environment.alignment} fields=${environment.fields.map((field) => `${field.source.toLowerCase()}${field.ordinal}:${field.access.toLowerCase()}:${field.representation.toLowerCase()}@${field.offset}`).join(',') || 'none'}`,
    ),
    ...self.callableEnvironments.map((environment) => {
      const callable = environment.callable
      const identity = `${callable.owner.declaration.module}.${callable.owner.declaration.name}@${Tir.executableSiteLabel(callable.site)}`
      return environment._tag === 'UnavailableCallableEnvironment'
        ? `callable-environment ${identity} unavailable=${environment.reason} view=code@${environment.view.codeOffset},env@${environment.view.environmentOffset},size=${environment.view.size}`
        : `callable-environment ${identity} mode=${callable.mode.toLowerCase()} size=${environment.size} align=${environment.alignment} fields=${environment.fields.map((field) => `capture${field.ordinal}->p${field.parameterOrdinal}:${field.access.toLowerCase()}:${field.representation.toLowerCase()}@${field.offset}`).join(',') || 'none'} view=code@${environment.view.codeOffset},env@${environment.view.environmentOffset},size=${environment.view.size}`
    }),
    ...self.callingShapes.map(
      (shape) =>
        `calling ${Type.encode(shape.type)} lanes=${shape.laneCount}${
          shape.laneCount === 0
            ? ''
            : ` ${shape.lanes
                .map(
                  (lane) =>
                    `${callingScalarText(lane.type)}[${lane.path
                      .map((selector) => {
                        switch (selector._tag) {
                          case 'ElementSelector':
                            return `[${selector.index}]`
                          case 'CallableCaptureSelector':
                            return `capture[${selector.ordinal}]`
                          case 'EffectCaptureSelector':
                            return `effect-capture[${selector.ordinal}]`
                          case 'UnionTagSelector':
                            return 'tag'
                          case 'UnionPayloadSelector':
                            return `payload[${selector.slot}]`
                          case 'NominalUnionTagSelector':
                            return 'nominal-tag'
                          case 'NominalUnionPayloadSelector':
                            return `nominal-payload[${selector.slot}]`
                          case 'SliceAddressSelector':
                          case 'ReferenceAddressSelector':
                            return 'address'
                          case 'SliceLengthSelector':
                            return 'length'
                          case 'StringStorageSelector':
                            return 'storage'
                          case 'StringByteLengthSelector':
                            return 'byte-length'
                          case 'FieldId':
                            return DeclarationFacts.fieldIdKey(selector)
                          default:
                            return ''
                        }
                      })
                      .join('.')}]`,
                )
                .join(',')}`
        }`,
    ),
    ...(self.staticData ?? []).map(
      (placement) =>
        `static-data ${placement.data.id} bytes=${placement.data.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')} align=${placement.alignment} address=i${placement.addressBits} length=usize:i${placement.lengthBits}`,
    ),
    ...self.literalVerdicts.map(
      (verdict) =>
        `${verdict.type}-literal ${verdict.value.toString()} bits=${verdict.bits} ${verdict._tag === 'AvailableWordLiteral' ? 'available' : `unavailable cause=${verdict.cause.code}`} [${verdict.span.start}, ${verdict.span.end})`,
    ),
    '',
  ].join('\n')

const unavailableText = (candidate: UnavailableEntry): string => {
  const reason =
    candidate.reason._tag === 'UnavailableDependency'
      ? `dependency=${Type.encode(candidate.reason.dependency)}`
      : `detail=${JSON.stringify(candidate.reason.detail)}`
  const cause =
    candidate.cause === undefined
      ? ''
      : ` cause=${candidate.cause.code}@${Diagnostic.causeLabel(candidate.cause)}`
  return `layout ${Type.encode(candidate.type)} unavailable reason=${candidate.reason._tag} ${reason}${cause}`
}

/** Deterministic textual encoding of every nominal catalog fact. */
export const encodeCatalog = (self: Catalog): string =>
  [
    `target ${Target.encode(self.target)}`,
    ...self.entries.flatMap((candidate) =>
      candidate._tag === 'LayoutEntry' ? entryLines(candidate) : [unavailableText(candidate)],
    ),
    ...self.wordConstants.map(
      (constant) =>
        `${constant.type}-constant ${constant.value.toString()} [${constant.span.sourceId}:${constant.span.start}, ${constant.span.end})`,
    ),
    '',
  ].join('\n')
