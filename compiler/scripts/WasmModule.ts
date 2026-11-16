// A core WebAssembly module's binary: its functions, the instructions they contain, and a rewrite
// that makes a module count the instructions it executes. It reads what the Silk backends emit
// (the MVP with sign extension, saturating conversion, bulk memory, multiple values, reference
// types and tail calls) and rejects every other opcode instead of miscounting it.
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

export class WasmModuleError extends Data.TaggedError('WasmModuleError')<{
  readonly message: string
  readonly reason: 'Malformed' | 'Unsupported'
}> {}

/**
 * What a count covers. `instructions` is every instruction but `block`, `loop`, `else`, `end` and
 * `nop`, which an engine compiles to no code of their own; each other name is one class of
 * instruction, and an instruction is in at most one class.
 */
export const counted = [
  'instructions',
  'local.get',
  'local.set',
  'local.tee',
  'load',
  'store',
  'call',
  'call_indirect',
  'unreachable',
  'i64.extend_i32',
  'i32.wrap_i64',
  'br_table',
  'select',
  'rotate or bit count',
] as const
export type Counted = (typeof counted)[number]
export type Counts = Readonly<Record<Counted, number>>

/** One function a module defines. */
export interface WasmFunction {
  /** Its index in the module's function index space, where imported functions come first. */
  readonly index: number
  /** Its name in the module's `name` section, if the module has one that names it. */
  readonly name: string | undefined
  readonly parameters: number
  /** The byte offset of its local declarations, which is where V8 says the function is. */
  readonly offset: number
  /** The byte range of its instructions, through its final `end`. */
  readonly code: number
  readonly end: number
  /** How many instructions of each kind its body contains, executed or not. */
  readonly counts: Counts
}

interface Section {
  readonly id: number
  /** The section's first byte, its id. */
  readonly start: number
  readonly payload: number
  readonly end: number
}

export interface WasmModule {
  readonly bytes: Uint8Array
  readonly sections: ReadonlyArray<Section>
  readonly importedFunctions: number
  /** Imported and defined globals together: the index the next global would get. */
  readonly globals: number
  readonly functions: ReadonlyArray<WasmFunction>
}

const malformed = (message: string): never => {
  throw new WasmModuleError({ message: `malformed module: ${message}`, reason: 'Malformed' })
}
const unsupported = (message: string): never => {
  throw new WasmModuleError({ message: `unsupported module: ${message}`, reason: 'Unsupported' })
}
const hex = (value: number): string => `0x${value.toString(16).padStart(2, '0')}`

/** A cursor over `bytes` that refuses to read at or past `end`. */
const reader = (bytes: Uint8Array, start: number, end: number) => {
  let at = start
  const byte = (): number => {
    if (at >= end) malformed(`unexpected end at byte ${at}`)
    return bytes[at++] ?? 0
  }
  /** An unsigned LEB128 of at most 32 bits. */
  const u32 = (): number => {
    let value = 0
    for (let shift = 0; shift < 35; shift += 7) {
      const next = byte()
      value += (next & 0x7f) * 2 ** shift
      if ((next & 0x80) === 0) return value
    }
    return malformed(`an index or length longer than 32 bits before byte ${at}`)
  }
  /** Steps over one LEB128 of any width and sign. */
  const skipLeb = (): void => {
    for (let count = 0; count < 10; count++) if ((byte() & 0x80) === 0) return
    malformed(`a number longer than 64 bits before byte ${at}`)
  }
  const skip = (count: number): void => {
    if (at + count > end) malformed(`unexpected end at byte ${end}`)
    at += count
  }
  const name = (): string => {
    const length = u32()
    const from = at
    skip(length)
    return Buffer.from(bytes.subarray(from, at)).toString('utf8')
  }
  /** A value type: one byte, or a reference type's byte and its heap type. */
  const valueType = (): void => {
    const lead = byte()
    if (lead === 0x63 || lead === 0x64) skipLeb()
  }
  const limits = (): void => {
    const flags = byte()
    skipLeb()
    if ((flags & 0x01) !== 0) skipLeb()
  }
  /** A memory access's alignment, its memory index if the alignment names one, and its offset. */
  const memoryArgument = (): void => {
    if ((u32() & 0x40) !== 0) skipLeb()
    skipLeb()
  }
  return {
    get at() {
      return at
    },
    get done() {
      return at >= end
    },
    byte,
    u32,
    skipLeb,
    skip,
    name,
    valueType,
    limits,
    memoryArgument,
  }
}
type Reader = ReturnType<typeof reader>

