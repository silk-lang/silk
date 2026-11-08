// Real native silk.http.client requests against two loopback servers, over HTTP/1.1 and over
// HTTP/2 with TLS: query encoding, header defaults and overrides, bodies, status handling, redirects, credential stripping, and limits.
import * as assert from 'node:assert/strict'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { createServer } from 'node:http'
import { createSecureServer } from 'node:http2'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
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

const servers = new Set()
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

  // Both origins are served once over HTTP/1.1 and once over HTTP/2 with TLS, where the
  // client offers h2 and http/1.1 with ALPN and the server accepts only h2.
  const serve = async (create, scheme, host) => {
    const versions = new Set()
    const opened = { main: 0, other: 0 }
    // The most HTTP/2 streams open at once on one connection.
    const shared = { streams: 0 }
    const record = (handler) => (request, response) => {
      versions.add(request.httpVersion)
      const session = request.stream?.session
      if (session) {
        session.open = (session.open ?? 0) + 1
        shared.streams = Math.max(shared.streams, session.open)
        response.on('close', () => {
          session.open -= 1
        })
      }
      handler(request, response)
    }
    const other = create(record(handle([[/^\/echo$/, echo('other')]])))
    servers.add(other)
    await listen(other)
    const otherOrigin = `${scheme}://${host}:${other.address().port}`
    const redirect = (status, location) => (request, response) =>
      response.writeHead(status, { location }).end()
    let origin
    const main = create(
      record(
        handle([
          [/^\/echo$/, echo('main')],
          [/^\/status\/(\d+)$/, (request, response, body, [, code]) =>
            response.writeHead(Number(code)).end(`status ${code}`)],
          [/^\/redirect\/(\d+)$/, (request, response, body, [, hops]) =>
            redirect(302, hops === '0' ? '/echo' : `/redirect/${Number(hops) - 1}`)(request, response)],
          [/^\/absolute$/, (request, response) => redirect(302, `${origin}/echo`)(request, response)],
          [/^\/see-other$/, redirect(303, '/echo')],
          [/^\/temporary$/, redirect(307, '/echo')],
          [/^\/cross$/, redirect(302, `${otherOrigin}/echo`)],
          [/^\/large$/, (request, response) => response.writeHead(200).end('x'.repeat(4096))],
          [/^\/big$/, (request, response) => response.writeHead(200).end('b'.repeat(100000))],
          [/^\/length$/, (request, response, body) => response.writeHead(200).end(String(body.length))],
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
      ),
    )
    servers.add(main)
    await listen(main)
    origin = `${scheme}://${host}:${main.address().port}`
    const connection = scheme === 'https' ? 'session' : 'connection'
    main.on(connection, () => {
      opened.main += 1
    })
    other.on(connection, () => {
      opened.other += 1
    })
    return { main, origin, otherOrigin, opened, versions, shared }
  }

  const plain = await serve(createServer, 'http', '127.0.0.1')
  // A forward proxy answers itself, so the echo shows the absolute target it received. NO_PROXY
  // names 127.0.0.1, so the other server is reached directly.
  const proxy = createServer(handle([[/^\/echo$/, echo('proxy')]]))
  servers.add(proxy)
  const proxyOrigin = await listen(proxy)
  const through = `http://localhost:${plain.main.address().port}`
  const result = await run(executable, [plain.origin, plain.otherOrigin, through], {
    ...process.env,
    HTTP_PROXY: proxyOrigin.replace('http://', 'http://user:pa%3Ass@'),
    http_proxy: '',
    ALL_PROXY: '',
    NO_PROXY: 'example.invalid, 127.0.0.1',
    no_proxy: '',
  })
  assert.equal(result.status, 0, JSON.stringify(result))
  // Sequential requests reuse an idle connection, so a redirect to the other server and back
  // reuses the first connection to the main server. The four requests of `sendAll` run at once and
  // open up to four more, the two tasks of the 150-request batch up to two, and the sixteen tasks
  // of the last batch up to sixteen.
  assert.ok(plain.opened.main <= 26 && plain.opened.other <= 2, JSON.stringify(plain.opened))
  assert.deepEqual([...plain.versions], ['1.1'])
  console.log('Native silk.http.client conformance over HTTP/1.1 passed')

  const openssl = (...args) => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' })
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key')
  openssl('req', '-new', '-x509', '-key', 'root.key', '-sha256', '-days', '2', '-subj', '/CN=Silk Client Test Root',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', 'root.pem')
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key')
  openssl('req', '-new', '-key', 'leaf.key', '-subj', '/CN=localhost', '-out', 'leaf.csr')
  writeFileSync(
    join(directory, 'leaf.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n',
  )
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-set_serial', '10',
    '-days', '2', '-sha256', '-extfile', 'leaf.ext', '-out', 'leaf.pem')
  // Two streams at once per connection, fewer than the client puts on one: the others wait for
  // a stream to end.
  const tls = {
    key: readFileSync(join(directory, 'leaf.key')),
    cert: readFileSync(join(directory, 'leaf.pem')),
    settings: { maxConcurrentStreams: 2 },
  }
  const secure = await serve((handler) => createSecureServer(tls, handler), 'https', 'localhost')
  const secured = await run(executable, [secure.origin, secure.otherOrigin, '', join(directory, 'root.pem')])
  assert.equal(secured.status, 0, JSON.stringify(secured))
  assert.ok(secure.opened.main <= 26 && secure.opened.other <= 2, JSON.stringify(secure.opened))
  assert.deepEqual([...secure.versions], ['2.0'])
  // The sixteen tasks put several streams on one connection.
  assert.ok(secure.shared.streams > 1, JSON.stringify(secure.shared))
  console.log(`Native silk.http.client conformance over HTTP/2 with TLS passed ${JSON.stringify({ opened: secure.opened, streams: secure.shared.streams })}`)
} finally {
  for (const timer of timers) clearTimeout(timer)
  for (const server of servers) {
    server.closeAllConnections?.()
    server.close()
  }
  rmSync(directory, { recursive: true, force: true })
}
