import * as ByteString from '../ByteString.js'
import type * as BuilderState from '../internal/BuilderState.js'
import type * as FunctionBodyDescription from '../internal/FunctionBodyDescription.js'
import type * as GlobalDescription from '../internal/GlobalDescription.js'
import * as LocalName from '../internal/LocalName.js'
import type * as MetadataDescription from '../internal/MetadataDescription.js'
import * as MemoryAccess from '../MemoryAccess.js'
import { renderAttributeSet } from './AttributeRenderer.js'
import { renderConstant, renderTypedConstant } from './ConstantRenderer.js'
import { type MetadataRender, renderMetadataAttachments } from './MetadataRenderer.js'
import { identifier, quoted } from './shared.js'
import { renderType, typeAt } from './TypeRenderer.js'
import * as PackedBody from '../internal/PackedBody.js'

/** @internal */
export const globalPrefix = (description: GlobalDescription.GlobalDescription): string => {
  const values = [
    description.linkage === 'external' ? '' : description.linkage,
    description.preemption === 'dso_preemptable' ? '' : description.preemption,
    description.visibility === 'default' ? '' : description.visibility,
    description.dllStorage === 'default' ? '' : description.dllStorage,
    description.unnamedAddress === 'none' ? '' : description.unnamedAddress,
    description.addressSpace.value === 0 ? '' : `addrspace(${description.addressSpace.value})`,
  ].filter((value) => value !== '')
  return values.length === 0 ? '' : `${values.join(' ')} `
}

/** @internal */
export const globalSuffix = (description: GlobalDescription.GlobalDescription): string => {
  const values = [
    ByteString.isEmpty(description.section) ? '' : `section ${quoted(description.section)}`,
    description.alignment.byteUnits === undefined ? '' : `align ${description.alignment.byteUnits}`,
  ].filter((value) => value !== '')
  return values.length === 0 ? '' : `, ${values.join(', ')}`
}

/** @internal */
export const renderVariable = (
  state: BuilderState.Snapshot,
  global: GlobalDescription.GlobalDescription,
  context: MetadataRender,
  globalIndex: number,
): string => {
  const variable = state.variables[global.actorIndex]
  if (variable === undefined) throw new Error('missing variable')
  let threadLocal = ''
  if (variable.threadLocal !== 'none') {
    threadLocal =
      variable.threadLocal === 'generaldynamic'
        ? 'thread_local '
        : `thread_local(${variable.threadLocal}) `
  }
  const externallyInitialized = variable.externallyInitialized ? 'externally_initialized ' : ''
  const storage = variable.constant ? 'constant' : 'global'
  const value =
    variable.initializer === undefined
      ? `external ${threadLocal}${storage} ${renderType(state, variable.valueType)}`
      : `${globalPrefix(global)}${threadLocal}${externallyInitialized}${storage} ${renderTypedConstant(state, variable.initializer)}`
  const attachments = renderMetadataAttachments(
    state,
    context,
    state.globalMetadata[globalIndex] ?? [],
  )
  return `${identifier('@', global.name)} = ${value}${globalSuffix(global)}${attachments === '' ? '' : `, ${attachments}`}`
}

/** @internal */
export const renderAlias = (
  state: BuilderState.Snapshot,
  global: GlobalDescription.GlobalDescription,
): string => {
  const alias = state.aliases[global.actorIndex]
  if (alias === undefined) throw new Error('missing alias')
  return `${identifier('@', global.name)} = ${globalPrefix(global)}alias ${renderType(state, alias.valueType)}, ${renderTypedConstant(state, alias.aliasee)}${globalSuffix(global)}`
}

/** @internal */
export const functionSuffix = (description: GlobalDescription.GlobalDescription): string => {
  const values = [
    ByteString.isEmpty(description.section) ? '' : `section ${quoted(description.section)}`,
    description.alignment.byteUnits === undefined ? '' : `align ${description.alignment.byteUnits}`,
  ].filter((value) => value !== '')
  return values.length === 0 ? '' : ` ${values.join(' ')}`
}

