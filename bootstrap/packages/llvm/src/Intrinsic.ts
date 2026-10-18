import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Alignment from './Alignment.js'
import * as Attribute from './Attribute.js'
import type * as Builder from './Builder.js'
import * as Constant from './Constant.js'
import * as FunctionActor from './Function.js'
import type * as FunctionBody from './FunctionBody.js'
import * as FunctionBodyActor from './FunctionBody.js'
import * as BuilderState from './internal/BuilderState.js'
import * as FunctionBodyState from './internal/FunctionBodyState.js'
import * as Handle from './internal/Handle.js'
import type * as TypeDescription from './internal/TypeDescription.js'
import { invalidInput, invalidState, type LlvmError, wrappedFailure } from './LlvmError.js'
import * as Type from './Type.js'
import type * as Value from './Value.js'

/**
 * The complete, deterministic intrinsic identifier inventory from the pinned Zig LLVM builder.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export const inventory = [
  'va_start',
  'va_end',
  'va_copy',
  'returnaddress',
  'addressofreturnaddress',
  'sponentry',
  'frameaddress',
  'prefetch',
  'thread.pointer',
  'abs',
  'smax',
  'smin',
  'umax',
  'umin',
  'scmp',
  'ucmp',
  'memcpy',
  'memcpy.inline',
  'memmove',
  'memset',
  'memset.inline',
  'sqrt',
  'powi',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'sincos',
  'sincospi',
  'modf',
  'pow',
  'exp',
  'exp2',
  'exp10',
  'ldexp',
  'frexp',
  'log',
  'log10',
  'log2',
  'fma',
  'fabs',
  'minnum',
  'maxnum',
  'minimum',
  'maximum',
  'minimumnum',
  'maximumnum',
  'copysign',
  'floor',
  'ceil',
  'trunc',
  'rint',
  'nearbyint',
  'round',
  'roundeven',
  'lround',
  'llround',
  'lrint',
  'llrint',
  'bitreverse',
  'bswap',
  'ctpop',
  'ctlz',
  'cttz',
  'fshl',
  'fshr',
  'clmul',
  'sadd.with.overflow',
  'uadd.with.overflow',
  'ssub.with.overflow',
  'usub.with.overflow',
  'smul.with.overflow',
  'umul.with.overflow',
  'sadd.sat',
  'uadd.sat',
  'ssub.sat',
  'usub.sat',
  'sshl.sat',
  'ushl.sat',
  'smul.fix',
  'umul.fix',
  'smul.fix.sat',
  'umul.fix.sat',
  'sdiv.fix',
  'udiv.fix',
  'sdiv.fix.sat',
  'udiv.fix.sat',
  'canonicalize',
  'fmuladd',
  'vector.reduce.add',
  'vector.reduce.fadd',
  'vector.reduce.mul',
  'vector.reduce.fmul',
  'vector.reduce.and',
  'vector.reduce.or',
  'vector.reduce.xor',
  'vector.reduce.smax',
  'vector.reduce.smin',
  'vector.reduce.umax',
  'vector.reduce.umin',
  'vector.reduce.fmax',
  'vector.reduce.fmin',
  'vector.reduce.fmaximum',
  'vector.reduce.fminimum',
  'vector.insert',
  'vector.extract',
  'is.fpclass',
  'var.annotation',
  'ptr.annotation',
  'annotation',
  'codeview.annotation',
  'trap',
  'debugtrap',
  'ubsantrap',
  'stackprotector',
  'stackguard',
  'objectsize',
  'expect',
  'expect.with.probability',
  'assume',
  'ssa.copy',
  'type.test',
  'type.checked.load',
  'type.checked.load.relative',
  'arithmetic.fence',
  'donothing',
  'load.relative',
  'sideeffect',
  'is.constant',
  'ptrmask',
  'threadlocal.address',
  'vscale',
  'dbg.declare',
  'dbg.value',
  'amdgcn.workitem.id.x',
  'amdgcn.workitem.id.y',
  'amdgcn.workitem.id.z',
  'amdgcn.workgroup.id.x',
  'amdgcn.workgroup.id.y',
  'amdgcn.workgroup.id.z',
  'amdgcn.dispatch.ptr',
  'nvvm.read.ptx.sreg.tid.x',
  'nvvm.read.ptx.sreg.tid.y',
  'nvvm.read.ptx.sreg.tid.z',
  'nvvm.read.ptx.sreg.ntid.x',
  'nvvm.read.ptx.sreg.ntid.y',
  'nvvm.read.ptx.sreg.ntid.z',
  'nvvm.read.ptx.sreg.ctaid.x',
  'nvvm.read.ptx.sreg.ctaid.y',
  'nvvm.read.ptx.sreg.ctaid.z',
  'wasm.memory.size',
  'wasm.memory.grow',
] as const

/**
 * A compile-time-safe intrinsic identifier drawn from {@link inventory}.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export type Id = (typeof inventory)[number]

/**
 * Describes how one intrinsic obtains its signature, overload suffixes, and attributes.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export interface CatalogEntry {
  readonly id: Id
  readonly llvmName: `llvm.${Id}`
  readonly signature: 'built-in' | 'explicit'
  readonly overloads: 'none' | 'recipe' | 'caller'
  readonly attributes: 'built-in' | 'explicit'
}

const builtInIds: ReadonlySet<Id> = new Set([
  'va_start',
  'va_end',
  'va_copy',
  'memcpy',
  'memcpy.inline',
  'memmove',
  'memset',
  'memset.inline',
  'assume',
  'trap',
  'debugtrap',
  'donothing',
  'sideeffect',
])

const builtInAttributeIds: ReadonlySet<Id> = new Set([
  'memcpy',
  'memcpy.inline',
  'memmove',
  'memset',
  'memset.inline',
  'assume',
])

const recipeOverloadIds: ReadonlySet<Id> = new Set([
  'va_start',
  'va_end',
  'va_copy',
  'memcpy',
  'memcpy.inline',
  'memmove',
  'memset',
  'memset.inline',
])

/**
 * Searchable metadata for every pinned intrinsic, in {@link inventory} order.
 *
 * @category intrinsics
 * @since 0.0.0
 */
