// Runs a Silk wasm32 or wasm64 module: `node wasm-runner.mjs program.wasm` exits with the status `main`
// returns. A module built with `threading = "multi"` imports one shared memory and the
// wasi-threads `thread-spawn`; this runner creates that memory, runs `main` in a Worker, and
// starts every thread as another Worker that instantiates the same module on the same memory.
// A module without threads runs the same way. Browsers use `runWasm` from a module script.
//
// A module reports an unhandled error or a trap into a buffer of its own memory, which it exports
// as `silk_report` (the address) and `silk_report_length`. `runWasm` passes the report of a `main`
// that fails to `options.onReport` (by default `console.error`), and rejects a trap with a
// `SilkError` that carries the report, and whose stack is the report followed by the engine's.
//
// A module that logs through `silk.io.logger_console` imports `silk.console`. The runner passes
// each message to `options.onLog(level, text)`, where `level` is one of `LOG_LEVELS`, and by
// default to the console method of the level.
//
// Every Worker is created by the top-level thread, never by another Worker, so a thread that
// returns cannot take the threads it started with it. `main` never runs on the top-level thread,
// because a browser's main thread may not block in `memory.atomic.wait32`.
//
// A thread's instance starts with the `__stack_pointer` of the main thread, whose frames are live
// on the shared memory, so it calls no export before `wasi_thread_start` moves it to the thread's
// own stack. The report length a thread reads from is taken on the spawning thread instead.

const isNode = typeof process === 'object' && process.versions?.node !== undefined

// Wasm's own encoding: LEB128 unsigned integers, then the import section's memory limits.
const readUnsigned = (bytes, cursor) => {
  let value = 0
  let shift = 0
  for (;;) {
    const byte = bytes[cursor.at++]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return value
    shift += 7
  }
}

// The imported memory's page limits, or undefined when the module defines its own memory.
const importedMemory = (bytes) => {
  const cursor = { at: 8 }
  while (cursor.at < bytes.length) {
    const id = bytes[cursor.at++]
    const size = readUnsigned(bytes, cursor)
    const end = cursor.at + size
    if (id === 2) {
      const count = readUnsigned(bytes, cursor)
      for (let index = 0; index < count; index += 1) {
        for (let name = 0; name < 2; name += 1) {
          const length = readUnsigned(bytes, cursor)
          cursor.at += length
        }
        const kind = bytes[cursor.at++]
        if (kind === 2) {
          const flags = bytes[cursor.at++]
          const initial = readUnsigned(bytes, cursor)
          const maximum = flags & 1 ? readUnsigned(bytes, cursor) : undefined
          return { initial, maximum, shared: (flags & 2) !== 0, wide: (flags & 4) !== 0 }
        }
        if (kind === 0) readUnsigned(bytes, cursor)
        else if (kind === 1) {
          cursor.at += 1
          const flags = bytes[cursor.at++]
          readUnsigned(bytes, cursor)
          if (flags & 1) readUnsigned(bytes, cursor)
        } else if (kind === 3) cursor.at += 2
        else throw new Error(`unsupported import kind ${kind}`)
      }
      return undefined
    }
    cursor.at = end
  }
  return undefined
}

// Whether the module's memory is a 64-bit one (`memory64`), imported or its own.
const wideMemory = (bytes) => {
  const imported = importedMemory(bytes)
  if (imported !== undefined) return imported.wide
  const cursor = { at: 8 }
  while (cursor.at < bytes.length) {
    const id = bytes[cursor.at++]
    const size = readUnsigned(bytes, cursor)
    if (id === 5) {
      readUnsigned(bytes, cursor)
      return (bytes[cursor.at] & 4) !== 0
    }
    cursor.at += size
  }
  return false
}

/** A Silk program stopped by a trap, with the report the program wrote. */
export class SilkError extends Error {
  constructor(report, cause) {
    super(report.split('\n', 1)[0] || String(cause?.message ?? cause), { cause: engineError(cause) })
    this.name = 'SilkError'
    /** The whole report, such as `fatal trap: ...` and its `at` lines. */
    this.report = report
    this.stack = `${report}${cause?.stack ?? String(cause)}`
  }
}

// A `usize` the module passes: a number from a wasm32 module, a BigInt from a wasm64 one.
const word = (value) => (typeof value === 'bigint' ? Number(value) : value >>> 0)

const reportLength = (instance) => {
  const length = instance.exports.silk_report_length
  return typeof length === 'function' ? word(length()) : 0
}

// The report text `instance` wrote after its first `from` bytes.
const readReport = (instance, from) => {
  const address = instance.exports.silk_report
  const memory = instance.exports.memory
  const end = reportLength(instance)
  if (typeof address !== 'function' || !(memory instanceof WebAssembly.Memory) || end <= from) return ''
  // A shared memory's view must be copied before it is decoded.
  const view = new Uint8Array(memory.buffer, word(address()) + from, end - from).slice()
  return new TextDecoder().decode(view)
}

// The engine's error from a trap's parts, as a `WebAssembly.RuntimeError` again.
const engineError = (parts) => {
  if (parts instanceof Error || typeof parts !== 'object' || parts === null) return parts
  const error = new WebAssembly.RuntimeError(parts.message)
  if (parts.stack !== undefined) error.stack = parts.stack
  return error
}

// The level names of `silk.console`, by the level number it passes.
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warning', 'error']

const consoleMethods = { trace: 'debug', debug: 'debug', info: 'info', warning: 'warn', error: 'error' }

const decoder = new TextDecoder()

// The imports one instance needs. `spawn` starts a thread from a start argument and answers its
// positive id, or a negative error; `log` takes the parts of one console message.
const importsFor = (memory, spawn, parallelism, log) => ({
  env: memory === undefined ? {} : { memory },
  wasi: { 'thread-spawn': spawn },
  silk: { 'thread-parallelism': () => parallelism, console: log },
})

