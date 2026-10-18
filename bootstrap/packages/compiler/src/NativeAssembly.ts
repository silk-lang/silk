import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as Diagnostic from './Diagnostic.js'
import * as Location from './Location.js'
import * as Elaboration from './Elaboration.js'
import type * as Tir from './Tir.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as Target from './Target.js'
import * as Type from './Type.js'
import * as Canonical from './internal/Canonical.js'

/** The exact text one elaborated literal operand denotes, decoded when the fact was built. */
const literalText = (
  expression: Elaboration.ExpressionDecision | Tir.Expression,
): string | undefined => {
  if (expression._tag === 'StaticText' && expression.data !== undefined)
    return new TextDecoder().decode(Uint8Array.from(expression.data.bytes))
  if (expression._tag === 'StaticStringLiteral' || expression._tag === 'StaticByteViewLiteral')
    return new TextDecoder().decode(Uint8Array.from(expression.data.bytes))
  return undefined
}

/** Validated function-local machine text and its exact register/effect contract. */
export interface NativeAssembly {
  readonly template: string
  readonly constraints: string
  readonly clobbers: ReadonlyArray<string>
  readonly memory: 'none' | 'read' | 'write' | 'readwrite'
  readonly sideEffects: boolean
  readonly noReturn: boolean
  readonly output?: string
  readonly inputs: ReadonlyArray<string>
}

/** Literal source fields before target/register admission. */
export interface Input {
  readonly template: string
  readonly constraints: string
  readonly clobbers: string
  readonly memory: string
  readonly sideEffects: boolean
  readonly noReturn: boolean
}

const x86 = ['rax', 'rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9', 'r10', 'r11']
const arm = Array.from({ length: 18 }, (_, index) => `x${index}`)

/** The deliberately narrow machine lane subset, excluding language references and storage handles. */
export const lane = (type: Type.Type): 'word' | 'pointer' | undefined => {
  if (type === 'i64' || type === 'u64' || type === 'isize' || type === 'usize') return 'word'
  if (Type.isPointer(type) && type.addressSpace === 0) return 'pointer'
  return undefined
}

/** Whether a concrete native target admits the source assembly facility. */
export const available = (target: Target.Target): boolean =>
  target.id === 'x86_64-unknown-linux-gnu' || target.id === 'aarch64-unknown-linux-gnu'

const inspect = (
  input: Input,
  result: Type.Type,
  operands: ReadonlyArray<Type.Type>,
  target?: Target.Target,
): Result.Result<NativeAssembly, string> => {
  const fail = (detail: string) => Result.fail(detail)
  if (target !== undefined && !available(target)) return fail('assembly target')
  if (!Type.equals(result, Type.unit) && lane(result) === undefined)
    return fail('assembly result lane')
  if (operands.length > 7 || operands.some((type) => lane(type) === undefined))
    return fail('assembly operand lanes')
  const memory = input.memory
  if (memory !== 'none' && memory !== 'read' && memory !== 'write' && memory !== 'readwrite')
    return fail('assembly memory contract')
  if ((memory === 'write' || memory === 'readwrite') && !input.sideEffects)
    return fail('assembly writes require side effects')
  if (input.noReturn && (!Type.equals(result, Type.unit) || !input.sideEffects))
    return fail('assembly no-return contract')
  if (
    Array.from(input.template).some((character) => {
      const code = character.charCodeAt(0)
      return code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126)
    })
  )
    return fail('assembly template encoding')
  if (/(?:^|[\n;])\s*\.[A-Za-z_][A-Za-z_0-9]*(?![A-Za-z_0-9]*:)/.test(input.template))
    return fail('assembly module directives')
  let registers = [...x86, ...arm]
  if (target !== undefined) registers = target.id === 'x86_64-unknown-linux-gnu' ? x86 : arm
  const parts = input.constraints === '' ? [] : input.constraints.split(',')
  const hasOutput = !Type.equals(result, Type.unit)
  if (parts.length !== operands.length + (hasOutput ? 1 : 0))
    return fail('assembly constraint cardinality')
  const output = hasOutput ? /^=&?\{([a-z][a-z0-9]*)\}$/.exec(parts[0] ?? '')?.[1] : undefined
  if (hasOutput && (output === undefined || !registers.includes(output)))
    return fail('assembly output register')
  const inputs = parts.slice(hasOutput ? 1 : 0)
  const occupied = new Set<string>()
  if (output !== undefined) occupied.add(output)
  let tied = false
  for (const [index, constraint] of inputs.entries()) {
    if (constraint === '0') {
      const operand = operands[index]
      if (output === undefined || tied || operand === undefined || lane(operand) !== lane(result))
        return fail('assembly tied operand')
      tied = true
      continue
    }
    const register = /^\{([a-z][a-z0-9]*)\}$/.exec(constraint)?.[1]
    if (register === undefined || !registers.includes(register) || occupied.has(register))
      return fail('assembly conflicting input register')
    occupied.add(register)
  }
  const clobbers = input.clobbers === '' ? [] : input.clobbers.split(',')
  for (const register of clobbers) {
    if ((register !== 'flags' && !registers.includes(register)) || occupied.has(register))
      return fail('assembly conflicting clobber')
    occupied.add(register)
  }
  const references = input.template.replaceAll('$$', '').matchAll(/\$(\d+|\{[^}]*\}|[^\d]?)/g)
  for (const reference of references) {
    const ordinal = reference[1]
    if (
      ordinal === undefined ||
      !/^(0|[1-9][0-9]*)$/.test(ordinal) ||
      Number(ordinal) >= parts.length
    )
      return fail('assembly template operand reference')
  }
  return Result.succeed({
    ...input,
    memory,
    clobbers: clobbers,
    inputs: inputs,
    ...(output === undefined ? {} : { output }),
  })
}