export interface LocalNames {
  readonly values: ReadonlyMap<number, string>
  readonly blocks: ReadonlyMap<number, string>
}

/** @internal */
export const localNameCache = new WeakMap<FunctionBodyDescription.Snapshot, LocalNames>()

/**
 * Assigns every local a name that is unique within its function.
 *
 * **Details**
 *
 * Values and blocks share one symbol table in LLVM, so a block label collides with an instruction
 * result of the same name just as two instruction results do. Requested names are kept whenever
 * they are still free and otherwise disambiguated with a `.N` suffix, in value-then-block index
 * order so the mapping is a pure function of the snapshot. Resolved forward references are skipped:
 * they render as the value they resolve to and never define a name of their own.
 *
 * @internal
 */
export const computeLocalNames = (body: FunctionBodyDescription.Snapshot): LocalNames => {
  const used = new Set<string>()
  const assign = (name: LocalName.LocalName, fallback: string): string => {
    const base = LocalName.toByteString(LocalName.isEmpty(name) ? fallback : name)
    let rendered = identifier('%', base)
    let suffix = 1
    while (used.has(rendered)) {
      rendered = identifier('%', ByteString.concat([base, ByteString.fromString(`.${suffix}`)]))
      suffix += 1
    }
    used.add(rendered)
    return rendered
  }
  const values = new Map<number, string>()
  body.values.forEach((value, index) => {
    if (value.source._tag === 'Forward' && value.source.resolved !== undefined) return
    values.set(index, assign(value.name, `v${index}`))
  })
  const blocks = new Map<number, string>()
  body.blocks.forEach((block, index) => {
    blocks.set(index, assign(block.name, `bb${index}`))
  })
  return { values, blocks }
}

/** @internal */
export const localNames = (body: FunctionBodyDescription.Snapshot): LocalNames => {
  const cached = localNameCache.get(body)
  if (cached !== undefined) return cached
  const computed = computeLocalNames(body)
  localNameCache.set(body, computed)
  return computed
}

/** @internal */
export const localIdentifier = (body: FunctionBodyDescription.Snapshot, index: number): string => {
  const name = localNames(body).values.get(index)
  if (name === undefined) throw new Error(`missing value ${index}`)
  return name
}

/** @internal */
export const blockIdentifier = (body: FunctionBodyDescription.Snapshot, index: number): string => {
  const name = localNames(body).blocks.get(index)
  if (name === undefined) throw new Error(`missing block ${index}`)
  return name
}

/** @internal */
export const blockLabel = (body: FunctionBodyDescription.Snapshot, index: number): string =>
  blockIdentifier(body, index).slice(1)

/** @internal */
export const resolvedOperand = (
  body: FunctionBodyDescription.Snapshot,
  operand: FunctionBodyDescription.Operand,
  seen: ReadonlySet<number> = new Set(),
): FunctionBodyDescription.Operand => {
  if (operand._tag === 'Constant') return operand
  const value = body.values[operand.value]
  if (value?.source._tag !== 'Forward' || value.source.resolved === undefined) return operand
  if (seen.has(operand.value)) throw new Error('forward value cycle')
  const next = new Set(seen)
  next.add(operand.value)
  return resolvedOperand(body, value.source.resolved, next)
}

/** @internal */
export const operandType = (
  state: BuilderState.Snapshot,
  body: FunctionBodyDescription.Snapshot,
  operand: FunctionBodyDescription.Operand,
): number => {
  const resolved = resolvedOperand(body, operand)
  const type =
    resolved._tag === 'Constant'
      ? state.constants[resolved.constant]?.type
      : body.values[resolved.value]?.type
  if (type === undefined) throw new Error('missing operand type')
  return type
}

/** @internal */
export const renderOperand = (
  state: BuilderState.Snapshot,
  body: FunctionBodyDescription.Snapshot,
  operand: FunctionBodyDescription.Operand,
): string => {
  const resolved = resolvedOperand(body, operand)
  return resolved._tag === 'Constant'
    ? renderConstant(state, resolved.constant)
    : localIdentifier(body, resolved.value)
}

