import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { assert, it } from './EffectTest.mjs'
import * as WasmEngine from './WasmEngine.ts'

const require = createRequire(new URL('../../package.json', import.meta.url))
/** @type {typeof import('@effect/platform-node')} */
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)

// A minimal assembler for one-function WASI commands, enough for the modules below.
/** @param {number} value */
const sleb = (value) => {
  const bytes = []
  let rest = value
  for (;;) {
    const byte = rest & 0x7f
    rest >>= 7
    const done = (rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0)
    bytes.push(done ? byte : byte | 0x80)
    if (done) return bytes
  }
}
/** @param {number} value */
const uleb = (value) => {
  const bytes = []
  let rest = value
  do {
    const byte = rest & 0x7f
    rest >>>= 7
    bytes.push(rest === 0 ? byte : byte | 0x80)
  } while (rest !== 0)
  return bytes
}
/** @param {string} text */
const name = (text) => [...uleb(text.length), ...Buffer.from(text)]
/** @param {ReadonlyArray<ReadonlyArray<number>>} items */
const vector = (items) => [...uleb(items.length), ...items.flat()]
/** @param {number} id @param {ReadonlyArray<ReadonlyArray<number>>} items */
const section = (id, items) => {
  const body = vector(items)
  return [id, ...uleb(body.length), ...body]
}
const i32 = 0x7f
/** @type {Readonly<Record<string, readonly [ReadonlyArray<number>, ReadonlyArray<number>]>>} */
const wasi = {
  fd_write: [[i32, i32, i32, i32], [i32]],
  proc_exit: [[i32], []],
  random_get: [[i32, i32], [i32]],
}
/** @param {number} value */
const constant = (value) => [0x41, ...sleb(value)]
/**
 * A module whose only function is `_start`, after the imported WASI functions. `code` gets each
 * import's function index by name. `body` is the offset of `_start`'s body after its size, which is
 * how V8's profiler names the function.
 * @param {{ imports?: ReadonlyArray<string>, memory?: boolean, locals?: ReadonlyArray<number>,
 *   code: (call: Readonly<Record<string, number>>) => ReadonlyArray<number>,
 *   data?: ReadonlyArray<readonly [number, ArrayLike<number>]> }} shape
 */
const command = ({ imports = [], memory = true, locals = [], code, data = [] }) => {
  const types = [[[], []], ...imports.map((imported) => wasi[imported] ?? [[], []])]
  const call = Object.fromEntries(imports.map((imported, index) => [imported, index]))
  const body = [...vector(locals.map((type) => [1, type])), ...code(call), 0x0b]
  const head = [
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, types.map(([parameters, results]) => [0x60, ...vector(parameters.map((type) => [type])), ...vector(results.map((type) => [type]))])),
    ...section(2, imports.map((imported, index) => [...name('wasi_snapshot_preview1'), ...name(imported), 0x00, ...uleb(index + 1)])),
    ...section(3, [[0]]),
    ...(memory ? section(5, [[0x00, 0x01]]) : []),
    ...section(7, [...(memory ? [[...name('memory'), 0x02, 0x00]] : []), [...name('_start'), 0x00, ...uleb(imports.length)]]),
  ]
  const codeSection = section(10, [[...uleb(body.length), ...body]])
  const bytes = Uint8Array.from([
    ...head,
    ...codeSection,
    ...(data.length === 0 ? [] : section(11, data.map(([offset, contents]) => [0x00, ...constant(offset), 0x0b, ...vector([...contents].map((byte) => [byte]))]))),
  ])
  return { bytes, body: head.length + codeSection.length - body.length }
}

