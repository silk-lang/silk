// Bidirectional HTTP/2 interoperability with Node/nghttp2, authenticated h2 ALPN, and h2spec.
import http2 from 'node:http2'
import http from 'node:http'
import tls from 'node:tls'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const directory = mkdtempSync(join(realpathSync(tmpdir()), 'silk-http2-'))
const executable = join(directory, 'http2-test')
const servers = new Set()
const children = new Set()
const sessions = new Set()
const run = async (command, args, timeout = 120_000) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout })
  children.add(child)
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (text) => {
    output += text
  })
  child.stderr.setEncoding('utf8').on('data', (text) => {
    output += text
  })
  const [code, signal] = await once(child, 'exit')
  children.delete(child)
  return { code, signal, output }
}
const listen = async (server) => {
  servers.add(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
const respond = (stream, headers) => {
  stream.on('error', () => {})
  const path = headers[':path']
  const body = path === '/alpha' ? 'alpha' : path === '/beta' ? 'beta' : 'x'.repeat(100000)
  stream.additionalHeaders({ ':status': 103, link: '</a>; rel=preload' })
  stream.respond(
    { ':status': 200, 'content-length': String(body.length), 'x-huffman': 'www.example.com' },
    { waitForTrailers: true },
  )
  stream.on('wantTrailers', () => stream.sendTrailers({ 'x-finished': 'yes' }))
  stream.end(body)
}
const track = (server) => {
  server.on('session', (session) => {
    sessions.add(session)
    session.on('error', () => {})
    session.on('close', () => sessions.delete(session))
  })
  server.on('stream', respond)
  return server
}
const openssl = (...args) => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' })

try {
  copyFileSync(
    join(root, 'compiler/conformance/native-http2/main.silk'),
    join(directory, 'main.silk'),
  )
  writeFileSync(
    join(directory, 'silk.toml'),
    '[package]\nname = "http2-test"\nversion = "0.0.0"\nsource = "."\n',
  )
  const build = await run(process.env.SILK_COMPILER ?? 'silk', [
    'build',
    join(directory, 'main.silk'),
    '-o',
    executable,
    '--stdlib',
    join(root, 'stdlib'),
    '--clang',
    process.env.SILK_CLANG ?? 'clang',
  ])
  assert.equal(build.code, 0, build.output)

  const plain = track(http2.createServer())
  const plainPort = await listen(plain)
  const client = await run(executable, [String(plainPort)], 15000)
  assert.equal(client.code, 0, JSON.stringify(client))
  console.log(
    'Silk client / Node server: multiplexing, informational responses, trailers, 100 KB flow control passed',
  )

  writeFileSync(
    join(directory, 'request.cnf'),
    '[req]\ndistinguished_name=dn\n[dn]\n[root]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
  )
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key')
  openssl(
    'req',
    '-config',
    'request.cnf',
    '-new',
    '-x509',
    '-key',
    'root.key',
    '-sha256',
    '-days',
    '2',
    '-subj',
    '/CN=Silk HTTP2 Test Root',
    '-extensions',
    'root',
    '-out',
    'root.pem',
  )
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key')
  openssl(
    'req',
    '-config',
    'request.cnf',
    '-new',
    '-key',
    'leaf.key',
    '-subj',
    '/CN=localhost',
    '-out',
    'leaf.csr',
  )
  writeFileSync(
    join(directory, 'leaf.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n',
  )
  openssl(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'root.pem',
    '-CAkey',
    'root.key',
    '-set_serial',
    '10',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    'leaf.ext',
    '-out',
    'leaf.pem',
  )
  const secureOptions = {
    key: readFileSync(join(directory, 'leaf.key')),
    cert: readFileSync(join(directory, 'leaf.pem')),
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    ecdhCurve: 'X25519',
  }
  const secured = track(http2.createSecureServer(secureOptions))
  const securePort = await listen(secured)
  const secureClient = await run(
    executable,
    [String(securePort), 'tls', join(directory, 'root.pem')],
    15000,
  )
  assert.equal(secureClient.code, 0, JSON.stringify(secureClient))
  console.log('Silk client / Node TLS server: authenticated TLS 1.3 with required h2 ALPN passed')

  const wrongAlpn = tls.createServer({ ...secureOptions, ALPNProtocols: ['http/1.1'] })
  wrongAlpn.on('tlsClientError', () => {})
  wrongAlpn.on('secureConnection', (socket) => socket.end())
  const wrongPort = await listen(wrongAlpn)
  const rejected = await run(
    executable,
    [String(wrongPort), 'tls', join(directory, 'root.pem')],
    15000,
  )
  assert.equal(rejected.code, 99, JSON.stringify(rejected))
  console.log('HTTP/2 TLS client rejects a peer without h2 ALPN')

  const reservation = net.createServer()
  const port = await listen(reservation)
  await new Promise((resolveClose) => reservation.close(resolveClose))
  servers.delete(reservation)
  const native = spawn(executable, [String(port), 'server'], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(native)
  let ready = false
  for (let i = 0; i < 100; i++) {
    ready = await new Promise((resolveReady) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolveReady(true)
      })
      socket.once('error', () => resolveReady(false))
    })
    if (ready) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.ok(ready, 'Silk server listens')
  const session = http2.connect(`http://127.0.0.1:${port}`)
  sessions.add(session)
  session.on('error', () => {})
  await Promise.all(
    Array.from(
      { length: 8 },
      (_, index) =>
        new Promise((resolveRequest, reject) => {
          const request = session.request({
            ':path': `/request/${index}`,
            'x-repeated': 'hello compressed world',
          })
          const timeout = setTimeout(() => reject(new Error('HTTP/2 response timeout')), 10000)
          let body = ''
          let trailer = false
          request.setEncoding('utf8')
          request.on('data', (chunk) => {
            body += chunk
          })
          request.on('response', (headers) => {
            try {
              assert.equal(headers[':status'], 200)
              assert.equal(headers['x-silk'], 'http2')
            } catch (error) {
              reject(error)
            }
          })
          request.on('trailers', (headers) => {
            trailer = headers['x-finished'] === 'yes'
          })
          request.on('error', (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          request.on('end', () => {
            clearTimeout(timeout)
            try {
              assert.equal(body, 'hello')
              assert.ok(trailer)
              resolveRequest()
            } catch (error) {
              reject(error)
            }
          })
          request.end()
        }),
    ),
  )
  session.close()
  await once(session, 'close')
  sessions.delete(session)
  console.log('Node client / Silk server: eight multiplexed requests and trailers passed')

  if (process.env.SILK_H2SPEC) {
    const conformance = await run(
      process.env.SILK_H2SPEC,
      ['-h', '127.0.0.1', '-p', String(port), '--strict', '-o', '2'],
      180000,
    )
    assert.equal(conformance.code, 0, conformance.output)
    console.log(conformance.output.slice(conformance.output.lastIndexOf('Finished in')))
  }

  // silk.http.serve: HTTP/1.1 and HTTP/2 with prior knowledge on one port.
  const serveDirectory = join(directory, 'serve')
  mkdirSync(serveDirectory)
  copyFileSync(
    join(root, 'compiler/conformance/native-serve-http2/main.silk'),
    join(serveDirectory, 'main.silk'),
  )
  writeFileSync(
    join(serveDirectory, 'silk.toml'),
    '[package]\nname = "serve-http2-test"\nversion = "0.0.0"\nsource = "."\n',
  )
  const serveExecutable = join(serveDirectory, 'serve')
  const serveBuild = await run(process.env.SILK_COMPILER ?? 'silk', [
    'build',
    join(serveDirectory, 'main.silk'),
    '-o',
    serveExecutable,
    '--stdlib',
    join(root, 'stdlib'),
    '--clang',
    process.env.SILK_CLANG ?? 'clang',
  ])
  assert.equal(serveBuild.code, 0, serveBuild.output)
  const serveReservation = net.createServer()
  const servePort = await listen(serveReservation)
  await new Promise((resolveClose) => serveReservation.close(resolveClose))
  servers.delete(serveReservation)
  const served = spawn(serveExecutable, [String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(served)
  let serveReady = false
  for (let i = 0; i < 100 && !serveReady; i++) {
    serveReady = await new Promise((resolveReady) => {
      const socket = net.connect(servePort, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolveReady(true)
      })
      socket.once('error', () => resolveReady(false))
    })
    if (!serveReady) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.ok(serveReady, 'Silk serve listens')

  const http1 = await new Promise((resolveGet, reject) => {
    http
      .get({ host: '127.0.0.1', port: servePort, path: '/one', headers: { 'x-test': 'h1' } }, (response) => {
        let body = ''
        response.setEncoding('utf8').on('data', (text) => (body += text))
        response.on('end', () => resolveGet({ status: response.statusCode, body }))
      })
      .on('error', reject)
  })
  assert.deepEqual(http1, { status: 200, body: 'hello /one h1' })

  const serveSession = http2.connect(`http://127.0.0.1:${servePort}`)
  sessions.add(serveSession)
  serveSession.on('error', () => {})
  const exchange = (headers, body) =>
    new Promise((resolveExchange, reject) => {
      const request = serveSession.request(headers, { endStream: body === undefined })
      const timeout = setTimeout(() => reject(new Error(`timeout ${headers[':path']}`)), 10000)
      const chunks = []
      let head
      request.on('response', (fields) => (head = fields))
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      request.on('end', () => {
        clearTimeout(timeout)
        resolveExchange({ head, body: Buffer.concat(chunks) })
      })
      if (body !== undefined) request.end(body)
    })
  const many = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      exchange({ ':path': `/many/${index}`, 'x-test': `stream ${index}` }),
    ),
  )
  many.forEach(({ head, body }, index) => {
    assert.equal(head[':status'], 200)
    assert.equal(head['x-served-by'], 'Silk')
    assert.equal(head['content-length'], String(body.length))
    assert.ok(head.date)
    assert.equal(body.toString(), `hello /many/${index} stream ${index}`)
  })
  const upload = Buffer.alloc(200000, 'u')
  const echoed = await exchange({ ':method': 'POST', ':path': '/echo' }, upload)
  assert.equal(echoed.head['x-method'], 'POST')
  assert.ok(echoed.body.equals(upload), 'a 200 KB body round-trips through flow control')
  const large = await exchange({ ':path': '/large' })
  assert.equal(large.body.length, 100000)
  assert.ok(large.body.equals(Buffer.alloc(100000, 'x')))
  const missing = await exchange({ ':path': '/missing' })
  assert.equal(missing.head[':status'], 404)
  assert.equal(missing.body.toString(), 'missing')
  const head = await exchange({ ':method': 'HEAD', ':path': '/large' })
  assert.equal(head.head['content-length'], '100000')
  assert.equal(head.body.length, 0)
  serveSession.close()
  await once(serveSession, 'close')
  sessions.delete(serveSession)
  console.log('Node client / Silk serve: HTTP/1.1 and HTTP/2 on one port, multiplexing, 200 KB upload, HEAD passed')

  if (process.env.SILK_H2SPEC) {
    // Every section but 3.5/2: a cleartext server cannot tell an invalid preface from HTTP/1.1.
    const sections = ['generic', 'hpack', 'http2/3.5/1', 'http2/4', 'http2/5', 'http2/6', 'http2/7', 'http2/8']
    const conformance = await run(
      process.env.SILK_H2SPEC,
      ['-h', '127.0.0.1', '-p', String(servePort), '--strict', '-o', '2', ...sections],
      180000,
    )
    assert.equal(conformance.code, 0, conformance.output)
    console.log(`serve h2spec: ${conformance.output.slice(conformance.output.lastIndexOf('Finished in'))}`)
  }
} finally {
  for (const session of sessions) session.destroy()
  for (const child of children) child.kill('SIGKILL')
  for (const server of servers) server.close()
  rmSync(directory, { recursive: true, force: true })
}