// One Worker's work: `main`, whose status it reports, or one thread.
const runRole = (data, post) => {
  const spawn = (argument) => {
    const thread = Atomics.add(data.threads, 0, 1) + 1
    post({ kind: 'spawn', thread, argument, before: reportLength(reading) })
    return thread
  }
  const reading = { exports: undefined }
  // A message's parts, copied out of memory, until the part that ends it.
  let parts = []
  const log = (level, address, length, more) => {
    parts.push(new Uint8Array(reading.exports.memory.buffer, word(address), word(length)).slice())
    if (more) return
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let at = 0
    for (const part of parts) {
      joined.set(part, at)
      at += part.length
    }
    parts = []
    post({ kind: 'log', level: LOG_LEVELS[level] ?? 'info', text: decoder.decode(joined) })
  }
  const instance = new WebAssembly.Instance(
    data.module,
    importsFor(data.memory, spawn, data.parallelism, log),
  )
  reading.exports = data.memory === undefined ? instance.exports : { ...instance.exports, memory: data.memory }
  const before = data.role === 'main' ? reportLength(reading) : data.before
  try {
    if (data.role === 'main') {
      // LLVM gives a `main` without parameters the C parameters `argc` and `argv`, which a
      // wasm64 module's engine converts from a BigInt.
      const main = instance.exports.main
      const status = main.length === 2 ? main(0, data.wide ? 0n : 0) : main()
      post({ kind: 'exit', status, report: readReport(reading, before) })
    } else {
      instance.exports.wasi_thread_start(data.thread, data.argument)
      post({ kind: 'done' })
    }
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) throw error
    // Not every browser can clone an Error into a message, so its parts cross instead.
    post({ kind: 'trap', error: { name: error.name, message: error.message, stack: error.stack }, report: readReport(reading, before) })
  }
}

// Runs `bytes` and resolves to `main`'s status; a trap on any thread rejects with its error.
export const runWasm = async (bytes, options = {}) => {
  const module = await WebAssembly.compile(bytes)
  const limits = importedMemory(bytes)
  const wide = wideMemory(bytes)
  // A shared memory starts at its maximum. V8 tells other workers about a grow late, so a thread
  // that reaches newly grown pages through a pointer another thread just published can trap out of
  // bounds before its own view catches up. The pages are committed only as they are touched.
  const memory =
    limits === undefined
      ? undefined
      : new WebAssembly.Memory({
          initial: limits.shared && limits.maximum !== undefined ? limits.maximum : limits.initial,
          maximum: limits.maximum,
          shared: limits.shared,
        })
  const threads = new Int32Array(new SharedArrayBuffer(4))
  const parallelism = options.parallelism ?? (await defaultParallelism())
  const workerUrl = options.workerUrl ?? import.meta.url
  const workers = new Set()
  return await new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      for (const worker of workers) worker.terminate()
      settle(value)
    }
    const start = async (role) => {
      const data = { ...role, module, memory, threads, parallelism, wide }
      const worker = await createWorker(workerUrl, data)
      workers.add(worker)
      listen(worker, (message) => {
        if (message.kind === 'spawn') {
          start({ role: 'thread', thread: message.thread, argument: message.argument, before: message.before }).catch(
            (error) => finish(reject, error),
          )
        } else if (message.kind === 'log') {
          const onLog = options.onLog ?? ((level, text) => console[consoleMethods[level]](text))
          onLog(message.level, message.text)
        } else if (message.kind === 'exit') {
          if (message.report) (options.onReport ?? ((report) => console.error(report.trimEnd())))(message.report)
          finish(resolve, message.status)
        }
        else if (message.kind === 'done') {
          workers.delete(worker)
          worker.terminate()
        } else if (message.kind === 'trap') {
          finish(reject, message.report ? new SilkError(message.report, message.error) : engineError(message.error))
        }
      })
    }
    start({ role: 'main' }).catch((error) => finish(reject, error))
  })
}

const defaultParallelism = async () => {
  if (isNode) return (await import('node:os')).availableParallelism()
  return globalThis.navigator?.hardwareConcurrency ?? 1
}

const createWorker = async (url, data) => {
  if (isNode) {
    const { Worker } = await import('node:worker_threads')
    return new Worker(new URL(url), { workerData: data })
  }
  const worker = new Worker(url, { type: 'module' })
  worker.postMessage(data)
  return worker
}

const listen = (worker, handle) => {
  if (isNode) {
    worker.on('message', handle)
    worker.on('error', (error) => handle({ kind: 'trap', error }))
  } else {
    worker.onmessage = (event) => handle(event.data)
    worker.onerror = (event) => handle({ kind: 'trap', error: event.error ?? event.message })
  }
}

// Inside a Worker: wait for the role, then run it.
if (isNode) {
  const threading = await import('node:worker_threads')
  if (!threading.isMainThread && threading.workerData?.role !== undefined) {
    runRole(threading.workerData, (message) => threading.parentPort.postMessage(message))
  } else if (threading.isMainThread) {
    const { fileURLToPath } = await import('node:url')
    if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
      const path = process.argv[2]
      if (path === undefined) {
        process.stderr.write('usage: node wasm-runner.mjs <program.wasm>\n')
        process.exit(2)
      }
      const { readFile } = await import('node:fs/promises')
      try {
        process.exit((await runWasm(await readFile(path))) & 0xff)
      } catch (error) {
        process.stderr.write(`${error?.stack ?? error}\n`)
        process.exit(134)
      }
    }
  }
} else if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = (event) => {
    globalThis.onmessage = null
    runRole(event.data, (message) => globalThis.postMessage(message))
  }
}
