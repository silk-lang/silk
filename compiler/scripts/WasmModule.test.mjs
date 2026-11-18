import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import { assert, it } from './EffectTest.mjs'
import * as WasmModule from './WasmModule.ts'

// Modules are assembled by hand from the binary format; each test validates the bytes it builds
// with the host engine, so a counting claim is always about a module an engine accepts.

/** An unsigned LEB128. */
const uleb = (value) => {
  const out = []
  let rest = BigInt(value)
  do {
    const low = Number(rest & 0x7fn)
    rest >>= 7n
    out.push(rest === 0n ? low : low | 0x80)
  } while (rest !== 0n)
  return out
}
/** A signed LEB128. */
const sleb = (value) => {
  const out = []
  let rest = BigInt(value)
  for (;;) {
    const low = Number(rest & 0x7fn)
    rest >>= 7n
    const done = (rest === 0n && (low & 0x40) === 0) || (rest === -1n && (low & 0x40) !== 0)
    out.push(done ? low : low | 0x80)
    if (done) return out
  }
}
const text = (value) => [...uleb(Buffer.byteLength(value)), ...Buffer.from(value)]
const vec = (items) => [...uleb(items.length), ...items.flat()]
const section = (id, payload) => [id, ...uleb(payload.length), ...payload]
/** A function body: `locals` is a list of `[count, type]`, `code` a list of instructions. */
const body = (locals, code) => {
  const bytes = [...vec(locals.map(([count, type]) => [...uleb(count), type])), ...code.flat(), 0x0b]
  return [...uleb(bytes.length), ...bytes]
}
const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const wasm = (...sections) => Uint8Array.from([...header, ...sections.flat()])
const i32 = 0x7f
const i64 = 0x7e
const funcType = (parameters, results) => [0x60, ...vec(parameters), ...vec(results)]
const nameSection = (names) =>
  section(0, [...text('name'), ...section(1, vec(names.map(([index, name]) => [...uleb(index), ...text(name)])))])

const zero = Object.fromEntries(WasmModule.counted.map((name) => [name, 0]))
const counts = (fields) => ({ ...zero, ...fields })

const failureOf = (effect) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect)
    assert.isTrue(Result.isFailure(result))
    return Result.isFailure(result) ? result.failure : undefined
  })

it.effect('decodes imported and defined functions, their byte ranges and their names', () =>
  Effect.gen(function* () {
    const types = section(1, vec([funcType([i32], [i32]), funcType([], [])]))
    const imports = section(
      2,
      vec([
        [...text('env'), ...text('f'), 0x00, 0x01],
        [...text('env'), ...text('g'), 0x03, i32, 0x00],
      ]),
    )
    const functions = section(3, vec([[0x00], [0x01]]))
    const globals = section(6, vec([[i32, 0x01, 0x41, 0x00, 0x0b]]))
    const first = body([], [[0x20, 0x00]])
    const second = body([[1, i32]], [[0x10, 0x00]])
    const code = section(10, vec([first, second]))
    const before = header.length + types.length + imports.length + functions.length + globals.length
    const bytes = wasm(types, imports, functions, globals, code, nameSection([[0, 'imported'], [2, 'second']]))
    assert.isTrue(WebAssembly.validate(bytes))
    const module = yield* WasmModule.decode(bytes)
    assert.equal(module.importedFunctions, 1)
    assert.equal(module.globals, 2)
    assert.equal(module.functions.length, 2)
    assert.deepEqual(
      module.functions.map((entry) => entry.index),
      [1, 2],
    )
    assert.deepEqual(
      module.functions.map((entry) => entry.parameters),
      [1, 0],
    )
    assert.deepEqual(
      module.functions.map((entry) => entry.name),
      [undefined, 'second'],
    )
    assert.deepEqual(module.functions.map(WasmModule.label), ['#1', 'second'])
    // The code section's id, size and body count take three bytes; each body's size one more.
    const offset = before + 3 + 1
    assert.deepEqual(
      module.functions.map(({ offset, code, end }) => ({ offset, code, end })),
      [
        { offset, code: offset + 1, end: offset + 4 },
        { offset: offset + 5, code: offset + 8, end: offset + 11 },
      ],
    )
    assert.deepEqual([...bytes.subarray(module.functions[1].code, module.functions[1].end)], [0x10, 0x00, 0x0b])
    const empty = yield* WasmModule.decode(wasm(types))
    assert.equal(empty.functions.length, 0)
  }),
)