// fd_write(fd, iovec at 0, one iovec, count written at 8) of `text`, which sits at 16.
const text = Buffer.from('hello\n')
const message = [[0, [16, 0, 0, 0, text.length, 0, 0, 0]], [16, text]]
/** @param {number} fd @param {Readonly<Record<string, number>>} call */
const write = (fd, call) => [...constant(fd), ...constant(0), ...constant(1), ...constant(8), 0x10, call.fd_write ?? 0, 0x1a]
/** Writes `hello` to stdout and exits 7. */
const hello = command({
  imports: ['fd_write', 'proc_exit'],
  data: message,
  code: (call) => [...write(1, call), ...constant(7), 0x10, call.proc_exit ?? 0],
})
/** Writes `hello` to stderr and executes `unreachable`. */
const trap = command({ imports: ['fd_write'], data: message, code: (call) => [...write(2, call), 0x00] })
/** Writes eight random letters to stdout, so that no two runs agree. */
const random = command({
  imports: ['random_get', 'fd_write'],
  data: [[0, [32, 0, 0, 0, 8, 0, 0, 0]]],
  code: (call) => [
    ...[...constant(32), ...constant(8), 0x10, call.random_get ?? 0, 0x1a],
    // Two i32 halves at 32 and 36, each made letters from 0x40 to 0x7f.
    ...[36, 32].flatMap((at) => [...constant(at), ...constant(at), 0x28, 2, 0, ...constant(0x3f3f3f3f), 0x71, ...constant(0x40404040), 0x72, 0x36, 2, 0]),
    ...write(1, call),
  ],
})
/** Counts to five million. */
const busy = command({
  locals: [i32],
  code: () => [0x03, 0x40, 0x20, 0, ...constant(1), 0x6a, 0x22, 0, ...constant(5_000_000), 0x49, 0x0d, 0, 0x0b],
})
/** Has `_start` but no `memory`, so it is not a WASI command. */
const memoryless = command({ memory: false, code: () => [] })

const threeRuns = { steadyRuns: 2, steadyMs: 0 }

/** Writes `bytes` to a module in a scoped temporary directory and gives its path. */
const moduleFile = Effect.fnUntraced(
  /** @param {Uint8Array} bytes */
  function* (bytes) {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-wasm-engine-test-' })
    const path = join(directory, 'module.wasm')
    yield* fs.writeFile(path, bytes)
    return path
  },
)

/** @param {ReadonlyArray<number>} ms */
const assertTimes = (ms) => {
  for (const value of ms) assert.isTrue(Number.isFinite(value) && value >= 0, `run time ${value}`)
}

it('median of nothing is undefined', () => {
  assert.strictEqual(WasmEngine.median([]), undefined)
})

it('median of an odd count of unsorted values is the middle one', () => {
  assert.strictEqual(WasmEngine.median([9, 1, 5, 3, 7]), 5)
})

it('median of an even count of unsorted values is the mean of the middle two', () => {
  assert.strictEqual(WasmEngine.median([10, 1, 4, 2]), 3)
})

it('median does not reorder its input', () => {
  const values = [3, 1, 2]
  WasmEngine.median(values)
  assert.deepEqual(values, [3, 1, 2])
})

it('timing reports the first run apart from the median of the later runs', () => {
  assert.deepEqual(WasmEngine.timing([50, 4, 2, 9]), { firstMs: 50, steadyMs: 4 })
})

it('timing of a single run takes the first run as the steady state', () => {
  assert.deepEqual(WasmEngine.timing([12]), { firstMs: 12, steadyMs: 12 })
})

it('wasmtimeOutcome keeps a normal exit and both streams', () => {
  assert.deepEqual(WasmEngine.wasmtimeOutcome(0, null, 'out\n', 'err\n'), { exit: 0, trap: null, stdout: 'out\n', stderr: 'err\n' })
})

it('wasmtimeOutcome keeps the status of proc_exit, even 134 when Wasmtime reports nothing', () => {
  assert.deepEqual(WasmEngine.wasmtimeOutcome(134, null, '', 'mine\n'), { exit: 134, trap: null, stdout: '', stderr: 'mine\n' })
})

// What Wasmtime 50.0.0 writes for the `trap` module above, after the program's own `hello`.
const trapReport = [
  'Error: failed to run main module `module.cwasm`',
  '',
  'Caused by:',
  '    0: failed to invoke command default',
  '    1: error while executing at wasm backtrace:',
  '    0:     0x69 - <unknown>!<wasm function 1>',
  '    2: wasm trap: wasm `unreachable` instruction executed',
  '',
].join('\n')
const trapLine = '2: wasm trap: wasm `unreachable` instruction executed'

it('wasmtimeOutcome splits a trap report from the program stderr before it', () => {
  assert.deepEqual(WasmEngine.wasmtimeOutcome(134, null, 'out', `hello\n${trapReport}`), {
    exit: null,
    trap: trapLine,
    stdout: 'out',
    stderr: 'hello\n',
  })
})

it('wasmtimeOutcome takes the trap, not the backtrace, when RUST_BACKTRACE is set', () => {
  const backtrace = 'Stack backtrace:\n   0: wasmtime_internal_core::error::backtrace::capture\n  22: main\n'
  assert.strictEqual(WasmEngine.wasmtimeOutcome(134, null, '', `${trapReport}\n${backtrace}`).trap, trapLine)
})