const BLOCK = 0x02
const LOOP = 0x03
const IF = 0x04
const ELSE = 0x05
const END = 0x0b
const BR_IF = 0x0d
/** A prefixed opcode is its prefix byte times 2^16 plus the number that follows it. */
const prefixed = (prefix: number, opcode: number): number => prefix * 0x10000 + opcode
/** Instructions after which the rest of the block cannot run. */
const leaves = new Set([0x00, 0x0c, 0x0e, 0x0f, 0x12, 0x13])
/** Instructions that hand control to another function and come back. */
const calls = new Set([0x10, 0x11])

/** Reads one instruction, immediates included, and returns its opcode. */
const instruction = (read: Reader, index: number): number => {
  const opcode = read.byte()
  if (opcode >= 0x45 && opcode <= 0xc4) return opcode
  if (opcode >= 0x28 && opcode <= 0x3e) {
    read.memoryArgument()
    return opcode
  }
  switch (opcode) {
    case 0x00: // unreachable
    case 0x01: // nop
    case ELSE:
    case END:
    case 0x0f: // return
    case 0x1a: // drop
    case 0x1b: // select
    case 0xd1: // ref.is_null
      return opcode
    case BLOCK:
    case LOOP:
    case IF:
    case 0x0c: // br
    case BR_IF:
    case 0x10: // call
    case 0x12: // return_call
    case 0x20: // local.get
    case 0x21: // local.set
    case 0x22: // local.tee
    case 0x23: // global.get
    case 0x24: // global.set
    case 0x25: // table.get
    case 0x26: // table.set
    case 0x3f: // memory.size
    case 0x40: // memory.grow
    case 0x41: // i32.const
    case 0x42: // i64.const
    case 0xd0: // ref.null
    case 0xd2: // ref.func
      read.skipLeb()
      return opcode
    case 0x0e: // br_table
      for (let targets = read.u32(); targets >= 0; targets--) read.skipLeb()
      return opcode
    case 0x11: // call_indirect
    case 0x13: // return_call_indirect
      read.skipLeb()
      read.skipLeb()
      return opcode
    case 0x1c: // select with a type
      for (let types = read.u32(); types > 0; types--) read.valueType()
      return opcode
    case 0x43: // f32.const
      read.skip(4)
      return opcode
    case 0x44: // f64.const
      read.skip(8)
      return opcode
    case 0xfc: {
      const second = read.u32()
      if (second > 17) break
      // memory.init, memory.copy, table.init and table.copy name two indexes; the saturating
      // conversions name none.
      const indexes = second <= 7 ? 0 : second === 8 || second === 10 || second === 12 || second === 14 ? 2 : 1
      for (let left = indexes; left > 0; left--) read.skipLeb()
      return prefixed(opcode, second)
    }
  }
  return unsupported(`opcode ${hex(opcode)} in function ${index}`)
}

/** The class an instruction is counted in, if it is in one. */
const classOf = (opcode: number): Counted | undefined => {
  if (opcode >= 0x28 && opcode <= 0x35) return 'load'
  if (opcode >= 0x36 && opcode <= 0x3e) return 'store'
  switch (opcode) {
    case 0x00:
      return 'unreachable'
    case 0x0e:
      return 'br_table'
    case 0x10:
    case 0x12:
      return 'call'
    case 0x11:
    case 0x13:
      return 'call_indirect'
    case 0x1b:
    case 0x1c:
      return 'select'
    case 0x20:
      return 'local.get'
    case 0x21:
      return 'local.set'
    case 0x22:
      return 'local.tee'
    case 0xa7:
      return 'i32.wrap_i64'
    case 0xac: // i64.extend_i32_s
    case 0xad: // i64.extend_i32_u
      return 'i64.extend_i32'
    case 0x67: // i32.clz, i32.ctz, i32.popcnt
    case 0x68:
    case 0x69:
    case 0x77: // i32.rotl, i32.rotr
    case 0x78:
    case 0x79: // i64.clz, i64.ctz, i64.popcnt
    case 0x7a:
    case 0x7b:
    case 0x89: // i64.rotl, i64.rotr
    case 0x8a:
      return 'rotate or bit count'
  }
  return undefined
}

/** Whether an engine compiles the instruction to code of its own, so that it counts. */
const counts = (opcode: number): boolean =>
  opcode !== BLOCK && opcode !== LOOP && opcode !== ELSE && opcode !== END && opcode !== 0x01