/** @internal */
export const renderTypedOperand = (
  state: BuilderState.Snapshot,
  body: FunctionBodyDescription.Snapshot,
  operand: FunctionBodyDescription.Operand,
): string =>
  `${renderType(state, operandType(state, body, operand))} ${renderOperand(state, body, operand)}`

/** @internal */
export const fastMathFlags = (flags: FunctionBodyDescription.FastMath): string => {
  if (
    flags.allowReassociation &&
    flags.noNaNs &&
    flags.noInfinities &&
    flags.noSignedZeros &&
    flags.allowReciprocal &&
    flags.allowContract &&
    flags.approximateFunctions
  ) {
    return 'fast '
  }
  const values = [
    flags.allowReassociation ? 'reassoc' : '',
    flags.noNaNs ? 'nnan' : '',
    flags.noInfinities ? 'ninf' : '',
    flags.noSignedZeros ? 'nsz' : '',
    flags.allowReciprocal ? 'arcp' : '',
    flags.allowContract ? 'contract' : '',
    flags.approximateFunctions ? 'afn' : '',
  ].filter((value) => value !== '')
  return values.length === 0 ? '' : `${values.join(' ')} `
}

/** @internal */
export const renderAlignment = (alignment: { readonly byteUnits: bigint | undefined }): string =>
  alignment.byteUnits === undefined ? '' : `, align ${alignment.byteUnits}`

/** @internal */
export const renderAtomic = (access: FunctionBodyDescription.MemoryInfo): string =>
  access.ordering === 'none'
    ? ''
    : ` ${MemoryAccess.renderSyncScope(access.syncScope)}${MemoryAccess.renderOrdering(access.ordering)}`

/** @internal */
export const renderCall = (
  state: BuilderState.Snapshot,
  body: FunctionBodyDescription.Snapshot,
  instruction: Extract<FunctionBodyDescription.Instruction, { readonly _tag: 'Call' | 'Invoke' }>,
): string => {
  const signature = typeAt(state, instruction.functionType)
  if (signature._tag !== 'Function') throw new Error('call has non-function type')
  const attributes =
    instruction.attributes === undefined
      ? undefined
      : state.functionAttributeSets[instruction.attributes]
  const returnAttributes =
    attributes === undefined ? '' : renderAttributeSet(state, attributes.returnAttributes)
  const args = instruction.arguments.map((operand, index) => {
    const parameterAttributes =
      attributes?.parameterAttributes[index] === undefined
        ? ''
        : renderAttributeSet(state, attributes.parameterAttributes[index])
    return `${renderType(state, operandType(state, body, operand))}${parameterAttributes === '' ? '' : ` ${parameterAttributes}`} ${renderOperand(state, body, operand)}`
  })
  const functionAttributes =
    attributes === undefined ? '' : renderAttributeSet(state, attributes.functionAttributes)
  const bundles = instruction.operandBundles.map(
    (bundle) =>
      `${quoted(bundle.tag)}(${bundle.operands.map((operand) => renderTypedOperand(state, body, operand)).join(', ')})`,
  )
  const tail =
    instruction._tag === 'Invoke' || instruction.tail === 'none' ? '' : `${instruction.tail} `
  const convention =
    instruction.callingConvention === 0 ? '' : `cc ${instruction.callingConvention} `
  const result =
    instruction.result === undefined ? '' : `${localIdentifier(body, instruction.result)} = `
  return `${result}${tail}${instruction._tag === 'Invoke' ? 'invoke' : 'call'} ${fastMathFlags(instruction.fastMath)}${convention}${returnAttributes === '' ? '' : `${returnAttributes} `}${renderType(state, signature.variadic ? instruction.functionType : signature.returnType)} ${renderOperand(state, body, instruction.callee)}(${args.join(', ')})${functionAttributes === '' ? '' : ` ${functionAttributes}`}${bundles.length === 0 ? '' : ` [ ${bundles.join(', ')} ]`}${instruction._tag === 'Invoke' ? ` to label ${blockIdentifier(body, instruction.normal)} unwind label ${blockIdentifier(body, instruction.unwind)}` : ''}`
}