it('wasmtimeOutcome reports a Wasmtime killed by a signal as a trap', () => {
  const outcome = WasmEngine.wasmtimeOutcome(null, 'SIGKILL', 'partial', '')
  assert.strictEqual(outcome.exit, null)
  assert.include(outcome.trap ?? '', 'SIGKILL')
  assert.strictEqual(outcome.stdout, 'partial')
})

it.layer(NodeServices.layer)((it) => {
  for (const engine of WasmEngine.v8Engines)
    it.effect(`${engine} runs a module as often as asked and reports its output and exit`, () =>
      Effect.gen(function* () {
        const module = yield* moduleFile(hello.bytes)
        const execution = yield* WasmEngine.run(engine, { module, arguments: [], repeat: threeRuns })
        assert.deepEqual(
          { exit: execution.exit, trap: execution.trap, stdout: execution.stdout, stderr: execution.stderr },
          { exit: 7, trap: null, stdout: 'hello\n', stderr: '' },
        )
        assert.strictEqual(execution.ms.length, 3)
        assertTimes(execution.ms)
        assert.deepEqual(execution.counters, [])
        assert.strictEqual(execution.samples, undefined)
      }),
    )

  it.effect('a V8 run reports a trap and the stderr before it', () =>
    Effect.gen(function* () {
      const module = yield* moduleFile(trap.bytes)
      const execution = yield* WasmEngine.run('v8-baseline', { module, arguments: [], repeat: WasmEngine.once })
      assert.deepEqual(
        { exit: execution.exit, trap: execution.trap, stdout: execution.stdout, stderr: execution.stderr },
        { exit: null, trap: 'unreachable', stdout: '', stderr: 'hello\n' },
      )
      assert.strictEqual(execution.ms.length, 1)
    }),
  )

  it.effect('a V8 run fails, rather than reporting a trap, for a module that is not a WASI command', () =>
    Effect.gen(function* () {
      const module = yield* moduleFile(memoryless.bytes)
      const error = yield* Effect.flip(WasmEngine.run('v8-baseline', { module, arguments: [], repeat: WasmEngine.once }))
      assert.strictEqual(error._tag, 'WasmEngineError')
      assert.include(error.message, 'memory')
    }),
  )

  it.effect('a V8 run fails when a later run writes other output than the first', () =>
    Effect.gen(function* () {
      const module = yield* moduleFile(random.bytes)
      const error = yield* Effect.flip(WasmEngine.run('v8-baseline', { module, arguments: [], repeat: { steadyRuns: 1, steadyMs: 0 } }))
      assert.deepEqual({ tag: error._tag, reason: error.reason, message: error.message }, {
        tag: 'WasmEngineError',
        reason: 'RejectedInput',
        message: 'run 2 differs in outcome from the first',
      })
    }),
  )

  it.effect('a V8 run takes a module path relative to the working directory', () =>
    Effect.gen(function* () {
      const module = yield* moduleFile(hello.bytes)
      // The working directory is two levels above the module, so that the relative path cannot
      // resolve by accident from the module's own directory.
      const above = dirname(dirname(module))
      const before = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const current = process.cwd()
          process.chdir(above)
          return current
        }),
        (current) => Effect.sync(() => process.chdir(current)),
      )
      assert.notStrictEqual(before, above)
      const execution = yield* WasmEngine.run('v8-baseline', { module: relative(above, module), arguments: [], repeat: WasmEngine.once })
      assert.strictEqual(execution.stdout, 'hello\n')
    }),
  )

  it.effect('a sampled V8 run charges self time to the function by its body offset', () =>
    Effect.gen(function* () {
      const module = yield* moduleFile(busy.bytes)
      const execution = yield* WasmEngine.run('v8-baseline', { module, arguments: [], repeat: WasmEngine.once, sample: true })
      assert.strictEqual(execution.exit, 0)
      const functions = execution.samples?.functions ?? []
      assert.isTrue(functions.length > 0, 'no samples in the busy loop')
      for (const [offset, microseconds] of functions) {
        assert.strictEqual(offset, busy.body)
        assert.isTrue(Number.isFinite(microseconds) && microseconds >= 0, `self time ${microseconds}`)
      }
    }),
  )
})
