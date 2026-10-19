// Real native transport and history queries against a controlled TLS server. No network fixture
// substitutes for HttpNative. --live additionally checks GitHub metadata and raw content.
import * as assert from 'node:assert/strict'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:https'
import { once } from 'node:events'
import {
  copyFileSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const compiler = resolve(
  await Effect.runPromise(
    Config.String('SILK_COMPILER').pipe(Config.withDefault(process.argv[2] ?? 'silk')),
  ),
)
const clang = await Effect.runPromise(Config.String('SILK_CLANG').pipe(Config.withDefault('clang')))
const root = resolve(import.meta.dirname, '../..')
const directory = mkdtempSync(join(realpathSync(tmpdir()), 'silk-native-https-'))
const openssl = (...args) => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' })
const run = (command, args, env = process.env) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      timeout: 60_000,
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
let server
try {
  copyFileSync(
    join(root, 'compiler/conformance/native-https/main.silk'),
    join(directory, 'main.silk'),
  )
  writeFileSync(
    join(directory, 'silk.toml'),
    `[package]\nname = "native-https-test"\nversion = "0.0.0"\nroot = "main.silk"\n[dependencies]\nchangeset = { path = ${JSON.stringify(join(root, 'changes'))} }\n`,
  )
  const executable = join(directory, 'https-test')
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

  // Match the compatibility gap: P-256 leaf and intermediate, P-384 authority, SHA-384 CA signature.
  openssl('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'root.key')
  openssl(
    'req',
    '-new',
    '-x509',
    '-key',
    'root.key',
    '-sha384',
    '-days',
    '2',
    '-subj',
    '/CN=Silk HTTPS Test Root',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-out',
    'root.pem',
  )
  openssl(
    'req',
    '-new',
    '-x509',
    '-key',
    'root.key',
    '-sha384',
    '-days',
    '2',
    '-subj',
    '/CN=Unrelated Test Root',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-out',
    'unrelated.pem',
  )
  for (const [name, parent, curve, hash, extensions] of [
    [
      'intermediate',
      'root',
      'prime256v1',
      '-sha384',
      'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
    ],
    [
      'leaf',
      'intermediate',
      'prime256v1',
      '-sha256',
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n',
    ],
  ]) {
    openssl('ecparam', '-name', curve, '-genkey', '-noout', '-out', `${name}.key`)
    openssl(
      'req',
      '-new',
      '-key',
      `${name}.key`,
      '-subj',
      `/CN=Silk HTTPS Test ${name}`,
      '-out',
      `${name}.csr`,
    )
    writeFileSync(join(directory, `${name}.ext`), extensions)
    openssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${parent}.pem`,
      '-CAkey',
      `${parent}.key`,
      '-set_serial',
      '10',
      '-days',
      '2',
      hash,
      '-extfile',
      `${name}.ext`,
      '-out',
      `${name}.pem`,
    )
  }
  const authority = readFileSync(join(directory, 'root.pem'), 'utf8')
  writeFileSync(
    join(directory, 'annotated.pem'),
    `# configured authority\nCertificate:\n    Data:\n${authority}\n# end\n`,
  )
  writeFileSync(
    join(directory, 'malformed.pem'),
    `${authority}\n-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n`,
  )
  const routes = new Map([
    [
      '/repos/owner/repo/releases/latest',
      JSON.stringify({ tag_name: 'v1.1.0', draft: false, prerelease: false }),
    ],
    [
      '/raw/owner/repo/v1.1.0/.changes/releases/1.1.0.toml',
      `format = 1\npackage = 'example'\nfrom = '1.1.0-beta.2+abc'\nversion = '1.1.0'\nbase = '1.0.0'\n[[changes]]\nid = 'first'\nbump = 'minor'\nsummary = 'Already installed'\n[[changes]]\nid = 'second'\nbump = 'patch'\nsummary = 'New fix'\nmigration = "Update config → safe\\nKeep this newline."\n`,
    ],
    [
      '/raw/owner/repo/v1.1.0/.changes/releases/1.1.0-beta.2%2Babc.toml',
      `format = 1\npackage = 'example'\nfrom = '1.0.0'\nversion = '1.1.0-beta.2+abc'\nbase = '1.0.0'\n[[changes]]\nid = 'first'\nbump = 'minor'\nsummary = 'Already installed'\n`,
    ],
  ])
  const requested = []
  server = createServer(
    {
      key: readFileSync(join(directory, 'leaf.key')),
      cert:
        readFileSync(join(directory, 'leaf.pem'), 'utf8') +
        readFileSync(join(directory, 'intermediate.pem'), 'utf8'),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ALPNProtocols: ['http/1.1'],
    },
    (request, response) => {
      requested.push(request.url)
      const body = routes.get(request.url)
      response.writeHead(body === undefined ? 404 : 200, {
        'Content-Type': 'text/plain',
        Connection: 'close',
      })
      response.end(body ?? 'Missing')
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const base = `https://localhost:${address.port}`
  for (const [label, host, bundle, expected] of [
    ['plain authority and complete history', base, 'root.pem', 0],
    ['annotated authority and complete history', base, 'annotated.pem', 0],
    ['malformed later certificate', base, 'malformed.pem', 12],
    ['untrusted issuer', base, 'unrelated.pem', 10],
    ['wrong hostname', `https://127.0.0.1:${address.port}`, 'root.pem', 11],
  ]) {
    const before = requested.length
    const result = await run(executable, [], {
      ...process.env,
      SILK_HTTPS_TEST_BASE: host,
      SSL_CERT_FILE: join(directory, bundle),
    })
    assert.equal(result.status, expected, `${label}: ${JSON.stringify(result)}`)
    if (expected === 0) assert.deepEqual(requested.slice(before), [...routes.keys()])
    else assert.equal(requested.length, before, `${label}: unauthenticated HTTP request escaped`)
    process.stdout.write(`native HTTPS ${process.platform}/${process.arch}: ${label} passed\n`)
  }
  // TLS syntax alone is insufficient: reject an expired leaf and a validly encoded forged signature.
  writeFileSync(join(directory, 'index.txt'), '')
  writeFileSync(join(directory, 'serial'), '20\n')
  writeFileSync(
    join(directory, 'expired.cnf'),
    `[ca]
default_ca = test
[test]
database = index.txt
serial = serial
new_certs_dir = .
default_md = sha256
policy = policy
[policy]
commonName = supplied
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost
`,
  )
  openssl(
    'ca',
    '-batch',
    '-config',
    'expired.cnf',
    '-cert',
    'intermediate.pem',
    '-keyfile',
    'intermediate.key',
    '-in',
    'leaf.csr',
    '-out',
    'expired.pem',
    '-startdate',
    '200101000000Z',
    '-enddate',
    '200102000000Z',
    '-extensions',
    'leaf',
    '-notext',
  )
  const forged = Buffer.from(
    readFileSync(join(directory, 'leaf.pem'), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('-----'))
      .join(''),
    'base64',
  )
  forged[forged.length - 1] ^= 1
  const forgedPem = `-----BEGIN CERTIFICATE-----\n${forged.toString('base64')}\n-----END CERTIFICATE-----\n`
  const intermediate = readFileSync(join(directory, 'intermediate.pem'), 'utf8')
  for (const [label, certificate, reason] of [
    ['expired certificate', readFileSync(join(directory, 'expired.pem'), 'utf8'), /InvalidTime/],
    ['forged certificate signature', forgedPem, /InvalidSignature/],
  ]) {
    server.setSecureContext({
      key: readFileSync(join(directory, 'leaf.key')),
      cert: certificate + intermediate,
    })
    const before = requested.length
    const result = await run(executable, [], {
      ...process.env,
      SILK_HTTPS_TEST_BASE: base,
      SSL_CERT_FILE: join(directory, 'root.pem'),
    })
    assert.equal(result.status, 10, `${label}: ${JSON.stringify(result)}`)
    assert.match(result.stderr, reason)
    assert.equal(requested.length, before, `${label}: unauthenticated HTTP request escaped`)
    process.stdout.write(`native HTTPS ${process.platform}/${process.arch}: ${label} passed\n`)
  }
  server.setSecureContext({
    key: readFileSync(join(directory, 'leaf.key')),
    cert: readFileSync(join(directory, 'leaf.pem'), 'utf8') + intermediate,
  })
  routes.delete('/raw/owner/repo/v1.1.0/.changes/releases/1.1.0.toml')
  const missingHistory = await run(executable, [], {
    ...process.env,
    SILK_HTTPS_TEST_BASE: base,
    SSL_CERT_FILE: join(directory, 'root.pem'),
  })
  assert.equal(missingHistory.status, 14, JSON.stringify(missingHistory))
  assert.match(missingHistory.stderr, /Incomplete release history/)
  process.stdout.write(
    `native HTTPS ${process.platform}/${process.arch}: missing archive remains a history error passed\n`,
  )
  if (process.argv.includes('--live')) {
    const { SILK_HTTPS_TEST_BASE: _base, SSL_CERT_FILE: _bundle, ...environment } = process.env
    const live = await run(executable, [], environment)
    assert.equal(live.status, 0, `live default bundle: ${JSON.stringify(live)}`)
    process.stdout.write(
      `native HTTPS ${process.platform}/${process.arch}: live GitHub metadata 200, raw manifest 200, missing history 404 passed\n`,
    )
  }
} finally {
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
  rmSync(directory, { recursive: true, force: true })
}