const catalogOverloads = (id: Id): CatalogEntry['overloads'] => {
  if (recipeOverloadIds.has(id)) return 'recipe'
  if (builtInIds.has(id)) return 'none'
  return 'caller'
}

export const catalog: ReadonlyArray<CatalogEntry> = inventory.map((id) => ({
  id,
  llvmName: `llvm.${id}`,
  signature: builtInIds.has(id) ? 'built-in' : 'explicit',
  overloads: catalogOverloads(id),
  attributes: builtInAttributeIds.has(id) ? 'built-in' : 'explicit',
}))

/**
 * Caller-supplied signature for an intrinsic without a built-in recipe.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export interface ExplicitSignature {
  readonly returnType: Type.Type
  readonly parameters: ReadonlyArray<Type.Type>
  readonly variadic?: boolean
}

/**
 * Optional signature and canonical attribute overrides for {@link resolve}.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export interface ResolveOptions {
  /**
   * Required for catalog entries whose signature cannot be inferred solely from overload types.
   * Common and memory intrinsics have built-in recipes and need no explicit signature.
   */
  readonly signature?: ExplicitSignature
  /** Canonical declaration attributes for an explicit signature recipe. */
  readonly attributes?: Attribute.FunctionSet
}

/**
 * Volatility, inlining, and parameter alignment controls for {@link memcpy} and {@link memmove}.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export interface MemoryCopyOptions {
  readonly volatile?: boolean
  readonly inline?: boolean
  readonly destinationAlignment?: Alignment.Alignment
  readonly sourceAlignment?: Alignment.Alignment
}

/**
 * Volatility, inlining, and destination alignment controls for {@link memset}.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export interface MemorySetOptions {
  readonly volatile?: boolean
  readonly inline?: boolean
  readonly destinationAlignment?: Alignment.Alignment
}

type OverloadedRecipe = (
  context: BuilderState.Context,
  overloads: ReadonlyArray<Type.Type>,
) => Result.Result<ExplicitSignature, LlvmError>

type SimpleRecipe = (context: BuilderState.Context) => Result.Result<ExplicitSignature, LlvmError>

const recipeFailure = (message: string, overloads: ReadonlyArray<Type.Type>) =>
  Result.fail(invalidInput({ operation: 'Intrinsic.resolve', message, input: overloads }))

const voidType = (context: BuilderState.Context) =>
  Type.internIn(context, { _tag: 'Simple', tag: 'Void' })

const integerType = (context: BuilderState.Context, bitWidth: number) =>
  Type.internIn(context, { _tag: 'Integer', bitWidth })

const memoryCopySignature: OverloadedRecipe = (context, overloads) => {
  const destination = overloads[0]
  const source = overloads[1]
  const length = overloads[2]
  if (destination === undefined || source === undefined || length === undefined) {
    return recipeFailure(
      'Memory copy intrinsics require destination, source, and length overload types',
      overloads,
    )
  }
  const returnType = voidType(context)
  if (Result.isFailure(returnType)) return Result.fail(returnType.failure)
  const i1 = integerType(context, 1)
  if (Result.isFailure(i1)) return Result.fail(i1.failure)
  return Result.succeed({
    returnType: returnType.success,
    parameters: [destination, source, length, i1.success],
  })
}

const memorySetSignature: OverloadedRecipe = (context, overloads) => {
  const destination = overloads[0]
  const length = overloads[1]
  if (destination === undefined || length === undefined) {
    return recipeFailure(
      'Memory set intrinsics require destination and length overload types',
      overloads,
    )
  }
  const returnType = voidType(context)
  if (Result.isFailure(returnType)) return Result.fail(returnType.failure)
  const i8 = integerType(context, 8)
  if (Result.isFailure(i8)) return Result.fail(i8.failure)
  const i1 = integerType(context, 1)
  if (Result.isFailure(i1)) return Result.fail(i1.failure)
  return Result.succeed({
    returnType: returnType.success,
    parameters: [destination, i8.success, length, i1.success],
  })
}

const variadicRecipe =
  (name: string, arity: 1 | 2): OverloadedRecipe =>
  (context, overloads) => {
    const parameter = overloads[0]
    if (parameter === undefined) {
      return recipeFailure(`llvm.${name} requires one pointer overload type`, overloads)
    }
    return Result.map(voidType(context), (returnType) => ({
      returnType,
      parameters: arity === 1 ? [parameter] : [parameter, parameter],
    }))
  }

const overloadedRecipes: Readonly<Partial<Record<Id, OverloadedRecipe>>> = {
  va_start: variadicRecipe('va_start', 1),
  va_end: variadicRecipe('va_end', 1),
  va_copy: variadicRecipe('va_copy', 2),
  memcpy: memoryCopySignature,
  'memcpy.inline': memoryCopySignature,
  memmove: memoryCopySignature,
  memset: memorySetSignature,
  'memset.inline': memorySetSignature,
}

const voidRecipe: SimpleRecipe = (context) =>
  Result.map(voidType(context), (returnType) => ({ returnType, parameters: [] }))

const simpleRecipes: Readonly<Partial<Record<Id, SimpleRecipe>>> = {
  assume: (context) => {
    const returnType = voidType(context)
    if (Result.isFailure(returnType)) return Result.fail(returnType.failure)
    return Result.map(integerType(context, 1), (i1) => ({
      returnType: returnType.success,
      parameters: [i1],
    }))
  },
  trap: voidRecipe,
  debugtrap: voidRecipe,
  donothing: voidRecipe,
  sideeffect: voidRecipe,
}

/** @internal */
const mangleDescription = (
  state: BuilderState.MutableState,
  description: TypeDescription.Description,
): string => {
  switch (description._tag) {
    case 'Integer':
      return `i${description.bitWidth}`
    case 'Pointer':
      return `p${description.addressSpace.value}`
    case 'Vector': {
      const child = state.types.descriptions[description.child]
      if (child === undefined) throw new Error('missing intrinsic overload vector child')
      return `${description.scalable ? 'nxv' : 'v'}${description.length}${mangleDescription(state, child)}`
    }
    case 'Array': {
      const child = state.types.descriptions[description.child]
      if (child === undefined) throw new Error('missing intrinsic overload array child')
      return `a${description.length}${mangleDescription(state, child)}`
    }
    case 'Simple':
      switch (description.tag) {
        case 'Half':
          return 'f16'
        case 'BFloat':
          return 'bf16'
        case 'Float':
          return 'f32'
        case 'Double':
          return 'f64'
        case 'X86Fp80':
          return 'f80'
        case 'Fp128':
          return 'f128'
        case 'PpcFp128':
          return 'ppcf128'
        default:
          return description.tag.toLowerCase()
      }
    case 'Structure':
    case 'NamedStructure':
    case 'Function':
    case 'TargetExtension':
      throw new Error('intrinsic overload type has no canonical LLVM mangling')
  }
}