/** @internal */
export const renderInstruction = (
  state: BuilderState.Snapshot,
  body: FunctionBodyDescription.Snapshot,
  instruction: FunctionBodyDescription.Instruction,
): string => {
  const result =
    instruction.result === undefined ? '' : `${localIdentifier(body, instruction.result)} = `
  switch (instruction._tag) {
    case 'Unary':
      return `${result}${instruction.kind} ${fastMathFlags(instruction.fastMath)}${renderTypedOperand(state, body, instruction.operand)}`
    case 'Freeze':
      return `${result}freeze ${renderTypedOperand(state, body, instruction.operand)}`
    case 'Binary': {
      const flags = instruction.kind.startsWith('f')
        ? fastMathFlags(instruction.fastMath)
        : [
            instruction.integerFlags.noUnsignedWrap ? 'nuw' : '',
            instruction.integerFlags.noSignedWrap ? 'nsw' : '',
            instruction.integerFlags.exact ? 'exact' : '',
          ]
            .filter((value) => value !== '')
            .join(' ')
      return `${result}${instruction.kind}${flags === '' ? '' : ` ${flags}`} ${renderTypedOperand(state, body, instruction.left)}, ${renderOperand(state, body, instruction.right)}`
    }
    case 'Compare':
      return `${result}${instruction.kind === 'integer' ? 'icmp' : 'fcmp'} ${instruction.kind === 'floating' ? fastMathFlags(instruction.fastMath) : ''}${instruction.predicate} ${renderTypedOperand(state, body, instruction.left)}, ${renderOperand(state, body, instruction.right)}`
    case 'Select':
      return `${result}select ${fastMathFlags(instruction.fastMath)}${renderTypedOperand(state, body, instruction.condition)}, ${renderTypedOperand(state, body, instruction.onTrue)}, ${renderTypedOperand(state, body, instruction.onFalse)}`
    case 'Cast': {
      const flags = [
        instruction.noUnsignedWrap ? 'nuw' : '',
        instruction.noSignedWrap ? 'nsw' : '',
      ].filter((value) => value !== '')
      return `${result}${instruction.kind}${flags.length === 0 ? '' : ` ${flags.join(' ')}`} ${renderTypedOperand(state, body, instruction.operand)} to ${renderType(state, instruction.destinationType)}`
    }
    case 'ExtractValue':
      return `${result}extractvalue ${renderTypedOperand(state, body, instruction.aggregate)}, ${instruction.indices.join(', ')}`
    case 'InsertValue':
      return `${result}insertvalue ${renderTypedOperand(state, body, instruction.aggregate)}, ${renderTypedOperand(state, body, instruction.element)}, ${instruction.indices.join(', ')}`
    case 'Alloca': {
      const count = renderTypedOperand(state, body, instruction.count)
      const addressSpace =
        instruction.addressSpace === 0 ? '' : `, addrspace(${instruction.addressSpace})`
      return `${result}alloca${instruction.inAlloca ? ' inalloca' : ''} ${renderType(state, instruction.allocationType)}, ${count}${renderAlignment(instruction.alignment)}${addressSpace}`
    }
    case 'Load':
      return `${result}load${instruction.access.ordering === 'none' ? '' : ' atomic'} ${MemoryAccess.renderKind(instruction.access.kind)}${renderType(state, instruction.valueType)}, ${renderTypedOperand(state, body, instruction.pointer)}${renderAtomic(instruction.access)}${renderAlignment(instruction.access.alignment)}`
    case 'Store':
      return `store${instruction.access.ordering === 'none' ? '' : ' atomic'} ${MemoryAccess.renderKind(instruction.access.kind)}${renderTypedOperand(state, body, instruction.value)}, ${renderTypedOperand(state, body, instruction.pointer)}${renderAtomic(instruction.access)}${renderAlignment(instruction.access.alignment)}`
    case 'GetElementPtr': {
      const flags = [instruction.inbounds ? 'inbounds' : ''].filter((flag) => flag !== '').join(' ')
      const indices = instruction.indices
        .map((operand, position) => {
          const rendered = renderTypedOperand(state, body, operand)
          return instruction.inrange === position ? `inrange(${rendered})` : rendered
        })
        .join(', ')
      return `${result}getelementptr${flags === '' ? '' : ` ${flags}`} ${renderType(state, instruction.sourceType)}, ${renderTypedOperand(state, body, instruction.base)}, ${indices}`
    }
    case 'ExtractElement':
      return `${result}extractelement ${renderTypedOperand(state, body, instruction.vector)}, ${renderTypedOperand(state, body, instruction.index)}`
    case 'InsertElement':
      return `${result}insertelement ${renderTypedOperand(state, body, instruction.vector)}, ${renderTypedOperand(state, body, instruction.element)}, ${renderTypedOperand(state, body, instruction.index)}`
    case 'ShuffleVector':
      return `${result}shufflevector ${renderTypedOperand(state, body, instruction.left)}, ${renderTypedOperand(state, body, instruction.right)}, ${renderTypedOperand(state, body, instruction.mask)}`
    case 'Fence':
      return `fence ${MemoryAccess.renderSyncScope(instruction.syncScope)}${instruction.ordering}`
    case 'CompareExchange':
      return `${result}cmpxchg${instruction.weak ? ' weak' : ''} ${MemoryAccess.renderKind(instruction.access.kind)}${renderTypedOperand(state, body, instruction.pointer)}, ${renderTypedOperand(state, body, instruction.comparison)}, ${renderTypedOperand(state, body, instruction.replacement)} ${MemoryAccess.renderSyncScope(instruction.access.syncScope)}${instruction.access.ordering} ${instruction.failureOrdering}${renderAlignment(instruction.access.alignment)}`
    case 'AtomicRmw':
      return `${result}atomicrmw ${MemoryAccess.renderKind(instruction.access.kind)}${instruction.operation} ${renderTypedOperand(state, body, instruction.pointer)}, ${renderTypedOperand(state, body, instruction.value)} ${MemoryAccess.renderSyncScope(instruction.access.syncScope)}${instruction.access.ordering}${renderAlignment(instruction.access.alignment)}`
    case 'VaArg':
      return `${result}va_arg ${renderTypedOperand(state, body, instruction.list)}, ${renderType(state, instruction.valueType)}`
    case 'IndirectBranch':
      return `indirectbr ${renderTypedOperand(state, body, instruction.address)}, [${instruction.destinations.map((block) => `label ${blockIdentifier(body, block)}`).join(', ')}]`
    case 'Branch':
      return `br label ${blockIdentifier(body, instruction.destination)}`
    case 'ConditionalBranch':
      return `br ${renderTypedOperand(state, body, instruction.condition)}, label ${blockIdentifier(body, instruction.onTrue)}, label ${blockIdentifier(body, instruction.onFalse)}`
    case 'Switch': {
      const cases = instruction.cases
        .map(
          (entry) =>
            `  ${renderTypedConstant(state, entry.value)}, label ${blockIdentifier(body, entry.block)}`,
        )
        .join('\n')
      return `switch ${renderTypedOperand(state, body, instruction.value)}, label ${blockIdentifier(body, instruction.defaultBlock)} [${cases === '' ? '' : `\n${cases}\n`}]`
    }
    case 'Return':
      return `ret ${renderTypedOperand(state, body, instruction.value)}`
    case 'ReturnVoid':
      return 'ret void'
    case 'Unreachable':
      return 'unreachable'
    case 'Phi':
      return `${result}phi ${fastMathFlags(instruction.fastMath)}${renderType(state, instruction.type)} ${instruction.incoming
        .map(
          (entry) =>
            `[ ${renderOperand(state, body, entry.value)}, ${blockIdentifier(body, entry.block)} ]`,
        )
        .join(', ')}`
    case 'LandingPad':
      return `${result}landingpad ${renderType(state, instruction.type)} cleanup`
    case 'Invoke':
    case 'Call':
      return renderCall(state, body, instruction)
  }
}

