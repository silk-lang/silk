import * as Effect from 'effect/Effect'
import type * as Builder from './Builder.js'
import * as ByteString from './ByteString.js'
import * as BuilderState from './internal/BuilderState.js'
import * as FunctionBodyDescription from './internal/FunctionBodyDescription.js'
import * as LocalName from './internal/LocalName.js'
import type { LlvmError } from './LlvmError.js'
import * as PackedBody from './internal/PackedBody.js'

/**
 * The module verifier: the in-process equivalent of `opt -passes=verify` over a {@link Builder}
 * before its bitcode is handed to an external toolchain.
 *
 * **Details**
 *
 * `FunctionBody.commit` already rejects a body whose blocks are unterminated, whose phis do not
 * cover their predecessors, or whose forward references were never resolved. What it cannot see is
 * whether the resulting graph is still valid SSA: an instruction may define a value on one path
 * and be used on another that never passes through the definition. Ubuntu's Clang is built with
 * assertions disabled, so it does not run the LLVM verifier on `-x ir` input — an invalid module
 * reaches codegen and fails as a crash in an arbitrary pass, or does not fail at all.
 *
 * Verification therefore runs over the committed function bodies, which are exactly what
 * `Bitcode.encode` serializes, rather than over rendered IR text.
 *
 * @since 0.0.0
 */

/**
 * One verifier finding, naming the function it was found in.
 *
 * @category models
 * @since 0.0.0
 */
export interface Violation {
  /** The offending function's IR identifier, including the leading `@`. */
  readonly function: string
  /** The LLVM verifier's wording for this class of violation. */
  readonly message: string
  /** Indented lines naming the specific values, blocks, and instructions involved. */
  readonly detail: ReadonlyArray<string>
}

/** @internal */
const identifier = (prefix: '@' | '%', value: ByteString.ByteString): string => {
  let ascii = ''
  for (const byte of value.bytes) ascii += String.fromCharCode(byte)
  return /^[-A-Za-z$._][-A-Za-z$._0-9]*$/.test(ascii) || /^\d+$/.test(ascii)
    ? `${prefix}${ascii}`
    : `${prefix}"${ByteString.escapeForIr(value)}"`
}

/** @internal */
const localIdentifier = (body: FunctionBodyDescription.Snapshot, index: number): string => {
  const name = body.values[index]?.name
  return identifier(
    '%',
    LocalName.toByteString(name === undefined || LocalName.isEmpty(name) ? `v${index}` : name),
  )
}

/** @internal */
const blockIdentifier = (body: FunctionBodyDescription.Snapshot, index: number): string => {
  const name = body.blocks[index]?.name
  return identifier(
    '%',
    LocalName.toByteString(name === undefined || LocalName.isEmpty(name) ? `bb${index}` : name),
  )
}

/** @internal */
const describeInstruction = (
  body: FunctionBodyDescription.Snapshot,
  instruction: FunctionBodyDescription.Instruction,
): string => {
  const operation = instruction._tag === 'Binary' ? instruction.kind : instruction._tag
  return instruction.result === undefined
    ? operation
    : `${localIdentifier(body, instruction.result)} = ${operation}`
}

/**
 * Resolves a forward-reference chain to the operand it was finally bound to.
 *
 * @internal
 */
const resolveOperand = (
  body: FunctionBodyDescription.Snapshot,
  operand: FunctionBodyDescription.Operand,
): FunctionBodyDescription.Operand => {
  let current = operand
  const seen = new Set<number>()
  while (current._tag === 'Local') {
    const value = body.values[current.value]
    if (value?.source._tag !== 'Forward' || value.source.resolved === undefined) return current
    if (seen.has(current.value)) return current
    seen.add(current.value)
    current = value.source.resolved
  }
  return current
}

/**
 * Every local value an instruction reads, excluding phi incoming values — those are checked
 * against their incoming edge rather than against the instruction's own position.
 *
 * The switch is exhaustive by construction: a new instruction kind fails to typecheck here until
 * its operands are listed, so the verifier cannot silently stop looking at part of the module.
 *
 * @internal
 */