const intrinsicName = (
  context: BuilderState.Context,
  id: Id,
  overloads: ReadonlyArray<Type.Type>,
): Result.Result<string, LlvmError> => {
  const { builder, state, owner } = context
  const suffix: Array<string> = []
  for (const type of overloads) {
    const index = Handle.resolve(builder, owner, type, 'Type', 'Intrinsic.name')
    if (Result.isFailure(index)) return Result.fail(index.failure)
    const description = state.types.descriptions[index.success]
    if (description === undefined) {
      return Result.fail(
        invalidState({
          operation: 'Intrinsic.name',
          message: 'Intrinsic overload type is missing',
          state: type,
        }),
      )
    }
    const mangled = Result.try({
      try: () => mangleDescription(state, description),
      catch: (cause) =>
        wrappedFailure({
          operation: 'Intrinsic.name',
          message: 'Intrinsic overload type cannot be mangled',
          cause: cause,
        }),
    })
    if (Result.isFailure(mangled)) return Result.fail(mangled.failure)
    suffix.push(mangled.success)
  }
  return Result.succeed(`llvm.${id}${suffix.length === 0 ? '' : `.${suffix.join('.')}`}`)
}

const flagSet = (
  context: BuilderState.Context,
  names: ReadonlyArray<string>,
): Result.Result<Attribute.Set, LlvmError> => {
  const values: Array<Attribute.Attribute> = []
  for (const name of names) {
    const flag = Attribute.flagIn(context, name)
    if (Result.isFailure(flag)) return Result.fail(flag.failure)
    values.push(flag.success)
  }
  return Attribute.setIn(context, values)
}