it.effect('does not count block, loop, else, end and nop', () =>
  Effect.gen(function* () {
    const bytes = wasm(
      section(1, vec([funcType([], [])])),
      section(3, vec([[0x00]])),
      section(
        10,
        vec([
          body(
            [],
            [
              [0x02, 0x40, 0x01, 0x03, 0x40, 0x01, 0x0b, 0x0b], // block nop loop nop end end
              [0x41, 0x01, 0x04, 0x40, 0x01, 0x05, 0x01, 0x0b], // i32.const 1 if nop else nop end
            ],
          ),
        ]),
      ),
    )
    assert.isTrue(WebAssembly.validate(bytes))
    const module = yield* WasmModule.decode(bytes)
    assert.deepEqual(WasmModule.staticCounts(module), counts({ instructions: 2 }))
  }),
)

const f32 = (value) => [...new Uint8Array(Float32Array.of(value).buffer)]
const f64 = (value) => [...new Uint8Array(Float64Array.of(value).buffer)]

// One function of every immediate form the decoder steps over, numbered by counted instruction, and
// a body long enough that its size and the code section's take two LEB128 bytes.
const mixed = wasm(
  section(
    1,
    vec([
      funcType([i32], [i32]),
      ...Array.from({ length: 63 }, () => funcType([], [])),
      funcType([], [i32, i32]), // type 64: a type index that takes two bytes as a block type
    ]),
  ),
  section(3, vec([[0x00], [0x01]])),
  section(4, vec([[0x70, 0x00, 0x01]])), // table funcref 1
  section(5, vec([[0x00, 0x01]])), // memory 1
  section(9, vec([[0x03, 0x00, ...vec([[0x00]])]])), // declare function 0 for ref.func
  section(
    10,
    vec([
      body(
        [
          [1, i64],
          [1, i32],
        ],
        [
          [0x02, 0xc0, 0x00], // block (type 64)
          [0x41, ...sleb(-1000000)], // 1 i32.const
          [0x41, 0x07], // 2 i32.const
          [0x0b], // end
          [0x6a], // 3 i32.add
          [0x21, 0x02], // 4 local.set
          [0x42, ...sleb(-(2n ** 63n))], // 5 i64.const, ten bytes
          [0x21, 0x01], // 6 local.set
          [0x20, 0x01], // 7 local.get
          [0xa7], // 8 i32.wrap_i64
          [0xad], // 9 i64.extend_i32_u
          [0x21, 0x01], // 10 local.set
          [0x20, 0x00], // 11 local.get
          [0x69], // 12 i32.popcnt
          [0x22, 0x02], // 13 local.tee
          [0x28, 0x02, ...uleb(300)], // 14 i32.load offset=300
          [0x1a], // 15 drop
          [0x41, 0x00], // 16 i32.const
          [0x20, 0x02], // 17 local.get
          [0x36, 0x02, 0x00], // 18 i32.store
          [0x41, 0x00, 0x41, 0x00, 0x41, 0x04], // 19-21 i32.const
          [0xfc, 0x0a, 0x00, 0x00], // 22 memory.copy
          [0x41, 0x00, 0x41, 0x00, 0x41, 0x04], // 23-25 i32.const
          [0xfc, 0x0b, 0x00], // 26 memory.fill
          [0x43, ...f32(1.5)], // 27 f32.const
          [0xfc, 0x00], // 28 i32.trunc_sat_f32_s
          [0x1a], // 29 drop
          [0x44, ...f64(2)], // 30 f64.const
          [0x1a], // 31 drop
          [0xd0, 0x70], // 32 ref.null func
          [0xd1], // 33 ref.is_null
          [0x1a], // 34 drop
          [0xd2, 0x00], // 35 ref.func
          [0x1a], // 36 drop
          [0x41, 0x00], // 37 i32.const
          [0x25, 0x00], // 38 table.get
          [0x1a], // 39 drop
          [0x41, 0x01, 0x41, 0x02], // 40-41 i32.const
          [0x20, 0x00], // 42 local.get
          [0x1b], // 43 select
          [0x1a], // 44 drop
          [0x41, 0x01, 0x41, 0x02], // 45-46 i32.const
          [0x20, 0x00], // 47 local.get
          [0x1c, 0x01, i32], // 48 select (result i32)
          [0x1a], // 49 drop
          [0x03, 0x40, 0x01], // loop nop
          [0x20, 0x00], // 50 local.get
          [0x0d, 0x00], // 51 br_if
          [0x0b], // end
          [0x02, 0x40], // block
          [0x20, 0x00], // 52 local.get
          [0x0e, 0x02, 0x00, 0x00, 0x00], // 53 br_table
          [0x0b], // end
          [0x20, 0x00], // 54 local.get
          [0x04, i32], // 55 if (result i32)
          [0x20, 0x00], // 56 local.get
          [0x10, 0x00], // 57 call
          [0x05], // else
          [0x41, 0x00], // 58 i32.const
          [0x20, 0x00], // 59 local.get
          [0x11, 0x00, 0x00], // 60 call_indirect
          [0x0b], // end
          [0x20, 0x00], // 61 local.get
          [0x04, 0x40], // 62 if
          [0x00], // 63 unreachable
          [0x0b], // end
          Array(130).fill(0x01), // nop
        ],
      ),
      body([], [[0x41, 0x03, 0x10, 0x00, 0x1a]]), // i32.const 3 call drop
    ]),
  ),
)