const operandsOf = (
  instruction: FunctionBodyDescription.Instruction,
): ReadonlyArray<FunctionBodyDescription.Operand> => {
  switch (instruction._tag) {
    case 'Unary':
      return [instruction.operand]
    case 'Binary':
    case 'Compare':
      return [instruction.left, instruction.right]
    case 'Select':
      return [instruction.condition, instruction.onTrue, instruction.onFalse]
    case 'Cast':
      return [instruction.operand]
    case 'Freeze':
      return [instruction.operand]
    case 'ExtractValue':
      return [instruction.aggregate]
    case 'InsertValue':
      return [instruction.aggregate, instruction.element]
    case 'Alloca':
      return [instruction.count]
    case 'Load':
      return [instruction.pointer]
    case 'Store':
      return [instruction.value, instruction.pointer]
    case 'GetElementPtr':
      return [instruction.base, ...instruction.indices]
    case 'ExtractElement':
      return [instruction.vector, instruction.index]
    case 'InsertElement':
      return [instruction.vector, instruction.element, instruction.index]
    case 'ShuffleVector':
      return [instruction.left, instruction.right, instruction.mask]
    case 'CompareExchange':
      return [instruction.pointer, instruction.comparison, instruction.replacement]
    case 'AtomicRmw':
      return [instruction.pointer, instruction.value]
    case 'VaArg':
      return [instruction.list]
    case 'IndirectBranch':
      return [instruction.address]
    case 'ConditionalBranch':
      return [instruction.condition]
    case 'Switch':
      return [instruction.value]
    case 'Return':
      return [instruction.value]
    case 'Invoke':
    case 'Call':
      return [
        instruction.callee,
        ...instruction.arguments,
        ...instruction.operandBundles.flatMap((bundle) => bundle.operands),
      ]
    case 'LandingPad':
    case 'Fence':
    case 'Branch':
    case 'ReturnVoid':
    case 'Unreachable':
      return []
    case 'Phi':
      return []
    default:
      return instruction satisfies never
  }
}

/** @internal */
const successorsOf = (instruction: FunctionBodyDescription.Instruction): ReadonlyArray<number> => {
  switch (instruction._tag) {
    case 'Invoke':
      return [instruction.normal, instruction.unwind]
    case 'Branch':
      return [instruction.destination]
    case 'ConditionalBranch':
      return [instruction.onTrue, instruction.onFalse]
    case 'Switch':
      return [instruction.defaultBlock, ...instruction.cases.map((entry) => entry.block)]
    case 'IndirectBranch':
      return instruction.destinations
    default:
      return []
  }
}

interface Definition {
  readonly block: number
  readonly position: number
}

/**
 * The immediate-dominator array over the reachable blocks, by the Cooper-Harvey-Kennedy iteration.
 * Unreachable blocks keep `undefined`, matching LLVM: a use inside unreachable code is dominated
 * by every definition, so it is never reported.
 *
 * The loop is per-block-per-edge and runs on every emitted function, so it is written imperatively.
 *
 * @internal
 */
const dominators = (
  successors: ReadonlyArray<ReadonlyArray<number>>,
): ReadonlyArray<number | undefined> => {
  const count = successors.length
  const postorder: Array<number> = []
  const visited = Array.from({ length: count }, () => false)
  const stack: Array<{ block: number; edge: number }> = []
  if (count > 0) {
    visited[0] = true
    stack.push({ block: 0, edge: 0 })
  }
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame === undefined) break
    const edges = successors[frame.block] ?? []
    if (frame.edge < edges.length) {
      const next = edges[frame.edge]
      frame.edge += 1
      if (next !== undefined && next < count && visited[next] !== true) {
        visited[next] = true
        stack.push({ block: next, edge: 0 })
      }
      continue
    }
    postorder.push(frame.block)
    stack.pop()
  }

  const order = [...postorder].reverse()
  const postorderIndex = Array.from({ length: count }, () => -1)
  for (let index = 0; index < postorder.length; index += 1) {
    const block = postorder[index]
    if (block !== undefined) postorderIndex[block] = index
  }

  const predecessors: Array<Array<number>> = Array.from({ length: count }, () => [])
  for (let block = 0; block < count; block += 1) {
    if (visited[block] !== true) continue
    for (const successor of successors[block] ?? []) {
      if (successor < count) predecessors[successor]?.push(block)
    }
  }

  const immediate: Array<number | undefined> = Array.from({ length: count }, () => undefined)
  if (count > 0) immediate[0] = 0
  const intersect = (left: number, right: number): number => {
    let first = left
    let second = right
    while (first !== second) {
      while ((postorderIndex[first] ?? -1) < (postorderIndex[second] ?? -1)) {
        const next = immediate[first]
        if (next === undefined || next === first) return second
        first = next
      }
      while ((postorderIndex[second] ?? -1) < (postorderIndex[first] ?? -1)) {
        const next = immediate[second]
        if (next === undefined || next === second) return first
        second = next
      }
    }
    return first
  }
  let changed = true
  while (changed) {
    changed = false
    for (const block of order) {
      if (block === 0) continue
      let candidate: number | undefined
      for (const predecessor of predecessors[block] ?? []) {
        if (immediate[predecessor] === undefined) continue
        candidate = candidate === undefined ? predecessor : intersect(candidate, predecessor)
      }
      if (candidate !== undefined && immediate[block] !== candidate) {
        immediate[block] = candidate
        changed = true
      }
    }
  }
  return immediate
}