const flagSets = (
  context: BuilderState.Context,
  groups: ReadonlyArray<ReadonlyArray<string>>,
): Result.Result<ReadonlyArray<Attribute.Set>, LlvmError> => {
  const sets: Array<Attribute.Set> = []
  for (const names of groups) {
    const set = flagSet(context, names)
    if (Result.isFailure(set)) return Result.fail(set.failure)
    sets.push(set.success)
  }
  return Result.succeed(sets)
}

const commonAttributes = (
  context: BuilderState.Context,
  id: Id,
): Result.Result<Attribute.FunctionSet | undefined, LlvmError> => {
  const base = ['nocallback', 'nofree', 'nounwind', 'willreturn']
  if (id === 'assume') {
    const functionAttributes = flagSet(context, [...base, 'nosync'])
    if (Result.isFailure(functionAttributes)) return Result.fail(functionAttributes.failure)
    const parameter = flagSet(context, ['noundef'])
    if (Result.isFailure(parameter)) return Result.fail(parameter.failure)
    return Attribute.functionSetIn(context, {
      functionAttributes: functionAttributes.success,
      parameterAttributes: [parameter.success],
    })
  }
  if (
    id !== 'memcpy' &&
    id !== 'memcpy.inline' &&
    id !== 'memmove' &&
    id !== 'memset' &&
    id !== 'memset.inline'
  ) {
    return Result.succeed(undefined)
  }
  const functionEntries: Array<Attribute.Attribute> = []
  for (const name of base) {
    const flag = Attribute.flagIn(context, name)
    if (Result.isFailure(flag)) return Result.fail(flag.failure)
    functionEntries.push(flag.success)
  }
  const memory = Attribute.integerIn(
    context,
    'memory',
    id === 'memset' || id === 'memset.inline' ? 2 : 3,
  )
  if (Result.isFailure(memory)) return Result.fail(memory.failure)
  functionEntries.push(memory.success)
  const destination =
    id === 'memcpy' || id === 'memcpy.inline'
      ? ['noalias', 'nocapture', 'writeonly']
      : ['nocapture', 'writeonly']
  const source =
    id === 'memcpy' || id === 'memcpy.inline'
      ? ['noalias', 'nocapture', 'readonly']
      : ['nocapture', 'readonly']
  const parameters = flagSets(
    context,
    id === 'memset' || id === 'memset.inline'
      ? [destination, [], [], ['immarg']]
      : [destination, source, [], ['immarg']],
  )
  if (Result.isFailure(parameters)) return Result.fail(parameters.failure)
  const functionAttributes = Attribute.setIn(context, functionEntries)
  if (Result.isFailure(functionAttributes)) return Result.fail(functionAttributes.failure)
  return Attribute.functionSetIn(context, {
    functionAttributes: functionAttributes.success,
    parameterAttributes: parameters.success,
  })
}