const tally = () => {
  const totals = Object.fromEntries(counted.map((name) => [name, 0])) as Record<Counted, number>
  return {
    totals,
    add: (opcode: number): void => {
      if (!counts(opcode)) return
      totals.instructions++
      const kind = classOf(opcode)
      if (kind !== undefined) totals[kind]++
    },
  }
}

/** Adds up counts, each multiplied by its weight. */
export const sum = (terms: Iterable<readonly [Counts, number]>): Counts => {
  const totals = Object.fromEntries(counted.map((name) => [name, 0])) as Record<Counted, number>
  for (const [term, weight] of terms) for (const name of counted) totals[name] += term[name] * weight
  return totals
}

const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const NAME = 0
const TYPE = 1
const IMPORT = 2
const FUNCTION = 3
const GLOBAL = 6
const EXPORT = 7
const CODE = 10

const sectionsOf = (bytes: Uint8Array): ReadonlyArray<Section> => {
  if (bytes.length < header.length || header.some((byte, at) => bytes[at] !== byte))
    malformed('not a version 1 core module')
  const sections: Array<Section> = []
  const read = reader(bytes, header.length, bytes.length)
  while (!read.done) {
    const start = read.at
    const id = read.byte()
    const size = read.u32()
    const payload = read.at
    read.skip(size)
    sections.push({ id, start, payload, end: read.at })
  }
  return sections
}

/** The function names of a `name` section, by function index. */
const namesOf = (bytes: Uint8Array, sections: ReadonlyArray<Section>): ReadonlyMap<number, string> => {
  const names = new Map<number, string>()
  for (const section of sections) {
    if (section.id !== NAME) continue
    const read = reader(bytes, section.payload, section.end)
    if (read.name() !== 'name') continue
    while (!read.done) {
      const id = read.byte()
      const size = read.u32()
      if (id !== 1) {
        read.skip(size)
        continue
      }
      for (let left = read.u32(); left > 0; left--) {
        const index = read.u32()
        names.set(index, read.name())
      }
    }
  }
  return names
}

const decodeUnsafe = (bytes: Uint8Array): WasmModule => {
  const sections = sectionsOf(bytes)
  const section = (id: number): Reader | undefined => {
    const found = sections.find((candidate) => candidate.id === id)
    return found === undefined ? undefined : reader(bytes, found.payload, found.end)
  }
  const parameters: Array<number> = []
  const types = section(TYPE)
  for (let left = types?.u32() ?? 0; left > 0; left--) {
    const form = types?.byte() ?? 0
    if (form !== 0x60) unsupported(`type form ${hex(form)}`)
    const count = types?.u32() ?? 0
    for (let left = count; left > 0; left--) types?.valueType()
    for (let left = types?.u32() ?? 0; left > 0; left--) types?.valueType()
    parameters.push(count)
  }
  let importedFunctions = 0
  let globals = 0
  const imports = section(IMPORT)
  for (let left = imports?.u32() ?? 0; left > 0; left--) {
    imports?.name()
    imports?.name()
    const kind = imports?.byte() ?? 0
    if (kind === 0x00) {
      imports?.skipLeb()
      importedFunctions++
    } else if (kind === 0x01) {
      imports?.valueType()
      imports?.limits()
    } else if (kind === 0x02) imports?.limits()
    else if (kind === 0x03) {
      imports?.valueType()
      imports?.skip(1)
      globals++
    } else unsupported(`import kind ${hex(kind)}`)
  }
  globals += section(GLOBAL)?.u32() ?? 0
  const signatures: Array<number> = []
  const declared = section(FUNCTION)
  for (let left = declared?.u32() ?? 0; left > 0; left--) signatures.push(declared?.u32() ?? 0)
  const names = namesOf(bytes, sections)
  const functions: Array<WasmFunction> = []
  const code = sections.find((candidate) => candidate.id === CODE)
  const bodies = code === undefined ? undefined : reader(bytes, code.payload, code.end)
  const bodyCount = bodies?.u32() ?? 0
  if (bodyCount !== signatures.length)
    malformed(`${signatures.length} functions declared, ${bodyCount} bodies`)
  for (const [position, signature] of signatures.entries()) {
    const index = importedFunctions + position
    const size = bodies?.u32() ?? 0
    const offset = bodies?.at ?? 0
    bodies?.skip(size)
    const end = offset + size
    const read = reader(bytes, offset, end)
    for (let left = read.u32(); left > 0; left--) {
      read.skipLeb()
      read.valueType()
    }
    const start = read.at
    const total = tally()
    let depth = 0
    while (depth >= 0) {
      const opcode = instruction(read, index)
      if (opcode === BLOCK || opcode === LOOP || opcode === IF) depth++
      else if (opcode === END) depth--
      total.add(opcode)
    }
    if (!read.done) malformed(`function ${index} continues after its end`)
    const count = parameters[signature]
    if (count === undefined) malformed(`function ${index} has no type ${signature}`)
    functions.push({
      index,
      name: names.get(index),
      parameters: count ?? 0,
      offset,
      code: start,
      end,
      counts: total.totals,
    })
  }
  return { bytes, sections, importedFunctions, globals, functions }
}