interface DominatorIntervals {
  readonly tin: ReadonlyArray<number>
  readonly tout: ReadonlyArray<number>
}

/**
 * Assigns entry/exit times of one DFS over the dominator tree so `dominates` answers in constant
 * time; the previous per-query walk up the immediate-dominator chain was quadratic on the long
 * single-successor chains coroutine resume dispatch emits.
 *
 * @internal
 */
const dominatorIntervals = (immediate: ReadonlyArray<number | undefined>): DominatorIntervals => {
  const count = immediate.length
  const children: Array<Array<number>> = Array.from({ length: count }, () => [])
  for (let block = 1; block < count; block += 1) {
    const parent = immediate[block]
    if (parent !== undefined && parent !== block) children[parent]?.push(block)
  }
  const tin = Array.from({ length: count }, () => -1)
  const tout = Array.from({ length: count }, () => -1)
  if (count === 0 || immediate[0] === undefined) return { tin, tout }
  let clock = 0
  const stack: Array<{ readonly block: number; cursor: number }> = [{ block: 0, cursor: 0 }]
  tin[0] = clock
  clock += 1
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame === undefined) break
    const child = children[frame.block]?.[frame.cursor]
    if (child === undefined) {
      tout[frame.block] = clock
      clock += 1
      stack.pop()
      continue
    }
    frame.cursor += 1
    tin[child] = clock
    clock += 1
    stack.push({ block: child, cursor: 0 })
  }
  return { tin, tout }
}

/** @internal */
const dominates = (intervals: DominatorIntervals, ancestor: number, block: number): boolean => {
  if (ancestor === block) return true
  const ancestorIn = intervals.tin[ancestor] ?? -1
  const blockIn = intervals.tin[block] ?? -1
  if (ancestorIn < 0 || blockIn < 0) return false
  return ancestorIn < blockIn && (intervals.tout[block] ?? -1) < (intervals.tout[ancestor] ?? -1)
}