/**
 * Declares or retrieves a canonically mangled LLVM intrinsic.
 *
 * **Details**
 *
 * Common and memory intrinsics have built-in signature recipes. Other catalog entries require an
 * explicit signature; overload types form the LLVM name suffix and must have canonical manglings.
 *
 * **Example** (Resolving an intrinsic)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Intrinsic from '@silklang/llvm/Intrinsic'
 *
 * const trap = await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   return yield* Intrinsic.resolve(builder, 'trap')
 * }))
 * ```
 *
 * @category intrinsics
 * @since 0.0.0
 */
export const resolve = (
  builder: Builder.Builder,
  id: Id,
  overloads: ReadonlyArray<Type.Type> = [],
  options: ResolveOptions = {},
): Effect.Effect<FunctionActor.Function, LlvmError> =>
  BuilderState.transition(builder, 'Intrinsic.resolve', (context) =>
    resolveIn(context, id, overloads, options),
  )

/**
 * Default resolutions (no explicit signature or attributes) are cached per builder. Checked
 * arithmetic, traps, and memory copies resolve the same intrinsic at every emitted site, and
 * rebuilding its signature, attribute sets, and mangled name dominated their emission cost in the
 * self-hosted compiler build. A cached declaration is reused only while it is unchanged, so an
 * incompatible later edit still reaches `Function.declare` and fails there.
 *
 * @internal
 */
