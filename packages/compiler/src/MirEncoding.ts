import * as Lifetime from './Lifetime.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as NativeAssembly from './NativeAssembly.js'
import * as Instances from './Instances.js'
import * as CAbi from './CAbi.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as ExecutionTransition from './ExecutionTransition.js'
import * as LayoutEncode from './LayoutEncode.js'
import * as Match from './Match.js'
import * as MovePath from './MovePath.js'
import * as StaticValue from './StaticValue.js'
import * as Tir from './Tir.js'
import type {
  CoroutineFramePathPlan,
  CancellationFinalizer,
  Execution,
  LocalId,
  LoopId,
  MirFunction,
  Module,
  Operation,
  Outcome,
  PlaceSelector,
  Provenance,
  Region,
  RegionId,
} from './Mir.js'
import { semanticType as mirSemanticType, topologicalRegions, typeText } from './Mir.js'
import {
  callableTargetText,
  coroutineFrameReleaseText,
  instanceText,
  storedExecutableText,
  suspensionBorrowText,
  targetText,
} from './MirVerification.js'
import type * as SourceSpan from './SourceSpan.js'
import type { SuspensionPointId, SuspensionRunner } from './Suspension.js'
import * as SilkType from './Type.js'

const spanText = (span: SourceSpan.SourceSpan): string => `[${span.start}, ${span.end})`
const provenanceText = (provenance: Provenance): string =>
  `${spanText(provenance.span)}${provenance.generated ? ' generated' : ''}`
const localText = (local: LocalId): string => `%${local.ordinal}`
const regionText = (region: RegionId): string => `r${region.ordinal}`
const loopText = (loop: LoopId): string => `loop${loop.ordinal}`
const cancellationFinalizerText = (finalizer: CancellationFinalizer): string =>
  finalizer._tag === 'EffectCancellationFinalizer'
    ? `${localText(finalizer.effect)}:${targetText(finalizer.runner)}(${finalizer.arguments.map(localText).join(',') || 'none'})`
    : `resource=${localText(finalizer.resource)} release=${localText(finalizer.release)} builder=${targetText(finalizer.releaseTarget)} runner=${targetText(finalizer.runner)}(${finalizer.arguments.map(localText).join(',') || 'none'})`
const selectorText = (selectors: ReadonlyArray<PlaceSelector>): string =>
  selectors
    .map((selector) => {
      if (selector._tag === 'FieldSelector') return `.#${selector.field.ordinal}`
      if (selector._tag === 'VariantSelector') return `.variant#${selector.ordinal}`
      if (selector._tag === 'SliceElementSelector') {
        return `[${localText(selector.index)}/slice:${selector.access.toLowerCase()}]`
      }
      const index =
        selector.index._tag === 'Proven' ? selector.index.value : localText(selector.index.local)
      return `[${index}/${selector.length}]`
    })
    .join('')

const invocationUseText = (
  usage: Extract<Operation, { readonly _tag: 'Call' | 'ApplyCallable' }>['invocationUse'],
): string =>
  usage === undefined
    ? ''
    : ` invocation=${usage.kind.toLowerCase()}:${AuthoredIdentity.anchorKey(usage.origin)} binder=${Lifetime.key(usage.binder)} region=${Lifetime.key(usage.lifetime)} inputs=${usage.inputs.map((input) => `p${input.parameter}:${localText(input.argument)}${input.capture === undefined ? '' : `.#${input.capture}`}${input.capturePath === undefined ? '' : ` via=${input.capturePath.map((step) => `${step._tag.toLowerCase()}@${Tir.executableSiteLabel(step.site)}${step._tag === 'Capture' ? `.#${step.ordinal}` : ''}`).join('/')}`}${input.producer === undefined ? '' : ` producer=${Tir.nodeRefKey(input.producer)}`}${input.header === undefined ? '' : ` header=p${input.header.parameter}@${AuthoredIdentity.anchorKey(input.header.source)}`}:${SilkType.encode(input.type)}`).join(',')} result=${localText(usage.result)}`