/** @internal */
export const renderBody = (
  state: BuilderState.Snapshot,
  body: FunctionBodyDescription.Snapshot,
  context: MetadataRender,
): string =>
  body.blocks
    .map((block, index) => {
      const instructions = block.instructions.map((instructionIndex) => {
        const instruction = body.instructions[instructionIndex]
        if (instruction === undefined) throw new Error(`missing instruction ${instructionIndex}`)
        const attachments: Array<MetadataDescription.Attachment> = [
          ...(body.debugLocations[instructionIndex] === undefined
            ? []
            : [
                {
                  kind: 'dbg' as const,
                  metadata: body.debugLocations[instructionIndex],
                },
              ]),
          ...(body.metadata[instructionIndex] ?? []),
        ]
        const suffix = renderMetadataAttachments(state, context, attachments)
        return `  ${renderInstruction(state, body, instruction).replaceAll('\n', '\n  ')}${suffix === '' ? '' : `, ${suffix}`}`
      })
      return `${blockLabel(body, index)}:\n${instructions.join('\n')}`
    })
    .join('\n')

/** @internal */
export const renderFunction = (
  state: BuilderState.Snapshot,
  global: GlobalDescription.GlobalDescription,
  context: MetadataRender,
  globalIndex: number,
): string => {
  const fn = state.functions[global.actorIndex]
  if (fn === undefined) throw new Error('missing function')
  const type = typeAt(state, fn.type)
  if (type._tag !== 'Function') throw new Error('function declaration has non-function type')
  const attributes =
    fn.attributes === undefined ? undefined : state.functionAttributeSets[fn.attributes]
  const body = fn.body === undefined ? undefined : PackedBody.unpack(fn.body)
  const returnAttributes =
    attributes === undefined ? '' : renderAttributeSet(state, attributes.returnAttributes)
  const parameters = type.parameters.map((parameter, index) => {
    const parameterAttributes =
      attributes?.parameterAttributes[index] === undefined
        ? ''
        : renderAttributeSet(state, attributes.parameterAttributes[index])
    const value = body?.arguments[index]
    const name = value === undefined || body === undefined ? '' : ` ${localIdentifier(body, value)}`
    return `${renderType(state, parameter)}${parameterAttributes === '' ? '' : ` ${parameterAttributes}`}${name}`
  })
  if (type.variadic) parameters.push('...')
  const functionAttributes =
    attributes === undefined ? '' : renderAttributeSet(state, attributes.functionAttributes)
  const callingConvention = fn.callingConvention === 0 ? '' : `cc ${fn.callingConvention} `
  const garbageCollector = ByteString.isEmpty(fn.garbageCollector)
    ? ''
    : ` gc ${quoted(fn.garbageCollector)}`
  const metadata = renderMetadataAttachments(
    state,
    context,
    state.globalMetadata[globalIndex] ?? [],
  )
  const header = `${body === undefined ? 'declare' : 'define'} ${globalPrefix(global)}${callingConvention}${returnAttributes === '' ? '' : `${returnAttributes} `}${renderType(state, type.returnType)} ${identifier('@', global.name)}(${parameters.join(', ')})${functionAttributes === '' ? '' : ` ${functionAttributes}`}${garbageCollector}${fn.personality === undefined ? '' : ` personality ${renderTypedConstant(state, fn.personality)}`}${functionSuffix(global)}${metadata === '' ? '' : ` ${metadata}`}`
  if (body === undefined) return header
  return `${header} {\n${renderBody(state, body, context)}\n}`
}