it.effect('counts each instruction class across every immediate form', () =>
  Effect.gen(function* () {
    assert.isTrue(WebAssembly.validate(mixed))
    const module = yield* WasmModule.decode(mixed)
    const first = counts({
      instructions: 63,
      'local.get': 11,
      'local.set': 3,
      'local.tee': 1,
      load: 1,
      store: 1,
      call: 1,
      call_indirect: 1,
      unreachable: 1,
      'i64.extend_i32': 1,
      'i32.wrap_i64': 1,
      br_table: 1,
      select: 2,
      'rotate or bit count': 1,
    })
    assert.deepEqual(module.functions[0].counts, first)
    assert.deepEqual(module.functions[1].counts, counts({ instructions: 3, call: 1 }))
    assert.deepEqual(WasmModule.staticCounts(module), { ...first, instructions: 66, call: 2 })
  }),
)

it.effect('reads a reference type with its heap type as a block type', () =>
  Effect.gen(function* () {
    const bytes = wasm(
      section(1, vec([funcType([], [])])),
      section(3, vec([[0x00]])),
      // block (result (ref null func)) ref.null func end drop
      section(10, vec([body([], [[0x02, 0x63, 0x70, 0xd0, 0x70, 0x0b, 0x1a]])])),
    )
    assert.isTrue(WebAssembly.validate(bytes))
    const module = yield* WasmModule.decode(bytes)
    assert.deepEqual(WasmModule.staticCounts(module), counts({ instructions: 2 }))
  }),
)

it.effect('rejects a truncated module as malformed', () =>
  Effect.gen(function* () {
    const types = section(1, vec([funcType([], [])]))
    const functions = section(3, vec([[0x00]]))
    const whole = wasm(types, functions, section(10, vec([body([], [[0x20, 0x00]])])))
    const cut = yield* failureOf(WasmModule.decode(whole.subarray(0, whole.length - 2)))
    assert.deepEqual([cut?._tag, cut?.reason], ['WasmModuleError', 'Malformed'])
    // A body whose size ends inside an instruction's immediate: local.get without its index.
    const short = yield* failureOf(WasmModule.decode(wasm(types, functions, section(10, vec([[0x02, 0x00, 0x20]])))))
    assert.deepEqual([short?._tag, short?.reason], ['WasmModuleError', 'Malformed'])
  }),
)

it.effect('rejects an opcode outside the supported proposals as unsupported', () =>
  Effect.gen(function* () {
    const module = (code) =>
      wasm(section(1, vec([funcType([], [])])), section(3, vec([[0x00]])), section(10, vec([body([], [code])])))
    for (const code of [
      [0xfd, 0x0c, ...Array(16).fill(0), 0x1a], // v128.const drop
      [0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a], // i32.const 0 i32.atomic.load drop
      [0x06, 0x40, 0x0b], // try end
    ]) {
      const failure = yield* failureOf(WasmModule.decode(module(code)))
      assert.deepEqual([failure?._tag, failure?.reason], ['WasmModuleError', 'Unsupported'])
    }
  }),
)