/** @internal */
const verifyFunction = (
  name: string,
  body: FunctionBodyDescription.Snapshot,
  personality: number | undefined,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = []
  const report = (message: string, detail: ReadonlyArray<string>): void => {
    violations.push({ function: name, message, detail: [...detail] })
  }

  const definitions = new Map<number, Definition>()
  for (let block = 0; block < body.blocks.length; block += 1) {
    const instructions = body.blocks[block]?.instructions ?? []
    for (let position = 0; position < instructions.length; position += 1) {
      const index = instructions[position]
      if (index === undefined) continue
      definitions.set(index, { block, position })
    }
  }

  const successors = body.blocks.map((block) => {
    const terminator = block.instructions.at(-1)
    const instruction = terminator === undefined ? undefined : body.instructions[terminator]
    return instruction === undefined ? [] : successorsOf(instruction)
  })
  for (let block = 0; block < body.blocks.length; block += 1) {
    const entries = (body.blocks[block]?.instructions ?? []).flatMap(
      (index) => body.instructions[index] ?? [],
    )
    const first = entries.find((instruction) => instruction._tag !== 'Phi')
    const landingPads = entries.filter((instruction) => instruction._tag === 'LandingPad')
    if (landingPads.length > 0) {
      const predecessors = successors.flatMap((destinations, index) =>
        destinations.includes(block) ? [index] : [],
      )
      if (personality === undefined)
        report('Landing pad requires a personality function!', [blockIdentifier(body, block)])
      if (first?._tag !== 'LandingPad' || landingPads.length !== 1)
        report('Landing pad must be the first non-PHI instruction!', [blockIdentifier(body, block)])
      if (
        block === 0 ||
        predecessors.some((index) => {
          const terminator = body.blocks[index]?.instructions.at(-1)
          const instruction = terminator === undefined ? undefined : body.instructions[terminator]
          return (
            instruction?._tag !== 'Invoke' ||
            instruction.unwind !== block ||
            instruction.normal === block
          )
        })
      )
        report('Landing pad has a non-unwind predecessor!', [blockIdentifier(body, block)])
    }
    for (const instruction of entries) {
      if (instruction._tag !== 'Invoke') continue
      const destination = body.blocks[instruction.unwind]?.instructions
        .map((index) => body.instructions[index])
        .find((entry) => entry?._tag !== 'Phi')
      if (destination?._tag !== 'LandingPad')
        report('Invoke unwind destination requires a landing pad!', [blockIdentifier(body, block)])
    }
  }
  // An invoke defines its result on the normal edge, not in either endpoint block. Split that
  // edge for dominance so a second predecessor cannot manufacture an available result.
  const dominanceGraph = [...successors]
  const invokeEdges = new Map<number, number>()
  for (let block = 0; block < body.blocks.length; block += 1) {
    const index = body.blocks[block]?.instructions.at(-1)
    const instruction = index === undefined ? undefined : body.instructions[index]
    if (index === undefined || instruction?._tag !== 'Invoke' || instruction.result === undefined)
      continue
    const edge = dominanceGraph.length
    invokeEdges.set(index, edge)
    dominanceGraph[block] = [edge, instruction.unwind]
    dominanceGraph.push([instruction.normal])
  }
  const immediate = dominators(dominanceGraph)
  const intervals = dominatorIntervals(immediate)

  /** The block and position defining a local value, or `undefined` for an argument. */
  const definitionOf = (value: number): Definition | 'argument' | 'missing' => {
    const description = body.values[value]
    if (description === undefined) return 'missing'
    if (description.source._tag === 'Argument') return 'argument'
    if (description.source._tag === 'Forward') return 'missing'
    return definitions.get(description.source.instruction) ?? 'missing'
  }

  for (let block = 0; block < body.blocks.length; block += 1) {
    const description = body.blocks[block]
    if (description === undefined) continue
    // A use inside unreachable code is dominated by every definition, exactly as LLVM's
    // DominatorTree reports it. Reporting those would flag correct modules.
    const reachable = immediate[block] !== undefined
    const instructions = description.instructions
    let seenNonPhi = false
    for (let position = 0; position < instructions.length; position += 1) {
      const index = instructions[position]
      const instruction = index === undefined ? undefined : body.instructions[index]
      if (instruction === undefined) continue

      if (instruction._tag === 'Phi') {
        if (seenNonPhi) {
          report('PHI nodes not grouped at top of basic block!', [
            `  ${describeInstruction(body, instruction)} in ${blockIdentifier(body, block)}`,
          ])
        }
      } else {
        seenNonPhi = true
      }

      if (!reachable) continue

      if (instruction._tag === 'Phi') {
        for (const entry of instruction.incoming) {
          const operand = resolveOperand(body, entry.value)
          if (operand._tag !== 'Local') continue
          const definition = definitionOf(operand.value)
          if (definition === 'argument') continue
          if (definition === 'missing') {
            report('Instruction referenced by a PHI has no definition!', [
              `  ${localIdentifier(body, operand.value)}`,
              `  incoming from ${blockIdentifier(body, entry.block)} into ${blockIdentifier(body, block)}`,
            ])
            continue
          }
          // An incoming value must dominate the end of the edge's source block, not the phi.
          if (immediate[entry.block] === undefined) continue
          const definingIndex = body.blocks[definition.block]?.instructions[definition.position]
          const defining =
            definingIndex === undefined ? undefined : body.instructions[definingIndex]
          const available =
            defining?._tag === 'Invoke'
              ? (definition.block === entry.block && defining.normal === block) ||
                dominates(intervals, invokeEdges.get(definingIndex ?? -1) ?? -1, entry.block)
              : dominates(intervals, definition.block, entry.block)
          if (!available) {
            report('Instruction does not dominate all uses!', [
              `  ${localIdentifier(body, operand.value)} defined in ${blockIdentifier(body, definition.block)}`,
              `  used by ${describeInstruction(body, instruction)} in ${blockIdentifier(body, block)}, incoming from ${blockIdentifier(body, entry.block)}`,
            ])
          }
        }
        continue
      }

      for (const raw of operandsOf(instruction)) {
        const operand = resolveOperand(body, raw)
        if (operand._tag !== 'Local') continue
        const definition = definitionOf(operand.value)
        if (definition === 'argument') continue
        if (definition === 'missing') {
          report('Instruction referenced by an operand has no definition!', [
            `  ${localIdentifier(body, operand.value)}`,
            `  used by ${describeInstruction(body, instruction)} in ${blockIdentifier(body, block)}`,
          ])
          continue
        }
        const definingIndex = body.blocks[definition.block]?.instructions[definition.position]
        const defining = definingIndex === undefined ? undefined : body.instructions[definingIndex]
        let dominated: boolean
        if (defining?._tag === 'Invoke')
          dominated = dominates(intervals, invokeEdges.get(definingIndex ?? -1) ?? -1, block)
        else if (definition.block === block) dominated = definition.position < position
        else dominated = dominates(intervals, definition.block, block)
        if (!dominated) {
          report('Instruction does not dominate all uses!', [
            `  ${localIdentifier(body, operand.value)} defined in ${blockIdentifier(body, definition.block)}`,
            `  used by ${describeInstruction(body, instruction)} in ${blockIdentifier(body, block)}`,
          ])
        }
      }
    }

    const terminator = instructions.at(-1)
    for (let position = 0; position < instructions.length; position += 1) {
      const index = instructions[position]
      const instruction = index === undefined ? undefined : body.instructions[index]
      if (instruction === undefined) continue
      if (!FunctionBodyDescription.isTerminator(instruction)) continue
      if (index !== terminator) {
        report('Terminator found in the middle of a basic block!', [
          `  ${describeInstruction(body, instruction)} in ${blockIdentifier(body, block)}`,
        ])
      }
      for (const successor of successorsOf(instruction)) {
        if (successor >= 0 && successor < body.blocks.length) continue
        report('Terminator branches to a block outside the function!', [
          `  ${describeInstruction(body, instruction)} in ${blockIdentifier(body, block)}`,
          `  destination ${successor}`,
        ])
      }
    }
  }

  return violations
}