export const resolveIn = (
  context: BuilderState.Context,
  id: Id,
  overloads: ReadonlyArray<Type.Type> = [],
  options: ResolveOptions = {},
): Result.Result<FunctionActor.Function, LlvmError> => {
  if (!inventory.includes(id)) {
    return Result.fail(
      invalidState({
        operation: 'Intrinsic.resolve',
        message: 'Unknown pinned LLVM intrinsic',
        state: id,
      }),
    )
  }
  const { state, owner } = context
  let key: string | undefined
  if (options.signature === undefined && options.attributes === undefined) {
    key = id
    for (const type of overloads) {
      const index = Handle.indexOf(type)
      if (index === undefined || Handle.ownerOf(type)?.token !== owner.token) {
        key = undefined
        break
      }
      key += `\u0000${index}`
    }
  }
  const entry = key === undefined ? undefined : state.intrinsics.get(key)
  if (entry !== undefined) {
    const description = state.globals.functions.descriptions[entry.index]
    if (
      description !== undefined &&
      description.type === entry.type &&
      description.attributes === entry.attributes &&
      description.callingConvention === 0 &&
      description.personality === undefined
    ) {
      return Result.succeed(entry.function)
    }
  }
  const recipe = overloadedRecipes[id]
  const simple = simpleRecipes[id]
  let signature = options.signature
  if (signature === undefined) {
    let made: Result.Result<ExplicitSignature, LlvmError> | undefined
    if (recipe !== undefined) made = recipe(context, overloads)
    else if (simple !== undefined) made = simple(context)
    if (made !== undefined && Result.isFailure(made)) return Result.fail(made.failure)
    signature = made?.success
  }
  if (signature === undefined) {
    return Result.fail(
      invalidInput({
        operation: 'Intrinsic.resolve',
        message: 'This intrinsic requires an explicit typed signature',
        input: { id, overloads },
      }),
    )
  }
  const variadic = 'variadic' in signature ? signature.variadic : undefined
  const type = Type.functionTypeIn(
    context,
    signature.returnType,
    signature.parameters,
    variadic === undefined ? {} : { variadic },
  )
  if (Result.isFailure(type)) return Result.fail(type.failure)
  let attributes = options.attributes
  if (attributes === undefined) {
    const common = commonAttributes(context, id)
    if (Result.isFailure(common)) return Result.fail(common.failure)
    attributes = common.success
  }
  const name = intrinsicName(context, id, overloads)
  if (Result.isFailure(name)) return Result.fail(name.failure)
  const declared = FunctionActor.declareIn(
    context,
    name.success,
    type.success,
    attributes === undefined ? {} : { attributes },
  )
  if (Result.isFailure(declared)) return declared
  if (key !== undefined) {
    const index = Handle.indexOf(declared.success)
    const description =
      index === undefined ? undefined : state.globals.functions.descriptions[index]
    if (index !== undefined && description !== undefined) {
      state.intrinsics.set(key, {
        function: declared.success,
        index,
        type: description.type,
        attributes: description.attributes,
      })
    }
  }
  return declared
}

/** Every aligned copy of one intrinsic rebuilds the same derived set; cache it per builder. */
const memoryCallAttributes = (
  context: BuilderState.Context,
  intrinsic: FunctionActor.Function,
  alignments: ReadonlyArray<Alignment.Alignment | undefined>,
): Result.Result<Attribute.FunctionSet | undefined, LlvmError> => {
  const properties = FunctionActor.propertiesIn(context, intrinsic)
  if (Result.isFailure(properties)) return Result.fail(properties.failure)
  const canonical = properties.success.attributes
  if (
    canonical === undefined ||
    alignments.every((alignment) => alignment?.byteUnits === undefined)
  ) {
    return Result.succeed(canonical)
  }
  const key = `${Handle.indexOf(canonical)}\u0000${alignments
    .map((alignment) => alignment?.byteUnits ?? '')
    .join('\u0000')}`
  const cached = context.state.memoryCallAttributes.get(key)
  if (cached !== undefined) return Result.succeed(cached)
  const entries = Attribute.functionSetEntriesIn(context, canonical)
  if (Result.isFailure(entries)) return Result.fail(entries.failure)
  const parameters: Array<Attribute.Set> = []
  const length = Math.max(entries.success.parameterAttributes.length, alignments.length)
  for (let index = 0; index < length; index += 1) {
    let base = entries.success.parameterAttributes[index]
    if (base === undefined) {
      const empty = Attribute.setIn(context, [])
      if (Result.isFailure(empty)) return Result.fail(empty.failure)
      base = empty.success
    }
    const alignment = alignments[index]
    if (alignment?.byteUnits === undefined) {
      parameters.push(base)
      continue
    }
    const align = Attribute.integerIn(context, 'align', alignment.byteUnits)
    if (Result.isFailure(align)) return Result.fail(align.failure)
    const added = Attribute.addIn(context, base, align.success)
    if (Result.isFailure(added)) return Result.fail(added.failure)
    parameters.push(added.success)
  }
  const attributes = Attribute.functionSetIn(context, {
    functionAttributes: entries.success.functionAttributes,
    returnAttributes: entries.success.returnAttributes,
    parameterAttributes: parameters,
  })
  if (Result.isSuccess(attributes)) context.state.memoryCallAttributes.set(key, attributes.success)
  return attributes
}