// A program whose functions follow an imported function and an imported global, with a global and
// exports of its own. Function positions in `WasmModule.functions`: loop 0, branch 1, brif 2,
// caller 3, dead 4, bump 5.
const program = wasm(
  section(1, vec([funcType([i32], [i32]), funcType([], [])])),
  section(
    2,
    vec([
      [...text('env'), ...text('ext'), 0x00, 0x00],
      [...text('env'), ...text('base'), 0x03, i32, 0x00],
    ]),
  ),
  section(3, vec([[0x00], [0x00], [0x00], [0x00], [0x00], [0x01]])),
  section(6, vec([[i32, 0x01, 0x41, 0x00, 0x0b]])),
  section(
    7,
    vec([
      ...['loop', 'branch', 'brif', 'caller', 'dead', 'bump'].map((name, position) => [
        ...text(name),
        0x00,
        ...uleb(position + 1),
      ]),
      [...text('g'), 0x03, 0x01],
    ]),
  ),
  section(
    10,
    vec([
      // loop(n): the sum of 1 to n.
      body(
        [[1, i32]],
        [
          [0x02, 0x40, 0x03, 0x40], // block loop
          [0x20, 0x00, 0x45, 0x0d, 0x01], // local.get 0 i32.eqz br_if 1
          [0x20, 0x01, 0x20, 0x00, 0x6a, 0x21, 0x01], // local.get 1 local.get 0 i32.add local.set 1
          [0x20, 0x00, 0x41, 0x01, 0x6b, 0x21, 0x00], // local.get 0 i32.const 1 i32.sub local.set 0
          [0x0c, 0x00, 0x0b, 0x0b], // br 0 end end
          [0x20, 0x01], // local.get 1
        ],
      ),
      // branch(x): x ? 10 + 1 : 20
      body([], [[0x20, 0x00, 0x04, i32, 0x41, 0x0a, 0x41, 0x01, 0x6a, 0x05, 0x41, 0x14, 0x0b]]),
      // brif(x): x ? 7 : 8, through br_if
      body([], [[0x02, i32, 0x41, 0x07, 0x20, 0x00, 0x0d, 0x00, 0x1a, 0x41, 0x08, 0x0b]]),
      // caller(x): branch(x) + ext(x)
      body([], [[0x20, 0x00, 0x10, 0x02, 0x20, 0x00, 0x10, 0x00, 0x6a]]),
      // dead(x): x, with code after an unconditional br that never runs
      body(
        [],
        [
          [0x02, 0x40, 0x0c, 0x00], // block br 0
          [0x41, 0x63, 0x1a], // i32.const 99 drop
          [0x02, 0x40, 0x01, 0x20, 0x00, 0x1a, 0x0b], // block nop local.get 0 drop end
          [0x20, 0x00, 0x1a, 0x0b], // local.get 0 drop end
          [0x20, 0x00], // local.get 0
        ],
      ),
      // bump(): g += base
      body([], [[0x23, 0x01, 0x23, 0x00, 0x6a, 0x24, 0x01]]),
    ]),
  ),
)
const imports = { env: { ext: (x) => x * 2, base: 5 } }
const instantiate = (bytes) => new WebAssembly.Instance(new WebAssembly.Module(bytes), imports).exports

/** Runs `calls` on a counting copy of `program` and returns their results and what executed. */
const counted = (calls) =>
  Effect.gen(function* () {
    const module = yield* WasmModule.decode(program)
    const { bytes, runs } = yield* WasmModule.counting(module)
    assert.isTrue(WebAssembly.validate(bytes))
    const exports = instantiate(bytes)
    const results = calls.map(([name, ...args]) => exports[name](...args))
    const counters = runs.map((_, position) => Number(exports[WasmModule.counterName(position)].value))
    return { results, executed: yield* WasmModule.executed(module, runs, counters) }
  })

it.effect('a counting module computes what the original does and keeps its globals and exports', () =>
  Effect.gen(function* () {
    assert.isTrue(WebAssembly.validate(program))
    const calls = [['loop', 5], ['branch', 1], ['branch', 0], ['brif', 1], ['brif', 0], ['caller', 3], ['dead', 4]]
    const original = instantiate(program)
    const expected = calls.map(([name, ...args]) => original[name](...args))
    assert.deepEqual(expected, [15, 11, 20, 7, 8, 17, 4])
    const { results } = yield* counted(calls)
    assert.deepEqual(results, expected)
    const { bytes } = yield* WasmModule.counting(yield* WasmModule.decode(program))
    const exports = instantiate(bytes)
    exports.bump()
    exports.bump()
    assert.equal(exports.g.value, 10)
  }),
)

it.effect('counts every iteration of a loop', () =>
  Effect.gen(function* () {
    const { results, executed } = yield* counted([['loop', 5]])
    assert.deepEqual(results, [15])
    // Per call: the loop's test runs n + 1 times (3 instructions), its body n times (9), the
    // result once (1).
    assert.deepEqual(executed.functions[0], { calls: 1, instructions: 3 * 6 + 9 * 5 + 1 })
    assert.equal(executed.counts.instructions, 64)
    assert.equal(executed.counts['local.get'], 6 + 3 * 5 + 1)
    assert.equal(executed.counts['local.set'], 2 * 5)
  }),
)