/**
 * Verifies every function body in a module and returns the violations found, in module order.
 *
 * **Details**
 *
 * The check is the in-process form of `opt -passes=verify` for the invariants a builder can break
 * on its own: SSA dominance of every use by its definition, phi incoming values dominating their
 * incoming edges, phis grouped at the top of their block, and in-range branch destinations.
 *
 * Verification reads the committed bodies, so it sees the same module `Bitcode.encode` writes.
 *
 * **Gotchas**
 *
 * An empty result means the module is well-formed by those invariants, not that `opt` would have
 * nothing to say. Deliberately outside this check: operand and result type agreement, call-site
 * agreement with the callee's signature and calling convention, attribute and metadata
 * well-formedness, and intrinsic signatures. Those are covered by the cross-check against
 * `opt -passes=verify` over emitted modules, not here.
 *
 * **Example** (Failing a build on invalid IR)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Verify from '@silklang/llvm/Verify'
 *
 * const check = Effect.gen(function* () {
 *   const violations = yield* Verify.verify(builder)
 *   if (violations.length > 0) return yield* Effect.fail(Verify.format(violations))
 * })
 * ```
 *
 * @category verification
 * @since 0.0.0
 */
export const verify = Effect.fnUntraced(function* (
  self: Builder.Builder,
): Effect.fn.Return<ReadonlyArray<Violation>, LlvmError> {
  const state = yield* BuilderState.snapshot(self, 'Verify.verify')
  const violations: Array<Violation> = []
  for (const description of state.functions) {
    if (description.body === undefined) continue
    const global = state.globals[description.global]
    if (global === undefined || global.deleted) continue
    violations.push(
      ...verifyFunction(
        identifier('@', global.name),
        PackedBody.unpack(description.body),
        description.personality,
      ),
    )
  }
  return violations
})

/**
 * Renders violations the way the LLVM verifier prints them: the wording, then the values involved.
 *
 * @category verification
 * @since 0.0.0
 */
export const format = (violations: ReadonlyArray<Violation>): string =>
  violations
    .map((violation) =>
      [`${violation.message} (in ${violation.function})`, ...violation.detail].join('\n'),
    )
    .join('\n')