/**
 * Resolves an intrinsic and appends a direct, type-checked call in one operation.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export const call = (
  body: FunctionBody.FunctionBody,
  id: Id,
  overloads: ReadonlyArray<Type.Type>,
  args: ReadonlyArray<Value.Input>,
  name?: string,
  options: ResolveOptions = {},
): Effect.Effect<Value.Value | undefined, LlvmError> =>
  FunctionBodyState.mutate(body, 'Intrinsic.call', (draft) =>
    callIn(draft, id, overloads, args, name, options),
  )

/** @internal */
export const callIn = (
  draft: FunctionBodyState.Draft,
  id: Id,
  overloads: ReadonlyArray<Type.Type>,
  args: ReadonlyArray<Value.Input>,
  name?: string,
  options: ResolveOptions = {},
): Result.Result<Value.Value | undefined, LlvmError> =>
  Result.flatMap(resolveIn(draft.context, id, overloads, options), (intrinsic) =>
    FunctionBodyActor.callDirectIn(draft, intrinsic, args, name),
  )

/**
 * Emits `llvm.assume(true)` with an empty `cold` operand bundle as an optimization hint.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export const assumeCold = (body: FunctionBody.FunctionBody): Effect.Effect<void, LlvmError> =>
  FunctionBodyState.mutate(body, 'Intrinsic.assumeCold', (draft) => {
    const assume = resolveIn(draft.context, 'assume')
    if (Result.isFailure(assume)) return Result.fail(assume.failure)
    const i1 = integerType(draft.context, 1)
    if (Result.isFailure(i1)) return Result.fail(i1.failure)
    const condition = Constant.integerOfIn(draft.context, i1.success, 1, false)
    if (Result.isFailure(condition)) return Result.fail(condition.failure)
    return voidResult(
      FunctionBodyActor.callDirectIn(draft, assume.success, [condition.success], undefined, {
        operandBundles: [{ tag: 'cold', operands: [] }],
      }),
    )
  })

const voidResult = <A>(result: Result.Result<A, LlvmError>): Result.Result<void, LlvmError> =>
  Result.map(result, () => undefined)

/** Emits one memory intrinsic call with its canonical and alignment-derived attributes. */
const memoryCall = (
  draft: FunctionBodyState.Draft,
  id: Id,
  overloadInputs: ReadonlyArray<Value.Input>,
  args: ReadonlyArray<Value.Input>,
  volatile: boolean | undefined,
  alignments: ReadonlyArray<Alignment.Alignment | undefined>,
): Result.Result<void, LlvmError> => {
  const overloads: Array<Type.Type> = []
  for (const input of overloadInputs) {
    const type = FunctionBodyActor.inputTypeIn(draft, input)
    if (Result.isFailure(type)) return Result.fail(type.failure)
    overloads.push(type.success)
  }
  const intrinsic = resolveIn(draft.context, id, overloads)
  if (Result.isFailure(intrinsic)) return Result.fail(intrinsic.failure)
  const i1 = integerType(draft.context, 1)
  if (Result.isFailure(i1)) return Result.fail(i1.failure)
  const volatileFlag = Constant.integerOfIn(draft.context, i1.success, volatile ? 1 : 0, false)
  if (Result.isFailure(volatileFlag)) return Result.fail(volatileFlag.failure)
  const attributes = memoryCallAttributes(draft.context, intrinsic.success, alignments)
  if (Result.isFailure(attributes)) return Result.fail(attributes.failure)
  return voidResult(
    FunctionBodyActor.callDirectIn(
      draft,
      intrinsic.success,
      [...args, volatileFlag.success],
      undefined,
      attributes.success === undefined ? {} : { attributes: attributes.success },
    ),
  )
}