const guarded = <A>(body: () => A): Effect.Effect<A, WasmModuleError> =>
  Effect.try({
    try: body,
    catch: (cause) =>
      cause instanceof WasmModuleError
        ? cause
        : new WasmModuleError({ message: `malformed module: ${String(cause)}`, reason: 'Malformed' }),
  })

/** Reads a module's sections and every function body; fails on a truncated or unsupported one. */
export const decode = Effect.fn('WasmModule.decode')(function* (
  bytes: Uint8Array,
): Effect.fn.Return<WasmModule, WasmModuleError> {
  return yield* guarded(() => decodeUnsafe(bytes))
})

/** How many instructions of each kind the module's function bodies contain. */
export const staticCounts = (module: WasmModule): Counts =>
  sum(module.functions.map((entry) => [entry.counts, 1] as const))

/** How a function is shown: its name, or `#` and its index when the module does not name it. */
export const label = (entry: WasmFunction): string => entry.name ?? `#${entry.index}`

/**
 * One straight-line run of instructions in a counting module: once entered, all of it executes
 * unless an instruction in it traps. `entry` marks the first run of a function's body.
 */
export interface Run {
  /** The position in `WasmModule.functions` of the function the run is in. */
  readonly function: number
  readonly entry: boolean
  readonly counts: Counts
}
/**
 * A module rewritten to count: it behaves as the original does, and also exports one mutable
 * `i64` global per run, named by `counterName`, that holds how often the run was entered.
 */
export interface Counting {
  readonly bytes: Uint8Array
  readonly runs: ReadonlyArray<Run>
}
/** The export name of the counter of the run at `position` in `Counting.runs`. */
export const counterName = (position: number): string => `silk.count.${position}`

const leb = (value: number): Array<number> => {
  const out: Array<number> = []
  let rest = value
  do {
    const low = rest % 0x80
    rest = Math.floor(rest / 0x80)
    out.push(rest === 0 ? low : low + 0x80)
  } while (rest !== 0)
  return out
}