it.effect('counts the arm of an if that runs', () =>
  Effect.gen(function* () {
    const { results, executed } = yield* counted([
      ['branch', 1],
      ['branch', 0],
      ['branch', 0],
    ])
    assert.deepEqual(results, [11, 20, 20])
    // local.get and if on every call, three instructions in the then arm once, one in the else arm twice.
    assert.deepEqual(executed.functions[1], { calls: 3, instructions: 2 * 3 + 3 + 1 * 2 })
  }),
)

it.effect('counts what follows a br_if only when it falls through', () =>
  Effect.gen(function* () {
    const { results, executed } = yield* counted([
      ['brif', 1],
      ['brif', 1],
      ['brif', 0],
    ])
    assert.deepEqual(results, [7, 7, 8])
    // i32.const, local.get and br_if on every call; drop and i32.const only when not taken.
    assert.deepEqual(executed.functions[2], { calls: 3, instructions: 3 * 3 + 2 })
  }),
)

it.effect('counts calls per function and charges a callee its own instructions', () =>
  Effect.gen(function* () {
    const { results, executed } = yield* counted([['caller', 3]])
    assert.deepEqual(results, [17])
    assert.deepEqual(executed.functions, [
      { calls: 0, instructions: 0 },
      { calls: 1, instructions: 5 },
      { calls: 0, instructions: 0 },
      { calls: 1, instructions: 5 },
      { calls: 0, instructions: 0 },
      { calls: 0, instructions: 0 },
    ])
    // The imported function is called too, but has no body to count.
    assert.equal(executed.counts.call, 2)
  }),
)

it.effect('counts no code after an unconditional br', () =>
  Effect.gen(function* () {
    const module = yield* WasmModule.decode(program)
    assert.equal(module.functions[4].counts.instructions, 8)
    const { results, executed } = yield* counted([['dead', 4]])
    assert.deepEqual(results, [4])
    assert.deepEqual(executed.functions[4], { calls: 1, instructions: 2 })
    assert.equal(executed.counts['local.get'], 1)
  }),
)

it.effect('adds the global and export sections a module lacks in their place', () =>
  Effect.gen(function* () {
    // A start function and a name section, but no global or export section.
    const bytes = wasm(
      section(1, vec([funcType([], [])])),
      section(3, vec([[0x00]])),
      section(8, [0x00]),
      section(10, vec([body([], [[0x01]])])),
      nameSection([[0, 'start']]),
    )
    const module = yield* WasmModule.decode(bytes)
    const rewritten = yield* WasmModule.counting(module)
    assert.isTrue(WebAssembly.validate(rewritten.bytes))
    const exports = instantiate(rewritten.bytes)
    assert.deepEqual(Object.keys(exports), [WasmModule.counterName(0)])
    // The start function ran once when the module was instantiated.
    assert.equal(exports[WasmModule.counterName(0)].value, 1n)
    const again = yield* WasmModule.decode(rewritten.bytes)
    assert.deepEqual(again.functions.map(WasmModule.label), ['start'])
  }),
)

it.effect('re-encodes function and section sizes that grow past one byte', () =>
  Effect.gen(function* () {
    const module = yield* WasmModule.decode(mixed)
    const { bytes, runs } = yield* WasmModule.counting(module)
    assert.isTrue(WebAssembly.validate(bytes))
    // Each run adds global.get, i64.const, i64.add and global.set.
    const again = yield* WasmModule.decode(bytes)
    assert.equal(
      WasmModule.staticCounts(again).instructions,
      WasmModule.staticCounts(module).instructions + 4 * runs.length,
    )
  }),
)

it.effect('refuses counters that do not match the runs', () =>
  Effect.gen(function* () {
    const module = yield* WasmModule.decode(program)
    const { runs } = yield* WasmModule.counting(module)
    const failure = yield* failureOf(WasmModule.executed(module, runs, []))
    assert.deepEqual([failure?._tag, failure?.reason], ['WasmModuleError', 'Malformed'])
  }),
)

it('adds up counts by weight', () => {
  assert.deepEqual(
    WasmModule.sum([
      [counts({ instructions: 2, call: 1 }), 3],
      [counts({ instructions: 1, load: 1 }), 2],
    ]),
    counts({ instructions: 8, call: 3, load: 2 }),
  )
  assert.deepEqual(WasmModule.sum([]), zero)
})