/**
 * Emits typed `llvm.memcpy` or `llvm.memcpy.inline` with canonical attributes.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export const memcpy = (
  body: FunctionBody.FunctionBody,
  destination: Value.Input,
  source: Value.Input,
  length: Value.Input,
  options: MemoryCopyOptions = {},
): Effect.Effect<void, LlvmError> =>
  FunctionBodyState.mutate(body, 'Intrinsic.memcpy', (draft) =>
    memcpyIn(draft, destination, source, length, options),
  )

/** @internal */
export const memcpyIn = (
  draft: FunctionBodyState.Draft,
  destination: Value.Input,
  source: Value.Input,
  length: Value.Input,
  options: MemoryCopyOptions = {},
): Result.Result<void, LlvmError> =>
  memoryCall(
    draft,
    options.inline ? 'memcpy.inline' : 'memcpy',
    [destination, source, length],
    [destination, source, length],
    options.volatile,
    [options.destinationAlignment, options.sourceAlignment],
  )

/**
 * Emits typed `llvm.memmove` with canonical attributes and optional alignments.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export const memmove = (
  body: FunctionBody.FunctionBody,
  destination: Value.Input,
  source: Value.Input,
  length: Value.Input,
  options: Omit<MemoryCopyOptions, 'inline'> = {},
): Effect.Effect<void, LlvmError> =>
  FunctionBodyState.mutate(body, 'Intrinsic.memmove', (draft) =>
    memmoveIn(draft, destination, source, length, options),
  )

/** @internal */
export const memmoveIn = (
  draft: FunctionBodyState.Draft,
  destination: Value.Input,
  source: Value.Input,
  length: Value.Input,
  options: Omit<MemoryCopyOptions, 'inline'> = {},
): Result.Result<void, LlvmError> =>
  memoryCall(
    draft,
    'memmove',
    [destination, source, length],
    [destination, source, length],
    options.volatile,
    [options.destinationAlignment, options.sourceAlignment],
  )

/**
 * Emits typed `llvm.memset` or `llvm.memset.inline` with canonical attributes.
 *
 * @category intrinsics
 * @since 0.0.0
 */
export const memset = (
  body: FunctionBody.FunctionBody,
  destination: Value.Input,
  byte: Value.Input,
  length: Value.Input,
  options: MemorySetOptions = {},
): Effect.Effect<void, LlvmError> =>
  FunctionBodyState.mutate(body, 'Intrinsic.memset', (draft) =>
    memsetIn(draft, destination, byte, length, options),
  )

/** @internal */
export const memsetIn = (
  draft: FunctionBodyState.Draft,
  destination: Value.Input,
  byte: Value.Input,
  length: Value.Input,
  options: MemorySetOptions = {},
): Result.Result<void, LlvmError> =>
  memoryCall(
    draft,
    options.inline ? 'memset.inline' : 'memset',
    [destination, length],
    [destination, byte, length],
    options.volatile,
    [options.destinationAlignment],
  )
