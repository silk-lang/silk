// Preview 2 sockets, HTTP, and custom WIT component composition.
import { strict as assert } from 'node:assert'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as NativeProcess from './NativeProcess.ts'

const external = (operation: string, cause: unknown) =>
  new NativeProcess.NativeProcessError({
    operation,
    reason: 'ExternalFailure',
    message: String(cause),
    cause,
  })
const listening = (handler: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<{ server: ReturnType<typeof createServer>; port: number }>(
          (resolve, reject) => {
            const server = createServer(handler)
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => {
              const address = server.address()
              if (address === null || typeof address === 'string') {
                server.close()
                reject(new Error('Missing TCP port'))
                return
              }
              resolve({ server, port: address.port })
            })
          },
        ),
      catch: (cause) => external('listen', cause),
    }),
    ({ server }) =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections()
            server.close((error) => (error ? reject(error) : resolve()))
          }),
        catch: (cause) => external('close', cause),
      }).pipe(Effect.orDie),
  )

export const verify = Effect.fn('WasiComponents.verify')(function* (
  compiler: string,
  clang: string,
  tools: string,
  repo: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem
  const wasmtime = join(tools, 'wasmtime')
  const wasmTools = join(tools, 'wasm-tools')
  const env = {
    ...process.env,
    SILK_CLANG: clang,
    SILK_WASM_TOOLS: wasmTools,
    SILK_WASI_ADAPTER: join(tools, 'wasi_snapshot_preview1.command.wasm'),
  }
  const invoke = (command: string, args: ReadonlyArray<string>, cwd = directory) =>
    NativeProcess.execute(command, args, { cwd, env, timeoutMs: 120_000 })
  const command = Effect.fnUntraced(function* (name: string) {
    const root = join(directory, name)
    yield* fs.makeDirectory(root)
    yield* fs.copyFile(join(repo, 'compiler/fixtures', name, 'main.silk'), join(root, 'main.silk'))
    yield* fs.writeFileString(join(root, 'silk.toml'), `[package]\nname="${name}"\nsource="."\n`)
    const output = join(root, 'out.wasm')
    const built = yield* invoke(
      compiler,
      [
        'build',
        'main.silk',
        '-o',
        output,
        '--target',
        'wasm32-wasip2',
        '--stdlib',
        join(repo, 'stdlib'),
      ],
      root,
    )
    assert.equal(built.status, 0, built.stderr.toString())
    return output
  })
  const network = yield* command('wasi-network')
  const connected = yield* invoke(wasmtime, [
    'run',
    '-S',
    'inherit-network=y',
    '-S',
    'allow-ip-name-lookup=y',
    '-W',
    'timeout=10',
    network,
  ])
  assert.equal(connected.status, 0, connected.stderr.toString())
  const denied = yield* invoke(wasmtime, ['run', network])
  assert.notEqual(denied.status, 0, 'socket bind requires a granted network capability')

  const destination = yield* listening((request, response) => {
    response.writeHead(request.headers.authorization === undefined ? 200 : 400)
    response.end('hello')
  })
  const origin = yield* listening((request, response) => {
    if (request.url === '/reject') {
      response.writeHead(413, { 'Content-Length': '0' })
      response.end()
      request.resume()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const redirect = (location: string) => {
        response.writeHead(302, { Location: location, 'Content-Length': '0' })
        response.end()
      }
      if (request.url === '/redirect') {
        redirect('/hello')
        return
      }
      if (request.url === '/rewrite') {
        redirect('/method')
        return
      }
      if (request.url === '/loop') {
        redirect('/loop')
        return
      }
      if (request.url === '/cross') {
        if (request.headers.authorization !== 'Bearer secret') {
          response.writeHead(400)
          response.end()
          return
        }
        redirect(`http://127.0.0.1:${destination.port}/check`)
        return
      }
      if (
        request.url === '/method' &&
        (request.method !== 'GET' || request.headers['content-type'] !== undefined)
      ) {
        response.writeHead(400)
        response.end()
        return
      }
      const body = request.url === '/echo' ? Buffer.concat(chunks) : Buffer.from('hello')
      response.writeHead(200, { 'Content-Length': String(body.length) })
      response.end(body)
    })
  })
  const client = yield* command('wasi-http-client')
  const fetched = yield* invoke(wasmtime, [
    'run',
    '-S',
    'http=y',
    '-S',
    'http-outgoing-body-chunk-size=4096',
    '-S',
    'max-resources=64',
    '-S',
    'max-component-handles=64',
    '--env',
    `SILK_TEST_HTTP_URL=http://127.0.0.1:${origin.port}`,
    '-W',
    'timeout=20',
    client,
  ])
  assert.equal(fetched.status, 0, fetched.stderr.toString())

  const reactor = Effect.fnUntraced(function* (
    name: string,
    world: string,
    source: string,
    wit: string,
  ) {
    const root = join(directory, name)
    yield* fs.makeDirectory(root)
    yield* fs.copyFile(source, join(root, 'main.silk'))
    yield* fs.copy(wit, join(root, 'wit'))
    yield* fs.writeFileString(
      join(root, 'silk.toml'),
      `[package]\nname="${name}"\nsource="."\n[profiles.component]\ntarget="wasm32-wasip2"\nruntime={kind="none"}\n[build]\nprofile="component"\n[component]\nwit="wit"\nworld="${world}"\n`,
    )
    const built = yield* invoke(compiler, ['build', '--stdlib', join(repo, 'stdlib')], root)
    assert.equal(built.status, 0, built.stderr.toString())
    return join(root, 'build/llvm/wasm32-wasip2/component', name)
  })
  const fixture = join(repo, 'compiler/fixtures/wasi-component')
  const consumer = yield* reactor(
    'consumer',
    'consumer',
    join(fixture, 'main.silk'),
    join(fixture, 'world.wit'),
  )
  const provider = yield* reactor(
    'provider',
    'provider',
    join(fixture, 'provider.silk'),
    join(fixture, 'world.wit'),
  )
  const composed = join(directory, 'composed.wasm')
  const composition = yield* invoke(wasmTools, [
    'compose',
    consumer,
    '-d',
    provider,
    '-o',
    composed,
  ])
  assert.equal(composition.status, 0, composition.stderr.toString())
  const called = yield* invoke(wasmtime, [
    'run',
    '--invoke',
    'summarize("héllo", [1, 2, 3])',
    composed,
  ])
  assert.equal(called.status, 0, called.stderr.toString())
  assert.equal(called.stdout.toString().trim(), '{label: "héllo", total: 42}')
  const empty = yield* invoke(wasmtime, ['run', '--invoke', 'summarize("", [])', composed])
  assert.equal(empty.status, 0, empty.stderr.toString())
  assert.equal(empty.stdout.toString().trim(), '{label: "", total: 30}')

  const server = yield* reactor(
    'http-server',
    'http',
    join(repo, 'compiler/fixtures/wasi-http-server/main.silk'),
    join(repo, 'stdlib/wit'),
  )
  // Reserve a host-selected port, then release it immediately before starting the runtime.
  const port = yield* Effect.scoped(
    Effect.gen(function* () {
      return (yield* listening((_request, response) => response.end())).port
    }),
  )
  yield* invoke(wasmtime, ['serve', '--addr', `127.0.0.1:${port}`, server]).pipe(Effect.forkScoped)
  let served = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const fetched = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(`http://127.0.0.1:${port}/echo?x=1`, {
          method: 'POST',
          body: 'x'.repeat(200000),
          signal: AbortSignal.timeout(2000),
        })
        return { status: response.status, body: await response.text() }
      },
      catch: (cause) => external('fetch', cause),
    }).pipe(Effect.option)
    if (fetched._tag === 'Some') {
      assert.equal(fetched.value.status, 201)
      assert.equal(fetched.value.body, 'x'.repeat(200000))
      served = true
      break
    }
    yield* Effect.sleep('50 millis')
  }
  assert.ok(served, 'the Preview 2 HTTP server responds through the standard proxy world')
})