const operationText = (operation: Operation): string => {
  switch (operation._tag) {
    case 'SetInitialized':
      return `${localText(operation.flag)} = initialized ${operation.initialized} ${provenanceText(operation.provenance)}`
    case 'ForeignStaticLoad':
      return `${localText(operation.destination)} = foreign-static ${operation.direction.toLowerCase()} ${operation.symbol} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ForeignFunctionAddress':
      return `${localText(operation.destination)} = foreign-address ${operation.symbol} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'Literal':
      return `${localText(operation.destination)} = literal ${operation.value} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'EnumConstant':
      return `${localText(operation.destination)} = enum-member ${operation.member.enum.module}.${operation.member.enum.name}.${operation.member.name} discriminant=${operation.discriminant} lane=${operation.representation.scalar} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'EnumValue':
      return `${localText(operation.destination)} = enum-value ${localText(operation.source)} ${operation.enum.module}.${operation.enum.name} lane=${operation.representation.scalar} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'EnumEquality':
      return `${localText(operation.destination)} = enum-${operation.negated ? 'not-equals' : 'equals'} ${localText(operation.left)}, ${localText(operation.right)} ${operation.enum.module}.${operation.enum.name} lane=${operation.representation.scalar} : bool ${provenanceText(operation.provenance)}`
    case 'StaticView':
      return `${localText(operation.destination)} = static-view ${operation.data} length=${operation.length} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'StaticString':
      return `${localText(operation.destination)} = static-string ${operation.data} byte-length=${operation.byteLength} : string ${provenanceText(operation.provenance)}`
    case 'StringFromUtf8Unchecked':
      return `${localText(operation.destination)} = string-from-utf8-unchecked ${localText(operation.bytes)} loans=${operation.heldLoans.map((borrow) => `l${borrow.ordinal}`).join(',') || 'none'} authorization=${operation.authorization.toLowerCase()} : string ${provenanceText(operation.provenance)}`
    case 'StringUtf8Bytes':
      return `${localText(operation.destination)} = string-utf8-bytes ${localText(operation.string)} loans=${operation.heldLoans.map((borrow) => `l${borrow.ordinal}`).join(',') || 'none'} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'StringByteLength':
      return `${localText(operation.destination)} = string-byte-length ${localText(operation.string)} : usize ${provenanceText(operation.provenance)}`
    case 'StringEqualsExact':
      return `${localText(operation.destination)} = string-${operation.negated ? 'not-equals-exact' : 'equals-exact'} ${localText(operation.left)}, ${localText(operation.right)} : bool ${provenanceText(operation.provenance)}`
    case 'PackEffectComposite':
      return `${localText(operation.destination)} = effect-composite alternative=${operation.alternative} ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'UnpackEffectComposite':
      return `${localText(operation.destination)}, ${localText(operation.matched)} = effect-choice alternative=${operation.alternative} ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'Binary':
      return `${localText(operation.destination)} = ${operation.operator.toLowerCase()} ${localText(operation.left)}, ${localText(operation.right)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ConvertInteger':
      return `${localText(operation.destination)} = convert ${localText(operation.source)} ${typeText(operation.sourceType)} -> ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ConvertScalar':
      return `${localText(operation.destination)} = convert-scalar ${localText(operation.source)} ${typeText(operation.sourceType)} -> ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ReinterpretScalar':
      return `${localText(operation.destination)} = reinterpret ${localText(operation.source)} ${typeText(operation.sourceType)} -> ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'FloatUnary':
      return `${localText(operation.destination)} = ${operation.operation.toLowerCase()} ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'FloatTranscendental':
      return `${localText(operation.destination)} = float-${operation.operation.toLowerCase()} ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'CheckedScalar':
      return `${localText(operation.destination)} = ${operation.operation.toLowerCase()} ${operation.operands.map(localText).join(', ')} ${typeText(operation.sourceType)} -> ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ValidateLayout':
      return `${localText(operation.destination)} = layout-make bytes=${localText(operation.bytes)} alignment=${localText(operation.alignment)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RepeatLayout':
      return `${localText(operation.destination)} = layout-repeat ${localText(operation.layout)} count=${localText(operation.count)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'Allocate':
      return `${localText(operation.destination)} = allocate ${localText(operation.layout)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'NativeAssembly':
      return `${localText(operation.destination)} = assembly ${NativeAssembly.encode(operation.assembly)}(${operation.arguments.map(localText).join(', ')}) : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ForeignIndirectCall':
      return `${localText(operation.destination)} = foreign-indirect-call ${localText(operation.callee)} signature=${CAbi.signatureKey(operation.signature)}(${operation.arguments.map(localText).join(', ')}) : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ForeignCall':
      return `${localText(operation.destination)} = foreign-call ${operation.symbol} abi=${operation.abi} signature=${CAbi.signatureKey(operation.signature)}${operation.variadicArguments.length === 0 ? '' : ` tail=[${operation.variadicArguments.map((argument) => `${CAbi.typeText(argument.source)}->${CAbi.typeText(argument.promoted)}`).join(',')}]`}(${operation.arguments.map(localText).join(', ')}) : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RawBufferFrom':
      return `${localText(operation.destination)} = raw-buffer-from ${localText(operation.allocation)} count=${localText(operation.count)} element=${SilkType.encode(operation.element)} stride=${operation.stride} align=${operation.elementAlignment} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'SharedFromAllocation':
      return `${localText(operation.destination)} = shared-from-allocation ${localText(operation.allocation)}:${operation.allocationAccess.toLowerCase()}, ${localText(operation.value)}:${operation.valueAccess.toLowerCase()} element=${SilkType.encode(operation.element)} layout=${operation.block.provenance} allocation-layout=${operation.allocationBlock.provenance} allocation-fact=${operation.allocationFact} allocation-origin=${spanText(operation.allocationProvenance)} count=1 access=available : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ExecutionFromAllocation':
      return `${localText(operation.destination)} = execution-from-allocation ${localText(operation.allocation)}:take, ${localText(operation.body)}:take, ${localText(operation.endpoint)}:take, ${localText(operation.callback)}:take package=${operation.plan.provenance} allocation-fact=${operation.allocationFact} allocation-origin=${spanText(operation.allocationProvenance)} state=initial : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ExecutionDrive':
      return `${localText(operation.destination)} = execution-drive ${localText(operation.execution)}:take branch=${localText(operation.branch)}:take complete=${localText(operation.onComplete)}:take/${operation.completionCleanup._tag}<${operation.completionTypeArguments.map(SilkType.genericArgumentKey).join(',')}> suspend=${localText(operation.onSuspend)}:take/${operation.suspensionCleanup._tag}<${operation.suspensionTypeArguments.map(SilkType.genericArgumentKey).join(',')}> private-result=${localText(operation.result)} legal=initial|initial-ready|eligible trap=dormant|notifying result=unit ${provenanceText(operation.provenance)}`
    case 'ExecutionNotifyInitial':
      return `${localText(operation.destination)} = execution-notify-initial ${localText(operation.execution)}:exclusive transition=initial>initial-ready result=unit ${provenanceText(operation.provenance)}`
    case 'ExecutionWake':
      return `${localText(operation.destination)} = execution-wake ${localText(operation.wake)}:take transition=latched|notifying|cancelled-noop result=unit ${provenanceText(operation.provenance)}`
    case 'ExecutionPark':
      return `${localText(operation.destination)} = execution-park register=${localText(operation.register)}:take/${operation.registerCleanup._tag}<${operation.registrationTypeArguments.map(SilkType.genericArgumentKey).join(',')}> private-guard=${localText(operation.guard)}/${operation.guardCleanup._tag} transition=registering>latched|dormant result=unit ${provenanceText(operation.provenance)}`
    case 'SharedClone':
      return `${localText(operation.destination)} = shared-clone ${localText(operation.self)} element=${SilkType.encode(operation.element)} layout=${operation.block.provenance} maximum=${operation.block.strongMaximum} transition=compare-trap-store : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'SharedWithMut':
      return `${localText(operation.destination)} = shared-with-mut ${localText(operation.self)} payload=${localText(operation.payload)} loan=l${operation.loan.ordinal} use=${localText(operation.use)}:${operation.useType.mode.toLowerCase()} conflict=${localText(operation.onConflict)}:${operation.conflictType.mode.toLowerCase()} element=${SilkType.encode(operation.element)} layout=${operation.block.provenance} result=${SilkType.encode(mirSemanticType(operation.type))} retained-loans=${operation.retainedLoans.map((loan) => `l${loan.ordinal}`).join(',') || 'none'} use-cleanup=${operation.useCleanup._tag} conflict-cleanup=${operation.conflictCleanup._tag} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RawBufferCount':
      return `${localText(operation.destination)} = raw-buffer-count ${localText(operation.buffer)} : usize ${provenanceText(operation.provenance)}`
    case 'RawBufferSlot':
      return `${localText(operation.destination)} = raw-buffer-slot ${localText(operation.buffer)}[${localText(operation.index)}] element=${SilkType.encode(operation.element)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RawBufferRead':
      return `${localText(operation.destination)} = raw-buffer-read ${localText(operation.buffer)}[${localText(operation.index)}] element=${SilkType.encode(operation.element)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'SliceView':
      return `${localText(operation.destination)} = slice-view ${localText(operation.slice)} offset=${localText(operation.offset)} length=${localText(operation.length)} stride=${operation.stride} loans=${operation.heldLoans.map((loan) => `l${loan.ordinal}`).join(',') || 'none'} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RawBufferView':
      return `${localText(operation.destination)} = raw-buffer-view ${localText(operation.buffer)} offset=${localText(operation.offset)} length=${localText(operation.length)} element=${SilkType.encode(operation.element)} access=${operation.access.toLowerCase()} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RawBufferCopy':
      return `${localText(operation.destination)} = raw-buffer-copy ${localText(operation.buffer)} offset=${localText(operation.offset)} source=${localText(operation.source)} length=${localText(operation.length)} element=${SilkType.encode(operation.element)} stride=${operation.stride} retains-source=${operation.retainsSource} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RawBufferFill':
      return `${localText(operation.destination)} = raw-buffer-fill ${localText(operation.buffer)} offset=${localText(operation.offset)} length=${localText(operation.length)} value=${localText(operation.value)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'DiagnosticUnhandled':
      return `${localText(operation.destination)} = diagnostic-unhandled : usize ${provenanceText(operation.provenance)}`
    case 'PointerNull':
      return `${localText(operation.destination)} = pointer-null : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PointerIsNull':
      return `${localText(operation.destination)} = pointer-is-null ${localText(operation.pointer)} : bool ${provenanceText(operation.provenance)}`
    case 'PointerAddress':
      return `${localText(operation.destination)} = pointer-address ${localText(operation.pointer)} : usize ${provenanceText(operation.provenance)}`
    case 'PointerBytes':
      return `${localText(operation.destination)} = pointer-bytes ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PointerReinterpret':
      return `${localText(operation.destination)} = pointer-reinterpret ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PointerRequalify':
      return `${localText(operation.destination)} = pointer-requalify ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PointerFromStorage':
      return `${localText(operation.destination)} = pointer-from-storage ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PointerAt':
      return `${localText(operation.destination)} = pointer-at ${localText(operation.pointer)} count=${localText(operation.count)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PointerRead':
      return `${localText(operation.destination)} = pointer-read ${localText(operation.pointer)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PointerWrite':
      return `${localText(operation.destination)} = pointer-write ${localText(operation.pointer)}, ${localText(operation.value)} : () ${provenanceText(operation.provenance)}`
    case 'SlotWrite':
      return `${localText(operation.destination)} = slot-write ${localText(operation.slot)}, ${localText(operation.value)} element=${SilkType.encode(operation.element)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'SlotTake':
      return `${localText(operation.destination)} = slot-take ${localText(operation.slot)} element=${SilkType.encode(operation.element)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'SlotCopy':
      return `${localText(operation.destination)} = slot-copy ${localText(operation.slot)} element=${SilkType.encode(operation.element)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'SlotDrop':
      return `${localText(operation.destination)} = slot-drop ${localText(operation.slot)} element=${SilkType.encode(operation.element)} cleanup=${operation.cleanup._tag} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'Move':
      return `${localText(operation.destination)} = move ${localText(operation.source)} ${provenanceText(operation.provenance)}`
    case 'BeginLoan':
      return `${localText(operation.destination)} = begin-loan l${operation.borrow.ordinal} ${operation.access.toLowerCase()} ${localText(operation.root)}${selectorText(operation.selectors)} source=${typeText(operation.sourceType)} : ${typeText(operation.type)} reborrow=${operation.reborrow} suspended=${operation.suspendsParent} ${provenanceText(operation.provenance)}`
    case 'EndLoan':
      return `end-loan l${operation.borrow.ordinal} ${localText(operation.slice)} ${provenanceText(operation.provenance)}`
    case 'SliceLength':
      return `${localText(operation.destination)} = slice-length ${localText(operation.slice)} : i32 ${provenanceText(operation.provenance)}`
    case 'ConvertUnion':
      return `${localText(operation.destination)} = union-${operation.conversion.toLowerCase()} ${localText(operation.source)} ${typeText(operation.sourceType)} -> ${typeText(operation.targetType)} access=${operation.access} mapping=${operation.mappings.map((mapping) => `${SilkType.encode(mapping.source)}#${mapping.sourceOrdinal}->${SilkType.encode(mapping.target)}#${mapping.targetOrdinal}`).join(',')} ${provenanceText(operation.provenance)}`
    case 'Call':
      return `${localText(operation.destination)} = call ${targetText(operation.target)}${
        operation.typeArguments.length === 0
          ? ''
          : `<${operation.typeArguments.map(SilkType.encodeGenericArgument).join(', ')}>`
      }(${operation.arguments.map(localText).join(', ')}) : ${typeText(operation.type)} ${provenanceText(operation.provenance)}${invocationUseText(operation.invocationUse)}`
    case 'MakeEffect':
      return `${localText(operation.destination)} = make-effect ${targetText(operation.runner)} captures=${operation.captures.map((capture) => `${localText(capture.source)}:${capture.access.toLowerCase()}`).join(',') || 'none'} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}${invocationUseText(operation.invocationSource?.invocationUse)}`
    case 'MakeCallable':
      return `${localText(operation.destination)} = make-callable ${callableTargetText(operation.target)}${operation.base === undefined ? '' : ` base=${localText(operation.base)}`} captures=${operation.captures.map((capture) => `#${capture.ordinal}->p${capture.parameterOrdinal}:${localText(capture.source)}:${capture.access.toLowerCase()}`).join(',') || 'none'} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ApplyCallable': {
      let target = '?'
      if (operation.callable !== undefined) target = localText(operation.callable)
      else if (operation.target !== undefined) target = callableTargetText(operation.target)
      return `${localText(operation.destination)} = apply-callable ${target}(${operation.arguments.map(localText).join(', ')}) captures=${operation.captures.map((capture) => `#${capture.ordinal}:${localText(capture.source)}`).join(',') || 'none'} access=${operation.access.toLowerCase()} evaluation=${operation.evaluation} realization=${operation.realization} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}${invocationUseText(operation.invocationUse)}`
    }
    case 'PackEffectOutcome':
      return `${localText(operation.destination)} = effect-outcome tag=${operation.tag} ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PackEffectFailureUnion':
      return `${localText(operation.destination)} = effect-failure-union ${localText(operation.source)} mappings=${operation.mappings.map((mapping) => `${mapping.source}->${mapping.target}`).join(',')} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'PropagateEffectFailure':
      return `propagate-effect-failure ${localText(operation.source)} outcome=${localText(operation.outcome)} mappings=${operation.tagMappings.map((mapping) => `${mapping.source}->${mapping.target}`).join(',')} : ${typeText(operation.propagationType)} ${operation.releases === undefined || operation.releases.length === 0 ? '' : `releases=${operation.releases.map((release) => localText(release.local)).join(',')} `}${provenanceText(operation.provenance)}`
    case 'UnpackEffectSuccess':
      return `${localText(operation.destination)} = effect-success ${localText(operation.source)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RunEffect':
      return `${localText(operation.destination)} = run-effect ${targetText(operation.target)} propagate=${operation.tagMappings.map((mapping) => `${mapping.source}->${mapping.target}`).join(',')} : ${typeText(operation.type)} ${operation.failureLoanEnds === undefined || operation.failureLoanEnds.length === 0 ? '' : `failure-loans=${operation.failureLoanEnds.map((ending) => `l${ending.borrow.ordinal}:${localText(ending.slice)}`).join(',')} `}${operation.releases === undefined || operation.releases.length === 0 ? '' : `releases=${operation.releases.map((release) => localText(release.local)).join(',')} `}${provenanceText(operation.provenance)}`
    case 'RunEffectValue':
      return `${localText(operation.destination)} = run-effect-value ${localText(operation.effect)} runner=${targetText(operation.runner)}${operation.runnerBase === undefined ? '' : ` base=${targetText(operation.runnerBase.declaration)}`} providers=${operation.providers.map((provider) => `${SilkType.encode(provider.capability)}@${provider.role}:${provider.requirementAccess.toLowerCase()}:${provider.access.toLowerCase()}`).join(',') || 'none'} arguments=${operation.arguments.map(localText).join(',') || 'none'}${operation.cancellationFinalizer === undefined ? '' : ` cancel-finalizer=${cancellationFinalizerText(operation.cancellationFinalizer)}`} propagate=${operation.tagMappings.map((mapping) => `${mapping.source}->${mapping.target}`).join(',')} : ${typeText(operation.type)} ${operation.failureLoanEnds === undefined || operation.failureLoanEnds.length === 0 ? '' : `failure-loans=${operation.failureLoanEnds.map((ending) => `l${ending.borrow.ordinal}:${localText(ending.slice)}`).join(',')} `}${operation.releases === undefined || operation.releases.length === 0 ? '' : `releases=${operation.releases.map((release) => localText(release.local)).join(',')} `}${provenanceText(operation.provenance)}`
    case 'RunEffectComposite':
      return `${localText(operation.destination)} = run-effect-composite ${localText(operation.effect)} alternatives=${operation.alternatives.map((alternative) => `${targetText(alternative.runner)}${alternative.runnerStaticArguments === undefined ? '' : `[${alternative.runnerStaticArguments.map(StaticValue.key).join(',')}]`}`).join(',')} arguments=${operation.arguments.map(localText).join(',') || 'none'} propagate=${operation.tagMappings.map((mapping) => `${mapping.source}->${mapping.target}`).join(',')} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'RunStaticEffect':
      return `${localText(operation.destination)} = run-static-effect runner=${targetText(operation.runner)} captures=${operation.captures.map((capture) => `${localText(capture.source)}:${capture.access.toLowerCase()}`).join(',') || 'none'} arguments=${operation.arguments.map(localText).join(',') || 'none'} propagate=${operation.tagMappings.map((mapping) => `${mapping.source}->${mapping.target}`).join(',')} : ${typeText(operation.type)} ${operation.failureLoanEnds === undefined || operation.failureLoanEnds.length === 0 ? '' : `failure-loans=${operation.failureLoanEnds.map((ending) => `l${ending.borrow.ordinal}:${localText(ending.slice)}`).join(',')} `}${operation.releases === undefined || operation.releases.length === 0 ? '' : `releases=${operation.releases.map((release) => localText(release.local)).join(',')} `}${provenanceText(operation.provenance)}`
    case 'CatchEffect':
      return `${localText(operation.destination)} = catch-effect ${localText(operation.effect)} runner=${targetText(operation.runner)} arguments=${operation.arguments.map(localText).join(',') || 'none'}${operation.cancellationFinalizer === undefined ? '' : ` cancel-finalizer=${cancellationFinalizerText(operation.cancellationFinalizer)}`} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'Construct':
      return `${localText(operation.destination)} = construct ${typeText(operation.type)} { ${operation.fields.map(({ field, value, stored }) => `#${field.ordinal}: ${localText(value)}${stored === undefined ? '' : ` stored=${storedExecutableText(stored)}`}`).join(', ')} } ${provenanceText(operation.provenance)}`
    case 'ConstructUnionVariant':
      return `${localText(operation.destination)} = construct-variant ${typeText(operation.type)}.${operation.variant.name}#${operation.variantOrdinal} { ${operation.fields.map(({ field, value, stored }) => `${DeclarationFacts.fieldIdKey(field)}: ${localText(value)}${stored === undefined ? '' : ` stored=${storedExecutableText(stored)}`}`).join(', ')} } ${provenanceText(operation.provenance)}`
    case 'ConstructArray':
      return `${localText(operation.destination)} = construct-array ${typeText(operation.type)} [${operation.elements.map(localText).join(', ')}] ${provenanceText(operation.provenance)}`
    case 'Project':
      return `${localText(operation.destination)} = project ${localText(operation.source)}.#${operation.field.ordinal} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ReadPlace':
      return `${localText(operation.destination)} = read-place${operation.consume === true ? ' consume' : ''} ${localText(operation.root)}${selectorText(operation.selectors)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'CheckPlace':
      return `check-place ${localText(operation.root)}${selectorText(operation.selectors)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'WritePlace':
      return `write-place ${localText(operation.root)}${selectorText(operation.selectors)} <- ${localText(operation.source)} : ${typeText(operation.type)} replacement=${operation.replacement} commit=${operation.commit} ${provenanceText(operation.provenance)}`
    case 'Drop':
      return `drop ${localText(operation.local)}${selectorText(operation.selectors ?? [])}${operation.initialization === undefined ? '' : ` initialized=${MovePath.encodeState(operation.initialization.state)} flags=${operation.initialization.flags.map((flag) => `${MovePath.key(flag.path)}:${localText(flag.local)}`).join(',')}`}${operation.cleanup._tag === 'NoCleanup' ? '' : ` cleanup=${operation.cleanup._tag}`}${operation.localShared === undefined ? '' : ` element=${SilkType.encode(operation.localShared.element)} layout=${operation.localShared.block.provenance} transition=decrement-or-cleanup-release`} ${provenanceText(operation.provenance)}`
    case 'Match':
      return `${operation.destination === undefined ? 'never' : localText(operation.destination)} = match#${Tir.nodeRefKey(operation.id.node)} ${operation.access.toLowerCase()} ${localText(operation.scrutinee)}${selectorText(operation.selectors ?? [])} : ${typeText(operation.scrutineeType)} -> ${typeText(operation.type)}${operation.retainsBindings ? ' retain-bindings' : ''} ${provenanceText(operation.provenance)}`
    case 'DiagnosticScope':
      return `${localText(operation.destination)} = diagnostic-scope state=${localText(operation.state)} observer=${localText(operation.observer)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'Conditional':
      return `${localText(operation.destination)} = conditional ${localText(operation.condition)} : ${typeText(operation.type)} ${provenanceText(operation.provenance)}`
    case 'ShortCircuit':
      return `${localText(operation.destination)} = short-circuit ${operation.operator === 'And' ? '&&' : '||'} ${localText(operation.left)} : bool ${provenanceText(operation.provenance)}`
  }
}

const fieldPathText = (path: ReadonlyArray<DeclarationFacts.FieldId>): string =>
  path.length === 0 ? 'payload' : path.map((field) => `#${field.ordinal}`).join('.')

const recoveryText = (execution: Execution): string =>
  execution.recoveryOutcome === undefined
    ? ''
    : ` recovery=${localText(execution.recoveryOutcome)}${
        execution.recoveryInvocation === undefined
          ? ''
          : ` recipe=${AuthoredIdentity.anchorKey(execution.recoveryInvocation.origin)} binder=${Lifetime.key(execution.recoveryInvocation.binder)} region=${Lifetime.key(execution.recoveryInvocation.lifetime)} selected=${SilkType.encode(execution.recoveryInvocation.selected)}`
      }`

const operationLines = (operation: Operation, indent: string): ReadonlyArray<string> => {
  if (operation._tag === 'DiagnosticScope') {
    return [
      `${indent}${operationText(operation)}`,
      ...topologicalRegions(operation.body)
        .flatMap(regionLines)
        .map((line) => `${indent}  ${line}`),
    ]
  }
  if (operation._tag === 'Conditional') {
    return [
      `${indent}${operationText(operation)}`,
      `${indent}  taken -> ${operation.taken.result === undefined ? 'never' : localText(operation.taken.result)}${recoveryText(operation.taken)}`,
      ...topologicalRegions(operation.taken)
        .flatMap(regionLines)
        .map((line) => `${indent}  ${line}`),
      `${indent}  otherwise -> ${operation.otherwise.result === undefined ? 'never' : localText(operation.otherwise.result)}${recoveryText(operation.otherwise)}`,
      ...topologicalRegions(operation.otherwise)
        .flatMap(regionLines)
        .map((line) => `${indent}  ${line}`),
    ]
  }
  if (operation._tag === 'ShortCircuit') {
    return [
      `${indent}${operationText(operation)}`,
      `${indent}  right -> ${operation.right.result === undefined ? 'never' : localText(operation.right.result)}${recoveryText(operation.right)}`,
      ...topologicalRegions(operation.right)
        .flatMap(regionLines)
        .map((line) => `${indent}  ${line}`),
    ]
  }
  if (operation._tag !== 'Match') return [`${indent}${operationText(operation)}`]
  return [
    `${indent}${operationText(operation)}`,
    `${indent}  members ${operation.members.map(Match.encodeIdentity).join(', ')}`,
    ...operation.decisions.map(
      (decision) =>
        `${indent}  decision ${Match.encodeIdentity(decision.member)} candidates=${decision.candidates.map((candidate) => `#${candidate.ordinal}`).join(',')}`,
    ),
    ...operation.arms.flatMap((arm) => {
      let pattern = 'unknown'
      if (arm.universal) pattern = '_'
      else if (arm.member !== undefined) pattern = Match.encodeIdentity(arm.member)
      return [
        `${indent}  arm #${arm.id.ordinal} ${pattern} before=${arm.before.map(Match.encodeIdentity).join(',') || 'empty'} after=${arm.after.map(Match.encodeIdentity).join(',') || 'empty'} ${provenanceText(arm.provenance)}`,
        ...(arm.tests ?? []).map(
          (test) =>
            `${indent}    test ${fieldPathText(test.path)} is ${Match.encodeIdentity(test.member)}`,
        ),
        ...arm.bindings.map(
          (binding) =>
            `${indent}    bind #${binding.id.ordinal} ${localText(binding.destination)} <- ${fieldPathText(binding.path)} : ${typeText(binding.type)} access=${binding.access} ${provenanceText(binding.provenance)}`,
        ),
        ...(arm.guard === undefined
          ? []
          : [
              `${indent}    guard -> ${arm.guard.execution.result === undefined ? 'never' : localText(arm.guard.execution.result)}${recoveryText(arm.guard.execution)}`,
              ...topologicalRegions(arm.guard.execution)
                .flatMap(regionLines)
                .map((line) => `${indent}    ${line}`),
            ]),
        `${indent}    selected access=${arm.selected.access} result=${arm.selected.execution.result === undefined ? 'never' : localText(arm.selected.execution.result)} end-borrow=${arm.selected.endBorrow}${recoveryText(arm.selected.execution)}`,
        ...topologicalRegions(arm.selected.execution)
          .flatMap(regionLines)
          .map((line) => `${indent}    ${line}`),
        ...arm.selected.cleanup.map(
          (entry) =>
            `${indent}      cleanup ${localText(entry.destination)} <- ${fieldPathText(entry.path)} ${entry.cleanup._tag}`,
        ),
      ]
    }),
  ]
}

const outcomeText = (outcome: Outcome): string => {
  switch (outcome._tag) {
    case 'Forward':
      return `forward ${regionText(outcome.target)} ${provenanceText(outcome.provenance)}`
    case 'Return':
      return `return ${localText(outcome.value)} ${provenanceText(outcome.provenance)}`
    case 'Trap':
      return `trap "${outcome.reason}" ${provenanceText(outcome.provenance)}`
    case 'Repeat':
      return `repeat ${loopText(outcome.loop)} ${provenanceText(outcome.provenance)}`
    case 'Exit':
      return `exit ${loopText(outcome.loop)} ${provenanceText(outcome.provenance)}`
    case 'Complete':
      return `complete ${provenanceText(outcome.provenance)}`
    case 'Yield':
      return `yield ${provenanceText(outcome.provenance)}`
  }
}

const regionLines = (region: Region): ReadonlyArray<string> => {
  const owner = region.ownerLoop === undefined ? '' : ` owner=${loopText(region.ownerLoop)}`
  switch (region._tag) {
    case 'OperationRegion':
      return [
        `  ${regionText(region.id)} operation${owner}:`,
        ...region.operations.flatMap((operation) => operationLines(operation, '    ')),
        `    ${outcomeText(region.outcome)}`,
      ]
    case 'CleanupRegion':
      return [
        `  ${regionText(region.id)} cleanup${owner}:`,
        ...region.releases.flatMap((release) => operationLines(release, '    ')),
        `    ${outcomeText(region.outcome)}`,
      ]
    case 'ConditionalRegion':
      return [
        `  ${regionText(region.id)} conditional${owner} condition=${localText(region.condition)} taken=${regionText(region.taken)} otherwise=${regionText(region.otherwise)}${region.following === undefined ? '' : ` following=${regionText(region.following)}`} ${provenanceText(region.provenance)}`,
      ]
    case 'LoopRegion':
      return [
        `  ${regionText(region.id)} loop ${loopText(region.loop)}${region.parent === undefined ? '' : ` parent=${loopText(region.parent)}`} condition=${regionText(region.condition)} value=${localText(region.conditionValue)} body=${regionText(region.body)} following=${regionText(region.following)} ${provenanceText(region.provenance)}`,
      ]
  }
}

const suspensionPointText = (point: SuspensionPointId): string =>
  `${point.sourceId}:${point.spanStart}:${point.spanEnd}#${point.ordinal}`

const continuationPathText = (name: string, path: CoroutineFramePathPlan): string =>
  `    ${name} restores=${path.restores.join(',') || 'none'} loans=${path.loanEnds.map(suspensionBorrowText).join(',') || 'none'} releases=${path.releases.map(coroutineFrameReleaseText).join(',') || 'none'}`

const suspensionRunnerLines = (
  runner: SuspensionRunner,
  indent = '    ',
): ReadonlyArray<string> => [
  `${indent}runner classification=${runner.classification.toLowerCase()} declaration=${runner.declaration === undefined ? 'unknown' : targetText(runner.declaration)} instance=${runner.instance === undefined ? 'unknown' : instanceText(runner.instance)} effect=${runner.effectIdentity ?? 'none'} type-arguments=${runner.typeArguments.map(SilkType.encodeGenericArgument).join(',') || 'none'} outcome=${SilkType.encode(runner.outcome)}`,
  ...runner.captures.map(
    (capture) =>
      `${indent}capture ${capture.ordinal} ${capture.source.toLowerCase()}:${capture.sourceOrdinal} access=${capture.access.toLowerCase()} type=${SilkType.encode(capture.type)}`,
  ),
  ...runner.providers.map(
    (provider) =>
      `${indent}provider ${SilkType.encode(provider.capability)}@${provider.role} requirement=${provider.requirementAccess.toLowerCase()} access=${provider.access.toLowerCase()} type=${SilkType.encode(provider.providerType)} argument=${provider.argument === undefined ? 'none' : localText(provider.argument)} witness=${provider.witness?._tag ?? 'none'} purposes=${provider.purposes.join('+')}`,
  ),
]

const suspensionLines = (fn: MirFunction): ReadonlyArray<string> => {
  const suspension = fn.suspension
  if (suspension === undefined) return []
  return [
    `  suspension-classification ${suspension.classification.toLowerCase()}`,
    ...suspension.regions.flatMap((region) => {
      if (region._tag === 'SuspendEffectRegion')
        return [
          `  suspend-origin ${suspensionPointText(region.point)} owner=${regionText(region.ownerRegion)} operation=${region.operation._tag} transfer=private-frame-stack`,
          ...suspensionRunnerLines(region.deferred),
        ]
      const descriptor = region.relay.state
      return [
        `  suspend-run ${suspensionPointText(region.point)} owner=${regionText(region.ownerRegion)} operation=${region.operation._tag} runner=${region.runner.declaration === undefined ? 'unknown' : targetText(region.runner.declaration)} complete=current relay=preserve-child-origin-outcome frame=${region.relay.frame.toLowerCase()}`,
        ...suspensionRunnerLines(region.runner),
        region.completion._tag === 'Propagate'
          ? `    completion propagate outcome=${SilkType.encode(region.completion.outcome)} mappings=${region.completion.failureMappings.map((mapping) => `${mapping.source}:${mapping.target}`).join(',') || 'none'}`
          : `    completion reify outcome=${SilkType.encode(region.completion.outcome)} success=${SilkType.encode(region.completion.successType)} failure=${SilkType.encode(region.completion.failureValueType)}`,
        `    live ${region.liveLocals.map(localText).join(',') || 'none'}`,
        ...(descriptor === undefined
          ? []
          : [
              `    descriptor outcome=${SilkType.encode(descriptor.outcome)} resume-success=${suspensionPointText(descriptor.success.resume.point)}:${descriptor.success.resume.path.toLowerCase()} resume-failure=${suspensionPointText(descriptor.failure.resume.point)}:${descriptor.failure.resume.path.toLowerCase()}`,
              ...descriptor.slots.map((slot) => {
                if (slot.access._tag === 'Copy') {
                  return `    slot ${slot.ordinal} ${localText(slot.local)} copy ${typeText(slot.type)}${slot.initialization === undefined ? '' : ` initialized=${MovePath.encodeState(slot.initialization.state)} flags=${slot.initialization.flags.map((flag) => `${MovePath.key(flag.path)}:${localText(flag.local)}`).join(',')}`}`
                }
                if (slot.access._tag === 'BorrowedDependency') {
                  return `    slot ${slot.ordinal} ${localText(slot.local)} borrow:${slot.access.access.toLowerCase()} root=${localText(slot.access.root)} ${typeText(slot.type)}${slot.initialization === undefined ? '' : ` initialized=${MovePath.encodeState(slot.initialization.state)} flags=${slot.initialization.flags.map((flag) => `${MovePath.key(flag.path)}:${localText(flag.local)}`).join(',')}`}`
                }
                return `    slot ${slot.ordinal} ${localText(slot.local)} move:${slot.access.cleanup._tag} ${typeText(slot.type)}${slot.initialization === undefined ? '' : ` initialized=${MovePath.encodeState(slot.initialization.state)} flags=${slot.initialization.flags.map((flag) => `${MovePath.key(flag.path)}:${localText(flag.local)}`).join(',')}`}`
              }),
              continuationPathText('success', descriptor.success),
              continuationPathText('failure', descriptor.failure),
            ]),
      ]
    }),
  ]
}

const coroutineFrameTargetLines = (self: Module): ReadonlyArray<string> =>
  (self.coroutineFrames?.entries ?? []).flatMap((entry) => [
    `coroutine-frame ${instanceText(entry.function)} size=${entry.size} alignment=${entry.alignment} storage=private-execution-stack`,
    ...entry.diagnosticScopes.map(
      (field) => `  diagnostic-scope ${localText(field.scope)} offset=${field.offset}`,
    ),
    ...entry.diagnosticOutcomes.map(
      (field) => `  diagnostic-outcome ${localText(field.outcome)} offset=${field.offset}`,
    ),
    ...entry.header.map(
      (field) =>
        `  header ${field.role.toLowerCase()} offset=${field.offset} size=${field.size} alignment=${field.alignment}`,
    ),
    ...entry.states.flatMap((state) => [
      `  state ${suspensionPointText(state.point)} size=${state.size} alignment=${state.alignment} tail-padding=${state.tailPadding}`,
      ...state.payload.map(
        (field) =>
          `    payload slot=${field.slot} local=${localText(field.local)} offset=${field.offset} size=${field.size} alignment=${field.alignment} padding=${field.padding}`,
      ),
    ]),
  ])

const foreignStaticInitializerText = (
  literal: DeclarationFacts.ConstantLiteralFact | undefined,
): string => {
  if (literal?._tag === 'IntegerLiteral') return literal.value.toString()
  if (literal?._tag === 'FloatingLiteral') return literal.spelling
  return 'none'
}

export const encode = (self: Module): string => {
  return [
    `mir-module ${self.module}`,
    ...(self.retainedRoots ?? []).map(
      (root) => `retain ${JSON.stringify(Instances.keyText(root))}`,
    ),
    ...self.foreignExports.map(
      (record) =>
        `foreign-export ${record.symbol} type=${SilkType.encode(record.type)} signature=${CAbi.signatureKey(record.signature)} implementation=${instanceText(record.key)} declaration=${targetText(record.declaration)} ${spanText(record.declarationSpan)}`,
    ),
    ...self.foreignCalls.map(
      (call) =>
        `foreign ${call.symbol} abi=C signature=${CAbi.signatureKey(call.signature)} declaration=${targetText(call.declaration)} ${spanText(call.callSpan)}`,
    ),
    ...self.foreignStatics.map(
      (record) =>
        `foreign-static ${record.direction.toLowerCase()} ${record.symbol} type=${SilkType.encode(record.type)} initializer=${foreignStaticInitializerText(record.literal)} declaration=${targetText(record.declaration)} ${spanText(record.declarationSpan)}`,
    ),
    ...(self.staticData ?? []).map(
      (data) =>
        `static ${data.id} kind=${data.kind.toLowerCase()} utf8=${data.utf8} bytes=${data.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    ),
    ...(self.normalization ?? []).map((verdict) =>
      verdict._tag === 'Normalized'
        ? `normalization accepted kind=${verdict.kind} function=${targetText(verdict.function)} region=${regionText(verdict.region)} local=${localText(verdict.local)} guards=${verdict.guards.join(',')} ${provenanceText(verdict.provenance)}`
        : `normalization rejected reason=${verdict.reason} function=${targetText(verdict.function)} region=${regionText(verdict.region)} local=${localText(verdict.local)} ${provenanceText(verdict.provenance)}`,
    ),
    ...coroutineFrameTargetLines(self),
    ...self.executionTransitions.flatMap(ExecutionTransition.encodeAuthority),
    ...LayoutEncode.encode(self.layout).trimEnd().split('\n'),
    ...self.functions.flatMap((fn) => [
      `fn ${targetText(fn.id)}${
        fn.instance.typeArguments.length === 0
          ? ''
          : `<${fn.instance.typeArguments.map(SilkType.encodeGenericArgument).join(', ')}>`
      } params=${fn.parameterCount} locals=${fn.localTypes.length} -> ${typeText(fn.result)} entry=${regionText(fn.entry)}${fn.machine === undefined ? '' : ' machine=naked,noreturn'}`,
      ...(fn.sourceOwner === undefined
        ? []
        : [
            `  source-owner ${JSON.stringify(fn.sourceOwner.module)}:${JSON.stringify(fn.sourceOwner.name)}`,
          ]),
      ...(fn.sourceInvocationUse === undefined
        ? []
        : [
            `  source-invocation lifetime=${Lifetime.key(fn.sourceInvocationUse.lifetime)} parameters=${fn.sourceInvocationUse.parameters.join(',')}`,
          ]),
      ...(fn.sourceParameters ?? []).map(
        (parameter) =>
          `  source-parameter #${parameter.parameter} local=${localText(parameter.local)} origin=${JSON.stringify(AuthoredIdentity.anchorKey(parameter.source))} contract=${SilkType.encode(parameter.contract)} type=${SilkType.encode(parameter.type)}`,
      ),
      ...(fn.sourceCallableCaptures ?? []).map(
        (capture) =>
          `  source-callable-capture local=${localText(capture.local)} producer=${Tir.nodeRefKey(capture.producer)}`,
      ),
      ...suspensionLines(fn),
      ...topologicalRegions(fn).flatMap(regionLines),
    ]),
    '',
  ].join('\n')
}
