// Real native silk.http.client requests against two loopback HTTP servers: query encoding, header
// defaults and overrides, bodies, status handling, redirects, credential stripping, and limits.
import * as assert from 'node:assert/strict'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const compiler = resolve(
  await Effect.runPromise(
    Config.String('SILK_COMPILER').pipe(Config.withDefault(process.argv[2] ?? 'silk')),
  ),
)
const clang = await Effect.runPromise(Config.String('SILK_CLANG').pipe(Config.withDefault('clang')))
const root = resolve(import.meta.dirname, '../..')
const directory = mkdtempSync(join(realpathSync(tmpdir()), 'silk-native-http-client-'))
const run = (command, args, env = process.env) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (text) => {
      stdout += text
    })
    child.stderr.setEncoding('utf8').on('data', (text) => {
      stderr += text
    })
    child.on('error', reject)
    child.on('close', (status, signal) => resolveRun({ status, signal, stdout, stderr }))
  })

const listen = async (server) => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

const echo = (name) => (request, response, body) => {
  const header = (key) => request.headers[key] ?? ''
  response.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' })
  response.end(
    JSON.stringify({
      server: name,
      method: request.method,
      target: request.url,
      userAgent: header('user-agent'),
      acceptEncoding: header('accept-encoding'),
      authorization: header('authorization'),
      proxyAuthorization: header('proxy-authorization'),
      cookie: header('cookie'),
      xDefault: header('x-default'),
      contentType: header('content-type'),
      body,
    }),
  )
}

const handle = (routes) => (request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    for (const [pattern, route] of routes) {
      const match = path.match(pattern)
      if (match) return route(request, response, body, match)
    }
    response.writeHead(500).end(`no route for ${request.url}`)
  })
}

let main
let other
let proxy
const timers = new Set()
try {
  copyFileSync(
    join(root, 'compiler/conformance/native-http-client/main.silk'),
    join(directory, 'main.silk'),
  )
  writeFileSync(
    join(directory, 'silk.toml'),
    '[package]\nname = "native-http-client-test"\nversion = "0.0.0"\nsource = "."\n',
  )
  const executable = join(directory, 'http-client-test')
  const build = await run(compiler, [
    'build',
    join(directory, 'main.silk'),
    '-o',
    executable,
    '--stdlib',
    join(root, 'stdlib'),
    '--clang',
    clang,
    '--optimization',
    'speed',
    '--debug',
    'false',
  ])
  assert.equal(build.status, 0, JSON.stringify(build))

  other = createServer(handle([[/^\/echo$/, echo('other')]]))
  const otherOrigin = await listen(other)
  const redirect = (status, location) => (request, response) =>
    response.writeHead(status, { location }).end()
  main = createServer(
    handle([
      [/^\/echo$/, echo('main')],
      [/^\/status\/(\d+)$/, (request, response, body, [, code]) =>
        response.writeHead(Number(code)).end(`status ${code}`)],
      [/^\/redirect\/(\d+)$/, (request, response, body, [, hops]) =>
        redirect(302, hops === '0' ? '/echo' : `/redirect/${Number(hops) - 1}`)(request, response)],
      [/^\/absolute$/, (request, response) =>
        redirect(302, `http://127.0.0.1:${main.address().port}/echo`)(request, response)],
      [/^\/see-other$/, redirect(303, '/echo')],
      [/^\/temporary$/, redirect(307, '/echo')],
      [/^\/cross$/, redirect(302, `${otherOrigin}/echo`)],
      [/^\/large$/, (request, response) => response.writeHead(200).end('x'.repeat(4096))],
      [/^\/json-string$/, (request, response) =>
        response.writeHead(200, { 'content-type': 'application/json' }).end('"hello"')],
      [/^\/slow$/, (request, response) => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          response.writeHead(200).end('late')
        }, 5_000)
        timers.add(timer)
      }],
    ]),
  )
  const origin = await listen(main)

  // A forward proxy answers itself, so the echo shows the absolute target it received. NO_PROXY
  // names 127.0.0.1, so the other server is reached directly.
  proxy = createServer(handle([[/^\/echo$/, echo('proxy')]]))
  const proxyOrigin = await listen(proxy)
  const through = `http://localhost:${main.address().port}`
  const result = await run(executable, [origin, otherOrigin, through], {
    ...process.env,
    HTTP_PROXY: proxyOrigin.replace('http://', 'http://user:pa%3Ass@'),
    http_proxy: '',
    ALL_PROXY: '',
    NO_PROXY: 'example.invalid, 127.0.0.1',
    no_proxy: '',
  })
  assert.equal(result.status, 0, JSON.stringify(result))
  console.log('Native silk.http.client conformance passed')
} finally {
  for (const timer of timers) clearTimeout(timer)
  main?.closeAllConnections?.()
  other?.closeAllConnections?.()
  proxy?.closeAllConnections?.()
  main?.close()
  other?.close()
  proxy?.close()
  rmSync(directory, { recursive: true, force: true })
}