/** Validates an explicit machine contract at a public Effect boundary. */
export const decode = Effect.fn('NativeAssembly.decode')(function* (
  input: Input,
  result: Type.Type,
  operands: ReadonlyArray<Type.Type>,
  target?: Target.Target,
): Effect.fn.Return<NativeAssembly, ConfigurationError.ConfigurationError> {
  const checked = inspect(input, result, operands, target)
  if (Result.isFailure(checked))
    return yield* ConfigurationError.make('NativeAssembly.decode', 'InvalidInput', checked.failure)
  return checked.success
})

/** Encodes all machine facts independently of source location. */
export const encode = (self: NativeAssembly): string =>
  Canonical.record('NativeAssembly.v1', [
    self.template,
    self.constraints,
    Canonical.array(self.clobbers),
    self.memory,
    String(self.sideEffects),
    String(self.noReturn),
    self.output ?? '',
    Canonical.array(self.inputs),
  ])

/** Converts admitted logical clobbers to the selected LLVM architecture spelling. */
export const llvmConstraints = (self: NativeAssembly, target: Target.Target): string =>
  [
    self.constraints,
    ...self.clobbers.map(
      (register) =>
        `~{${register === 'flags' && target.id === 'aarch64-unknown-linux-gnu' ? 'cc' : register}}`,
    ),
    ...(self.memory === 'none' ? [] : ['~{memory}']),
  ]
    .filter((part) => part !== '')
    .join(',')

/** Checks literal source arguments before residualization; unsafe acknowledgement is checked by calls. */
export const analyze = (
  context: SemanticContext.SemanticContext,
  arguments_: ReadonlyArray<Elaboration.ArgumentFact>,
  result: Type.Type,
  call: AuthoredHir.Anchor,
  target?: Target.Target,
): {
  readonly assembly?: NativeAssembly
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const span = context.spanOf(call)
  const reject = (detail: string, at = call) => ({
    diagnostics: [
      Diagnostic.invalidAuthoredConfiguration(
        ConfigurationError.make('NativeAssembly.analyze', 'InvalidInput', detail, [
          { ...ConfigurationOrigin.literal(span.sourceId), span: context.spanOf(at) },
        ]),
        Location.at(at),
      ),
    ],
  })
  if (arguments_.length !== 7) return reject('assembly argument cardinality')
  const texts = arguments_.slice(0, 4).map((argument) => literalText(argument.expression))
  const template = texts[0],
    constraints = texts[1],
    clobbers = texts[2],
    memory = texts[3]
  const sideEffects = arguments_[4]?.expression,
    noReturn = arguments_[5]?.expression
  const tuple = arguments_[6]?.expression
  if (
    template === undefined ||
    constraints === undefined ||
    clobbers === undefined ||
    memory === undefined ||
    sideEffects?._tag !== 'BooleanLiteral' ||
    noReturn?._tag !== 'BooleanLiteral'
  )
    return reject('assembly metadata must be literal')
  const operands: Array<Type.Type> = []
  // A tuple literal is an occurrence-generated struct: it names no source constructor.
  if (tuple?._tag === 'Construct') {
    for (const field of tuple.fields) {
      const expression = field.value
      const type = Elaboration.constructionExpressionType(expression)
      if (type._tag !== 'Available')
        return reject('assembly operand type', Elaboration.constructionExpressionAnchor(expression))
      operands.push(type.type)
    }
  } else if (tuple?._tag !== 'UnitLiteral') return reject('assembly inputs require a tuple literal')
  const checked = inspect(
    {
      template,
      constraints,
      clobbers,
      memory,
      sideEffects: sideEffects.value,
      noReturn: noReturn.value,
    },
    result,
    operands,
    target,
  )
  if (Result.isFailure(checked)) return reject(checked.failure)
  return { assembly: checked.success, diagnostics: [] }
}

/** Checks independently supplied MIR metadata against the actual target and operand lanes. */
export const violations = (
  self: NativeAssembly,
  result: Type.Type,
  operands: ReadonlyArray<Type.Type>,
  target: Target.Target,
): ReadonlyArray<string> => {
  const checked = inspect({ ...self, clobbers: self.clobbers.join(',') }, result, operands, target)
  if (Result.isFailure(checked)) return [checked.failure]
  return encode(self) === encode(checked.success) ? [] : ['assembly metadata normalization']
}