const concat = (parts: ReadonlyArray<Uint8Array | ReadonlyArray<number>>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
const sectionOf = (id: number, payload: Uint8Array): Uint8Array => concat([[id], leb(payload.length), payload])

/** Where each kind of section goes in a module; custom sections go anywhere. */
const sectionOrder = [TYPE, IMPORT, FUNCTION, 4, 5, 13, GLOBAL, EXPORT, 8, 9, 12, CODE, 11]

const countingUnsafe = (module: WasmModule): Counting => {
  const { bytes } = module
  const runs: Array<Run> = []
  const bodies: Array<Uint8Array> = []
  for (const [position, entry] of module.functions.entries()) {
    const read = reader(bytes, entry.code, entry.end)
    const parts: Array<Uint8Array | ReadonlyArray<number>> = [bytes.subarray(entry.offset, entry.code)]
    let copied = entry.code
    let open: { readonly at: number; readonly entry: boolean; readonly total: ReturnType<typeof tally> } | undefined = {
      at: entry.code,
      entry: true,
      total: tally(),
    }
    /** Ends the open run, giving it a counter if it is a function's first or holds an instruction. */
    const close = (): void => {
      if (open !== undefined && (open.entry || open.total.totals.instructions > 0)) {
        const global = leb(module.globals + runs.length)
        // global.get, i64.const 1, i64.add, global.set
        parts.push(bytes.subarray(copied, open.at), [0x23, ...global, 0x42, 0x01, 0x7c, 0x24, ...global])
        copied = open.at
        runs.push({ function: position, entry: open.entry, counts: open.total.totals })
      }
      open = undefined
    }
    const begin = (): void => {
      open = { at: read.at, entry: false, total: tally() }
    }
    let depth = 0
    // Inside code that cannot run, how many blocks deep the cursor is.
    let dead: number | undefined
    while (depth >= 0) {
      const opcode = instruction(read, entry.index)
      if (dead !== undefined) {
        if (opcode === BLOCK || opcode === LOOP || opcode === IF) dead++
        else if (opcode === END && dead > 0) dead--
        else if (opcode === END || (opcode === ELSE && dead === 0)) {
          dead = undefined
          if (opcode === END) depth--
          if (depth >= 0) begin()
        }
        continue
      }
      open?.total.add(opcode)
      if (opcode === BLOCK) depth++
      else if (opcode === LOOP || opcode === IF) {
        depth++
        close()
        begin()
      } else if (opcode === END) {
        depth--
        close()
        if (depth >= 0) begin()
      } else if (opcode === ELSE || opcode === BR_IF || calls.has(opcode)) {
        close()
        begin()
      } else if (leaves.has(opcode)) {
        close()
        dead = 0
      }
    }
    parts.push(bytes.subarray(copied, entry.end))
    const body = concat(parts)
    bodies.push(concat([leb(body.length), body]))
  }
  const counters = runs.map(() => [0x7e, 0x01, 0x42, 0x00, 0x0b]) // (mut i64) (i64.const 0)
  const exported = runs.map((_, position) => {
    const name = Buffer.from(counterName(position), 'utf8')
    return [...leb(name.length), ...name, 0x03, ...leb(module.globals + position)]
  })
  /** A section's entries with `added` appended; a missing section starts empty. */
  const extended = (id: number, added: ReadonlyArray<ReadonlyArray<number>>): Uint8Array => {
    const found = module.sections.find((candidate) => candidate.id === id)
    const read = found === undefined ? undefined : reader(bytes, found.payload, found.end)
    const count = read?.u32() ?? 0
    const kept = found === undefined || read === undefined ? [] : [bytes.subarray(read.at, found.end)]
    return sectionOf(id, concat([leb(count + added.length), ...kept, ...added]))
  }
  const rewritten = new Map<number, Uint8Array>([
    [GLOBAL, extended(GLOBAL, counters)],
    [EXPORT, extended(EXPORT, exported)],
    [CODE, sectionOf(CODE, concat([leb(bodies.length), ...bodies]))],
  ])
  const out: Array<Uint8Array | ReadonlyArray<number>> = [header]
  const place = (id: number): void => {
    const section = rewritten.get(id)
    if (section !== undefined) out.push(section)
    rewritten.delete(id)
  }
  for (const section of module.sections) {
    // A rewritten section the module lacks goes before the first section that must follow it.
    for (const id of [...rewritten.keys()])
      if (section.id !== NAME && sectionOrder.indexOf(section.id) > sectionOrder.indexOf(id)) place(id)
    if (rewritten.has(section.id)) place(section.id)
    else out.push(bytes.subarray(section.start, section.end))
  }
  for (const id of [...rewritten.keys()]) place(id)
  return { bytes: concat(out), runs }
}

/**
 * Rewrites a module to count the instructions it executes. Each straight-line run of instructions
 * starts by adding one to its own counter, so a run that traps partway counts whole. A run ends at
 * each branch, call, `if`, `else`, `loop` and `end`.
 */
export const counting = Effect.fn('WasmModule.counting')(function* (
  module: WasmModule,
): Effect.fn.Return<Counting, WasmModuleError> {
  return yield* guarded(() => countingUnsafe(module))
})

/** What a counting module executed. */
export interface Executed {
  readonly counts: Counts
  /** For each of `WasmModule.functions`: how often it was called and what its own body executed. */
  readonly functions: ReadonlyArray<{ readonly calls: number; readonly instructions: number }>
}

/** Turns the counter of each run, in the order of `Counting.runs`, into what the module executed. */
export const executed = Effect.fn('WasmModule.executed')(function* (
  module: WasmModule,
  runs: ReadonlyArray<Run>,
  counters: ReadonlyArray<number>,
): Effect.fn.Return<Executed, WasmModuleError> {
  if (counters.length !== runs.length)
    return yield* new WasmModuleError({
      message: `malformed module: ${runs.length} counters expected, ${counters.length} read`,
      reason: 'Malformed',
    })
  const functions = module.functions.map(() => ({ calls: 0, instructions: 0 }))
  for (const [position, run] of runs.entries()) {
    const entered = counters[position] ?? 0
    const entry = functions[run.function]
    if (entry === undefined) continue
    if (run.entry) entry.calls += entered
    entry.instructions += run.counts.instructions * entered
  }
  return {
    counts: sum(runs.map((run, position) => [run.counts, counters[position] ?? 0] as const)),
    functions,
  }
})
