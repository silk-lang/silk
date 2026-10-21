// Runs a Silk wasm32 module: `node wasm-runner.mjs program.wasm` exits with the status `main`
// returns. A module built with `threading = "multi"` imports one shared memory and the
// wasi-threads `thread-spawn`; this runner creates that memory, runs `main` in a Worker, and
// starts every thread as another Worker that instantiates the same module on the same memory.
// A module without threads runs the same way. Browsers use `runWasm` from a module script.
//
// Every Worker is created by the top-level thread, never by another Worker, so a thread that
// returns cannot take the threads it started with it. `main` never runs on the top-level thread,
// because a browser's main thread may not block in `memory.atomic.wait32`.

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
          return { initial, maximum, shared: (flags & 2) !== 0 }
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

// The imports one instance needs. `spawn` starts a thread from a start argument and answers its
// positive id, or a negative error.
const importsFor = (memory, spawn, parallelism) => ({
  env: memory === undefined ? {} : { memory },
  wasi: { 'thread-spawn': spawn },
  silk: { 'thread-parallelism': () => parallelism },
})

// One Worker's work: `main`, whose status it reports, or one thread.
const runRole = (data, post) => {
  const spawn = (argument) => {
    const thread = Atomics.add(data.threads, 0, 1) + 1
    post({ kind: 'spawn', thread, argument })
    return thread
  }
  const instance = new WebAssembly.Instance(
    data.module,
    importsFor(data.memory, spawn, data.parallelism),
  )
  if (data.role === 'main') {
    post({ kind: 'exit', status: instance.exports.main() })
  } else {
    instance.exports.wasi_thread_start(data.thread, data.argument)
    post({ kind: 'done' })
  }
}

// Runs `bytes` and resolves to `main`'s status; a trap on any thread rejects with its error.
export const runWasm = async (bytes, options = {}) => {
  const module = await WebAssembly.compile(bytes)
  const limits = importedMemory(bytes)
  const memory =
    limits === undefined
      ? undefined
      : new WebAssembly.Memory({
          initial: limits.initial,
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
      const data = { ...role, module, memory, threads, parallelism }
      const worker = await createWorker(workerUrl, data)
      workers.add(worker)
      listen(worker, (message) => {
        if (message.kind === 'spawn') {
          start({ role: 'thread', thread: message.thread, argument: message.argument }).catch(
            (error) => finish(reject, error),
          )
        } else if (message.kind === 'exit') finish(resolve, message.status)
        else if (message.kind === 'done') {
          workers.delete(worker)
          worker.terminate()
        } else if (message.kind === 'trap') finish(reject, message.error)
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
