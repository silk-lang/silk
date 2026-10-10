import { readFileSync } from 'node:fs'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  X509Certificate,
} from 'node:crypto'

const fixture = (name: string): Uint8Array =>
  readFileSync(new URL(`../fixtures/tls-client/${name}`, import.meta.url))
// One byte-string token keeps fixture-heavy acceptance sources economical for the analysis graph;
// spelling every byte as an array element multiplies syntax nodes without adding coverage.
const silkBytes = (bytes: Uint8Array): string =>
  `b"${[...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`

export const tlsClientRsaRootPem = fixture('keys/root-cert.pem')
export const tlsClientRsaClientHello = fixture('captures/rsa-x25519-client-hello.bin')
export const tlsClientRsaServerFlight = fixture('captures/rsa-x25519-server-flight.bin')
const rootPem = tlsClientRsaRootPem
const clientHello = tlsClientRsaClientHello
const serverFlight = tlsClientRsaServerFlight
const wrongNameClientHello = fixture('captures/rsa-x25519-wrong-name-client-hello.bin')
const wrongNameServerFlight = fixture('captures/rsa-x25519-wrong-name-server-flight.bin')
export const tlsClientRsaWrongNameClientHello = wrongNameClientHello
export const tlsClientRsaWrongNameServerFlight = wrongNameServerFlight
const ipClientHello = fixture('captures/rsa-x25519-ip-client-hello.bin')
const ipServerFlight = fixture('captures/rsa-x25519-ip-server-flight.bin')
const aes128ClientHello = fixture('captures/ecdsa-x25519-aes128-client-hello.bin')
const aes128ServerFlight = fixture('captures/ecdsa-x25519-aes128-server-flight.bin')
const aes128NoAlpnServerFlight = fixture('captures/ecdsa-x25519-aes128-no-alpn-server-flight.bin')
const aes256ClientHello = fixture('captures/ecdsa-p256-aes256-client-hello.bin')
const aes256ClientRetry = fixture('captures/ecdsa-p256-aes256-client-retry.bin')
const aes256ServerRetry = fixture('captures/ecdsa-p256-aes256-server-retry.bin')
const aes256ServerFlight = fixture('captures/ecdsa-p256-aes256-server-flight.bin')
const alpnBoundaryProtocols = [1, 2, 3, 4, 5].map((value) =>
  Uint8Array.from({ length: 255 }, () => value),
)
const alpnBoundaryBytes = Buffer.concat(alpnBoundaryProtocols)

type Suite = 'chacha' | 'aes128' | 'aes256'

const keyLogSecret = (id: string, label: string): Buffer => {
  const line = readFileSync(
    new URL(`../fixtures/tls-client/captures/${id}-keylog.TEST-ONLY.txt`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .find((candidate) => candidate.startsWith(`${label} `))
  if (line === undefined) throw new Error(`missing ${label} in ${id}`)
  const encoded = line.split(' ').at(2)
  if (encoded === undefined) throw new Error(`malformed ${label} in ${id}`)
  return Buffer.from(encoded, 'hex')
}

const suiteParameters = (suite: Suite) => ({
  hash: suite === 'aes256' ? ('sha384' as const) : ('sha256' as const),
  keyLength: suite === 'aes128' ? 16 : 32,
})

const expandLabel = (secret: Uint8Array, label: string, length: number, suite: Suite): Buffer => {
  const info = Buffer.concat([
    Buffer.from([length >> 8, length & 0xff, 6 + label.length]),
    Buffer.from(`tls13 ${label}`),
    Buffer.from([0, 1]),
  ])
  return createHmac(suiteParameters(suite).hash, secret).update(info).digest().subarray(0, length)
}

const nonceFor = (iv: Uint8Array, sequence: number): Buffer => {
  const nonce = Buffer.from(iv)
  const encoded = Buffer.alloc(8)
  encoded.writeBigUInt64BE(BigInt(sequence))
  for (let index = 0; index < 8; index += 1) {
    nonce[index + 4] = (nonce[index + 4] ?? 0) ^ (encoded[index] ?? 0)
  }
  return nonce
}

const protectRecord = (
  plaintext: Uint8Array,
  contentType: number,
  secret: Uint8Array,
  suite: Suite,
  sequence: number,
): Buffer => {
  const parameters = suiteParameters(suite)
  const key = expandLabel(secret, 'key', parameters.keyLength, suite)
  const iv = expandLabel(secret, 'iv', 12, suite)
  const payloadLength = plaintext.length + 1 + 16
  const header = Buffer.from([23, 3, 3, payloadLength >> 8, payloadLength & 0xff])
  const nonce = nonceFor(iv, sequence)
  const cipher = (() => {
    if (suite === 'chacha')
      return createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
    if (suite === 'aes128') return createCipheriv('aes-128-gcm', key, nonce)
    return createCipheriv('aes-256-gcm', key, nonce)
  })()
  cipher.setAAD(header, { plaintextLength: plaintext.length + 1 })
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.update(Buffer.from([contentType])),
    cipher.final(),
  ])
  return Buffer.concat([header, encrypted, cipher.getAuthTag()])
}

const unprotectRecord = (
  record: Uint8Array,
  secret: Uint8Array,
  suite: Suite,
  sequence: number,
): Buffer => {
  const parameters = suiteParameters(suite)
  const header = Buffer.from(record.subarray(0, 5))
  const body = Buffer.from(record.subarray(5))
  const ciphertext = body.subarray(0, -16)
  const key = expandLabel(secret, 'key', parameters.keyLength, suite)
  const nonce = nonceFor(expandLabel(secret, 'iv', 12, suite), sequence)
  const decipher = (() => {
    if (suite === 'chacha')
      return createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
    if (suite === 'aes128') return createDecipheriv('aes-128-gcm', key, nonce)
    return createDecipheriv('aes-256-gcm', key, nonce)
  })()
  decipher.setAAD(header, { plaintextLength: ciphertext.length })
  decipher.setAuthTag(body.subarray(-16))
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

interface RecordRange {
  readonly start: number
  readonly end: number
  readonly contentType: number
}

const recordRanges = (flight: Uint8Array): ReadonlyArray<RecordRange> => {
  const ranges: Array<RecordRange> = []
  let cursor = 0
  while (cursor < flight.length) {
    const length = (flight[cursor + 3] ?? 0) * 256 + (flight[cursor + 4] ?? 0)
    ranges.push({ start: cursor, end: cursor + 5 + length, contentType: flight[cursor] ?? 0 })
    cursor += 5 + length
  }
  if (cursor !== flight.length) throw new Error('truncated TLS fixture record')
  return ranges
}

interface HandshakeRange {
  readonly start: number
  readonly end: number
  readonly kind: number
}

const handshakeRanges = (messages: Uint8Array): ReadonlyArray<HandshakeRange> => {
  const ranges: Array<HandshakeRange> = []
  let cursor = 0
  while (cursor < messages.length) {
    const length =
      (messages[cursor + 1] ?? 0) * 65_536 +
      (messages[cursor + 2] ?? 0) * 256 +
      (messages[cursor + 3] ?? 0)
    ranges.push({ start: cursor, end: cursor + 4 + length, kind: messages[cursor] ?? 0 })
    cursor += 4 + length
  }
  if (cursor !== messages.length) throw new Error('truncated TLS fixture handshake')
  return ranges
}

const handshakeMessage = (kind: number, body: Uint8Array): Buffer =>
  Buffer.concat([
    Buffer.from([kind, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ])

const mutateHandshakeFlight = (
  id: string,
  suite: Suite,
  flight: Uint8Array,
  mutate: (messages: Buffer) => Buffer,
): Buffer => {
  const protectedRange = recordRanges(flight).find((range) => range.contentType === 23)
  if (protectedRange === undefined) throw new Error(`missing protected handshake in ${id}`)
  const secret = keyLogSecret(id, 'SERVER_HANDSHAKE_TRAFFIC_SECRET')
  const plaintext = unprotectRecord(
    flight.subarray(protectedRange.start, protectedRange.end),
    secret,
    suite,
    0,
  )
  if (plaintext.at(-1) !== 22) throw new Error(`wrong protected handshake type in ${id}`)
  const changed = mutate(Buffer.from(plaintext.subarray(0, -1)))
  const protectedRecord = protectRecord(changed, 22, secret, suite, 0)
  return Buffer.concat([
    flight.subarray(0, protectedRange.start),
    protectedRecord,
    flight.subarray(protectedRange.end),
  ])
}

const certificateChainDer = (
  id: string,
  suite: Suite,
  flight: Uint8Array,
): ReadonlyArray<Buffer> => {
  const protectedRange = recordRanges(flight).find((range) => range.contentType === 23)
  if (protectedRange === undefined) throw new Error(`missing protected handshake in ${id}`)
  const secret = keyLogSecret(id, 'SERVER_HANDSHAKE_TRAFFIC_SECRET')
  const plaintext = unprotectRecord(
    flight.subarray(protectedRange.start, protectedRange.end),
    secret,
    suite,
    0,
  )
  if (plaintext.at(-1) !== 22) throw new Error(`wrong protected handshake type in ${id}`)
  const messages = plaintext.subarray(0, -1)
  const certificate = handshakeRanges(messages).find((range) => range.kind === 11)
  if (certificate === undefined) throw new Error(`missing Certificate in ${id}`)
  const message = messages.subarray(certificate.start, certificate.end)
  const contextLength = message[4] ?? 0
  const listStart = 5 + contextLength
  const listLength =
    (message[listStart] ?? 0) * 65_536 +
    (message[listStart + 1] ?? 0) * 256 +
    (message[listStart + 2] ?? 0)
  let cursor = listStart + 3
  const listEnd = cursor + listLength
  if (listEnd !== message.length) throw new Error(`malformed Certificate list in ${id}`)
  const chain: Array<Buffer> = []
  while (cursor < listEnd) {
    const derLength =
      (message[cursor] ?? 0) * 65_536 +
      (message[cursor + 1] ?? 0) * 256 +
      (message[cursor + 2] ?? 0)
    cursor += 3
    const derEnd = cursor + derLength
    if (derEnd + 2 > listEnd) throw new Error(`truncated Certificate entry in ${id}`)
    chain.push(Buffer.from(message.subarray(cursor, derEnd)))
    cursor = derEnd
    const extensionLength = (message[cursor] ?? 0) * 256 + (message[cursor + 1] ?? 0)
    cursor += 2 + extensionLength
    if (cursor > listEnd) throw new Error(`truncated Certificate extensions in ${id}`)
  }
  return chain
}

const expectedEcdsaLeafDer = new X509Certificate(fixture('keys/ecdsa-leaf-cert.pem')).raw
const expectedRsaLeafDer = new X509Certificate(fixture('keys/rsa-leaf-cert.pem')).raw
const expectedRootDer = new X509Certificate(fixture('keys/root-cert.pem')).raw
const capturedEcdsaChain = certificateChainDer('ecdsa-x25519-aes128', 'aes128', aes128ServerFlight)
const capturedRsaChain = certificateChainDer('rsa-x25519', 'chacha', serverFlight)
if (
  capturedEcdsaChain.length !== 2 ||
  !capturedEcdsaChain[0]?.equals(expectedEcdsaLeafDer) ||
  !capturedEcdsaChain[1]?.equals(expectedRootDer)
) {
  throw new Error('ECDSA rustls capture does not contain the pinned leaf and root chain')
}
if (
  capturedRsaChain.length !== 2 ||
  !capturedRsaChain[0]?.equals(expectedRsaLeafDer) ||
  !capturedRsaChain[1]?.equals(expectedRootDer)
) {
  throw new Error('RSA rustls capture does not contain the pinned leaf and root chain')
}

for (const [id, flight] of [
  ['rsa-x25519-wrong-name', wrongNameServerFlight],
  ['rsa-x25519-ip', ipServerFlight],
] as const) {
  const chain = certificateChainDer(id, 'chacha', flight)
  if (
    chain.length !== 2 ||
    !chain[0]?.equals(expectedRsaLeafDer) ||
    !chain[1]?.equals(expectedRootDer)
  ) {
    throw new Error(`${id} rustls capture does not contain the pinned leaf and root chain`)
  }
}

const clientHelloSni = (record: Uint8Array): Buffer | undefined => {
  if (record[0] !== 22 || record[5] !== 1) throw new Error('expected a ClientHello record')
  let cursor = 5 + 4 + 2 + 32
  const sessionLength = record[cursor] ?? 0
  cursor += 1 + sessionLength
  const suitesLength = (record[cursor] ?? 0) * 256 + (record[cursor + 1] ?? 0)
  cursor += 2 + suitesLength
  const compressionLength = record[cursor] ?? 0
  cursor += 1 + compressionLength
  const extensionsLength = (record[cursor] ?? 0) * 256 + (record[cursor + 1] ?? 0)
  cursor += 2
  const extensionsEnd = cursor + extensionsLength
  if (extensionsEnd !== record.length) throw new Error('malformed ClientHello extensions')
  while (cursor < extensionsEnd) {
    const kind = (record[cursor] ?? 0) * 256 + (record[cursor + 1] ?? 0)
    const length = (record[cursor + 2] ?? 0) * 256 + (record[cursor + 3] ?? 0)
    cursor += 4
    const end = cursor + length
    if (end > extensionsEnd) throw new Error('truncated ClientHello extension')
    if (kind === 0) {
      if (length < 5 || record[cursor + 2] !== 0) throw new Error('malformed SNI extension')
      const nameLength = (record[cursor + 3] ?? 0) * 256 + (record[cursor + 4] ?? 0)
      if (nameLength + 5 !== length) throw new Error('malformed SNI name')
      return Buffer.from(record.subarray(cursor + 5, end))
    }
    cursor = end
  }
  return undefined
}

if (clientHelloSni(wrongNameClientHello)?.toString('ascii') !== 'wrong.example') {
  throw new Error('wrong-name ClientHello does not contain exact wrong.example SNI')
}
if (clientHelloSni(ipClientHello) !== undefined) {
  throw new Error('IP ClientHello unexpectedly contains an SNI extension')
}

const replaceHandshake = (
  messages: Buffer,
  kind: number,
  replacement: (message: Buffer) => Buffer,
): Buffer => {
  const range = handshakeRanges(messages).find((candidate) => candidate.kind === kind)
  if (range === undefined) throw new Error(`missing handshake ${kind}`)
  return Buffer.concat([
    messages.subarray(0, range.start),
    replacement(messages.subarray(range.start, range.end)),
    messages.subarray(range.end),
  ])
}

const flipHandshakeByte = (id: string, suite: Suite, flight: Uint8Array, kind: number): Buffer =>
  mutateHandshakeFlight(id, suite, flight, (messages) =>
    replaceHandshake(messages, kind, (message) => {
      const changed = Buffer.from(message)
      changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1
      return changed
    }),
  )

const badCertificateDerFlight = mutateHandshakeFlight(
  'rsa-x25519',
  'chacha',
  serverFlight,
  (messages) =>
    replaceHandshake(messages, 11, (message) => {
      const changed = Buffer.from(message)
      const contextLength = changed[4] ?? 0
      const certificateDer = 4 + 1 + contextLength + 3 + 3
      changed[certificateDer] = 0
      return changed
    }),
)
const badCertificateVerifyFlight = flipHandshakeByte('rsa-x25519', 'chacha', serverFlight, 15)
const badFinishedFlight = flipHandshakeByte('rsa-x25519', 'chacha', serverFlight, 20)
const unsolicitedExtensionFlight = mutateHandshakeFlight(
  'rsa-x25519',
  'chacha',
  serverFlight,
  (messages) =>
    replaceHandshake(messages, 8, (message) => {
      const changed = Buffer.from(message)
      changed[changed.length - 1] = 1
      return changed
    }),
)

const mutateCertificateRequest = (mutate: (message: Buffer) => Buffer): Buffer =>
  mutateHandshakeFlight('ecdsa-x25519-aes128', 'aes128', aes128ServerFlight, (messages) =>
    replaceHandshake(messages, 13, mutate),
  )
// Keep every malformed CertificateRequest the same size as the valid rustls message. Besides
// producing sharper parser regressions, this lets the native corpus encode each authenticated
// mutation as a sparse ciphertext/tag patch instead of embedding another full server flight.
const missingSignatureAlgorithmsFlight = mutateCertificateRequest((message) => {
  const changed = Buffer.from(message)
  changed[7] = 0
  changed[8] = 50
  return changed
})
const oddSignatureAlgorithmsFlight = mutateCertificateRequest((message) => {
  const changed = Buffer.from(message)
  changed[11] = 0
  changed[12] = 17
  return changed
})
const malformedAuthoritiesFlight = mutateCertificateRequest((message) => {
  const changed = Buffer.from(message)
  changed[37] = 0
  changed[38] = 51
  return changed
})
const duplicateRequestExtensionFlight = mutateCertificateRequest((message) => {
  const changed = Buffer.from(message)
  changed[31] = 0
  changed[32] = 13
  return changed
})
const unsolicitedRequestExtensionFlight = mutateCertificateRequest((message) => {
  const changed = Buffer.from(message)
  changed[31] = 0
  changed[32] = 51
  return changed
})

const encodedExtension = (kind: number, body: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from([kind >> 8, kind & 0xff, body.length >> 8, body.length & 0xff]), body])

const appendCertificateRequestExtensions = (
  message: Buffer,
  extensions: ReadonlyArray<readonly [number, Uint8Array]>,
): Buffer => {
  const existingLength = (message[5] ?? 0) * 256 + (message[6] ?? 0)
  if (existingLength + 7 !== message.length) throw new Error('malformed CertificateRequest')
  const appended = Buffer.concat(extensions.map(([kind, body]) => encodedExtension(kind, body)))
  const combined = Buffer.concat([message.subarray(7), appended])
  return handshakeMessage(
    13,
    Buffer.concat([
      message.subarray(4, 5),
      Buffer.from([combined.length >> 8, combined.length & 0xff]),
      combined,
    ]),
  )
}

const certificateRequestPrefix = (
  extensions: ReadonlyArray<readonly [number, Uint8Array]>,
): Buffer => {
  const flight = mutateCertificateRequest((message) =>
    appendCertificateRequestExtensions(message, extensions),
  )
  const ranges = recordRanges(flight)
  const protectedHandshake = ranges.find((range) => range.contentType === 23)
  if (protectedHandshake === undefined) throw new Error('missing CertificateRequest prefix record')
  const secret = keyLogSecret('ecdsa-x25519-aes128', 'SERVER_HANDSHAKE_TRAFFIC_SECRET')
  const plaintext = unprotectRecord(
    flight.subarray(protectedHandshake.start, protectedHandshake.end),
    secret,
    'aes128',
    0,
  )
  const messages = plaintext.subarray(0, -1)
  const request = handshakeRanges(messages).find((range) => range.kind === 13)
  if (request === undefined) throw new Error('missing mutated CertificateRequest')
  const prefix = messages.subarray(0, request.end)
  return Buffer.concat([
    flight.subarray(0, protectedHandshake.start),
    protectRecord(prefix, 22, secret, 'aes128', 0),
  ])
}

const validOptionalRequestPrefix = certificateRequestPrefix([
  [5, Buffer.alloc(0)],
  [18, Buffer.alloc(0)],
  [48, Buffer.from([0, 4, 1, 42, 0, 0])],
])
const validUnknownRequestPrefix = certificateRequestPrefix([[65000, Buffer.from([1, 2, 3])]])
const duplicateUnknownRequestPrefix = certificateRequestPrefix([
  [65000, Buffer.from([1])],
  [65000, Buffer.from([2])],
])
const malformedStatusRequestPrefix = certificateRequestPrefix([[5, Buffer.from([0])]])
const malformedSctRequestPrefix = certificateRequestPrefix([[18, Buffer.from([0])]])
const malformedOidFiltersPrefix = certificateRequestPrefix([[48, Buffer.from([0, 1, 0])]])
const illegalKeyShareRequestPrefix = certificateRequestPrefix([[51, Buffer.alloc(0)]])

const certificateRequestExtensionEntries = (
  flight: Uint8Array,
): ReadonlyArray<readonly [number, Buffer]> => {
  const protectedHandshake = recordRanges(flight).find((range) => range.contentType === 23)
  if (protectedHandshake === undefined) throw new Error('missing CertificateRequest record')
  const plaintext = unprotectRecord(
    flight.subarray(protectedHandshake.start, protectedHandshake.end),
    keyLogSecret('ecdsa-x25519-aes128', 'SERVER_HANDSHAKE_TRAFFIC_SECRET'),
    'aes128',
    0,
  )
  const messages = plaintext.subarray(0, -1)
  const range = handshakeRanges(messages).find((candidate) => candidate.kind === 13)
  if (range === undefined) throw new Error('missing CertificateRequest message')
  const request = messages.subarray(range.start, range.end)
  const extensionsLength = (request[5] ?? 0) * 256 + (request[6] ?? 0)
  if (extensionsLength + 7 !== request.length) throw new Error('malformed CertificateRequest')
  const entries: Array<readonly [number, Buffer]> = []
  let cursor = 7
  while (cursor < request.length) {
    const kind = (request[cursor] ?? 0) * 256 + (request[cursor + 1] ?? 0)
    const length = (request[cursor + 2] ?? 0) * 256 + (request[cursor + 3] ?? 0)
    cursor += 4
    const end = cursor + length
    if (end > request.length) throw new Error('truncated CertificateRequest extension')
    entries.push([kind, Buffer.from(request.subarray(cursor, end))])
    cursor = end
  }
  return entries
}

const optionalRequestEntries = certificateRequestExtensionEntries(validOptionalRequestPrefix)
for (const kind of [5, 18]) {
  const entry = optionalRequestEntries.find(([candidate]) => candidate === kind)
  if (entry === undefined || entry[1].length !== 0) {
    throw new Error(`CertificateRequest extension ${kind} is not empty`)
  }
}
if (!optionalRequestEntries.some(([kind, body]) => kind === 48 && body.length === 6)) {
  throw new Error('CertificateRequest oid_filters fixture is absent or malformed')
}
if (
  certificateRequestExtensionEntries(validUnknownRequestPrefix).filter(([kind]) => kind === 65000)
    .length !== 1 ||
  certificateRequestExtensionEntries(duplicateUnknownRequestPrefix).filter(
    ([kind]) => kind === 65000,
  ).length !== 2
) {
  throw new Error('CertificateRequest unknown-extension fixture identity is wrong')
}

const invalidCcs = Buffer.from([20, 3, 3, 0, 1, 2])
const validCcs = Buffer.from([20, 3, 3, 0, 1, 1])
const applicationSecret = (id: string): Buffer => keyLogSecret(id, 'SERVER_TRAFFIC_SECRET_0')
const clientApplicationSecret = (id: string): Buffer => keyLogSecret(id, 'CLIENT_TRAFFIC_SECRET_0')
const postHandshakeRecord = (id: string, suite: Suite, body: Uint8Array, sequence = 1): Buffer =>
  protectRecord(body, 22, applicationSecret(id), suite, sequence)
/** Encrypts an application record for the committed RSA peer's test-only traffic secret. */
export const tlsClientRsaApplicationRecord = (plaintext: Uint8Array, sequence = 0): Uint8Array =>
  protectRecord(plaintext, 23, applicationSecret('rsa-x25519'), 'chacha', sequence)

export const tlsClientRsaApplicationWrite = protectRecord(
  Buffer.from('ping'),
  23,
  keyLogSecret('rsa-x25519', 'CLIENT_TRAFFIC_SECRET_0'),
  'chacha',
  0,
)
export const tlsClientRsaServerCloseNotify = protectRecord(
  Buffer.from([1, 0]),
  21,
  applicationSecret('rsa-x25519'),
  'chacha',
  1,
)
const malformedTicketRecord = postHandshakeRecord(
  'rsa-x25519',
  'chacha',
  handshakeMessage(
    4,
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 1, 0, 1, 1, 0, 4, 0, 42, 0, 3]),
  ),
)
const duplicateTicketExtensionRecord = postHandshakeRecord(
  'rsa-x25519',
  'chacha',
  handshakeMessage(
    4,
    Buffer.from([
      0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 1, 0, 1, 1, 0, 16, 0, 42, 0, 4, 0, 0, 0, 0, 0, 42, 0, 4, 0,
      0, 0, 0,
    ]),
  ),
)
const peerKeyUpdateRecord = postHandshakeRecord(
  'rsa-x25519',
  'chacha',
  handshakeMessage(24, Buffer.from([1])),
)
const malformedKeyUpdateRecord = postHandshakeRecord(
  'rsa-x25519',
  'chacha',
  handshakeMessage(24, Buffer.from([2])),
)
const fatalAlertRecord = protectRecord(
  Buffer.from([2, 40]),
  21,
  applicationSecret('rsa-x25519'),
  'chacha',
  1,
)
const closeNotifyRecord = protectRecord(
  Buffer.from([1, 0]),
  21,
  applicationSecret('rsa-x25519'),
  'chacha',
  1,
)
const userCanceledRecord = protectRecord(
  Buffer.from([1, 90]),
  21,
  applicationSecret('rsa-x25519'),
  'chacha',
  1,
)
const postHandshakeCertificateRequestRecord = postHandshakeRecord(
  'rsa-x25519',
  'chacha',
  handshakeMessage(13, Buffer.from([0, 0, 0])),
)
const validTicketMessage = handshakeMessage(
  4,
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 1, 0, 0]),
)
const validTicketBody = validTicketMessage.subarray(4)
const validTicketNonceLength = validTicketBody[8]
if (validTicketNonceLength === undefined) throw new Error('missing NewSessionTicket nonce length')
const validTicketLengthOffset = 9 + validTicketNonceLength
const validTicketLength = validTicketBody.readUInt16BE(validTicketLengthOffset)
const validTicketExtensionsOffset = validTicketLengthOffset + 2 + validTicketLength
const validTicketExtensionsLength = validTicketBody.readUInt16BE(validTicketExtensionsOffset)
if (
  validTicketLength === 0 ||
  validTicketExtensionsOffset + 2 + validTicketExtensionsLength !== validTicketBody.length
) {
  throw new Error('malformed valid NewSessionTicket fixture')
}
const coalescedTicketKeyUpdateRecord = postHandshakeRecord(
  'rsa-x25519',
  'chacha',
  Buffer.concat([validTicketMessage, handshakeMessage(24, Buffer.from([1]))]),
)
const validTicketRecord1 = postHandshakeRecord('rsa-x25519', 'chacha', validTicketMessage, 1)
const validTicketRecord2 = postHandshakeRecord('rsa-x25519', 'chacha', validTicketMessage, 2)

const serverHelloRange = recordRanges(serverFlight)[0]
if (serverHelloRange === undefined || serverHelloRange.contentType !== 22) {
  throw new Error('missing plaintext ServerHello record')
}
const rsaProtectedHandshakeRange = recordRanges(serverFlight).find(
  (range) => range.contentType === 23,
)
if (rsaProtectedHandshakeRange === undefined) throw new Error('missing protected RSA handshake')
const rsaProtectedHandshake = unprotectRecord(
  serverFlight.subarray(rsaProtectedHandshakeRange.start, rsaProtectedHandshakeRange.end),
  keyLogSecret('rsa-x25519', 'SERVER_HANDSHAKE_TRAFFIC_SECRET'),
  'chacha',
  0,
)
if (rsaProtectedHandshake.at(-1) !== 22) throw new Error('wrong RSA handshake inner type')
const rsaInitialHandshake = Buffer.concat([
  serverFlight.subarray(serverHelloRange.start + 5, serverHelloRange.end),
  rsaProtectedHandshake.subarray(0, -1),
])
const rsaHandshakeRanges = handshakeRanges(rsaInitialHandshake)
export const tlsClientFragmentationKinds = Object.freeze({
  initialFlight: rsaHandshakeRanges.map((range) => range.kind),
  keyUpdate: handshakeRanges(handshakeMessage(24, Buffer.from([2]))).map((range) => range.kind),
})
const rsaHandshakeBytes = rsaInitialHandshake.length
const rsaHandshakeMessages = rsaHandshakeRanges.length
const rsaHandshakeBodyBytes = Math.max(
  ...rsaHandshakeRanges.map((range) => range.end - range.start - 4),
)
// Keep the exact incoming body boundary compatible with Client.make's worst-case
// retry ClientHello: 161 fixed bytes + 11 DNS bytes + 9 DNS framing + 6 cookie framing.
const rsaExactBoundaryCookieBytes = rsaHandshakeBodyBytes - (161 + 11 + 9 + 6)
const rsaCertificateBytes = Math.max(...capturedRsaChain.map((certificate) => certificate.length))
const rsaCertificateTotalBytes = capturedRsaChain.reduce(
  (total, certificate) => total + certificate.length,
  0,
)
const rsaExtensionBytes = (() => {
  const lengths: Array<number> = []
  for (const range of rsaHandshakeRanges) {
    const message = rsaInitialHandshake.subarray(range.start, range.end)
    if (range.kind === 2) {
      lengths.push((message[42] ?? 0) * 256 + (message[43] ?? 0))
    } else if (range.kind === 8) {
      lengths.push((message[4] ?? 0) * 256 + (message[5] ?? 0))
    } else if (range.kind === 11) {
      const contextLength = message[4] ?? 0
      let cursor = 5 + contextLength + 3
      while (cursor < message.length) {
        const derLength =
          (message[cursor] ?? 0) * 65_536 +
          (message[cursor + 1] ?? 0) * 256 +
          (message[cursor + 2] ?? 0)
        cursor += 3 + derLength
        const extensionLength = (message[cursor] ?? 0) * 256 + (message[cursor + 1] ?? 0)
        lengths.push(extensionLength)
        cursor += 2 + extensionLength
      }
      if (cursor !== message.length) throw new Error('malformed RSA Certificate extensions')
    }
  }
  return Math.max(...lengths)
})()
const mutateServerHello = (record: Uint8Array, mutate: (message: Buffer) => Buffer): Buffer => {
  const range = recordRanges(record)[0]
  if (range === undefined || range.contentType !== 22) throw new Error('missing ServerHello')
  const changed = mutate(Buffer.from(record.subarray(range.start + 5, range.end)))
  const header = Buffer.from(record.subarray(range.start, range.start + 5))
  header[3] = changed.length >> 8
  header[4] = changed.length & 0xff
  return Buffer.concat([header, changed, record.subarray(range.end)])
}
const emptyCookieRetry = mutateServerHello(aes256ServerRetry, (message) => {
  const cookie = Buffer.from([0, 44, 0, 2, 0, 0])
  const changed = Buffer.concat([message, cookie])
  const bodyLength = changed.length - 4
  changed[1] = bodyLength >> 16
  changed[2] = (bodyLength >> 8) & 0xff
  changed[3] = bodyLength & 0xff
  const extensionsLength = (changed[42] ?? 0) * 256 + (changed[43] ?? 0) + cookie.length
  changed[42] = extensionsLength >> 8
  changed[43] = extensionsLength & 0xff
  return changed
})

export const tlsClientEmptyCookieRetry = Uint8Array.from(emptyCookieRetry)

const serverHelloKeyShareOffset = (message: Uint8Array): number => {
  let cursor = 44
  while (cursor < message.length) {
    const kind = (message[cursor] ?? 0) * 256 + (message[cursor + 1] ?? 0)
    const length = (message[cursor + 2] ?? 0) * 256 + (message[cursor + 3] ?? 0)
    if (kind === 51) return cursor + 4
    cursor += 4 + length
  }
  throw new Error('missing ServerHello key_share')
}
const coalescedServerHelloFlight = mutateServerHello(serverFlight, (message) =>
  Buffer.concat([message, handshakeMessage(8, Buffer.from([0, 0]))]),
)
const invalidKeyShareFlight = mutateServerHello(serverFlight, (message) => {
  const changed = Buffer.from(message)
  const share = serverHelloKeyShareOffset(changed)
  const keyLength = (changed[share + 2] ?? 0) * 256 + (changed[share + 3] ?? 0)
  changed.fill(0, share + 4, share + 4 + keyLength)
  return changed
})
const mismatchedKeyShareFlight = mutateServerHello(serverFlight, (message) => {
  const changed = Buffer.from(message)
  const share = serverHelloKeyShareOffset(changed)
  changed[share] = 0
  changed[share + 1] = 23
  return changed
})
const unsupportedGroupFlight = mutateServerHello(serverFlight, (message) => {
  const changed = Buffer.from(message)
  const share = serverHelloKeyShareOffset(changed)
  changed[share] = 0x99
  changed[share + 1] = 0x99
  return changed
})
const unsupportedSuiteFlight = mutateServerHello(serverFlight, (message) => {
  const changed = Buffer.from(message)
  changed[39] = 0x13
  changed[40] = 0x04
  return changed
})
const alreadyOfferedGroupRetry = mutateServerHello(aes256ServerRetry, (message) => {
  const changed = Buffer.from(message)
  const share = serverHelloKeyShareOffset(changed)
  changed[share] = 0
  changed[share + 1] = 29
  return changed
})
const cookieRetry = mutateServerHello(aes256ServerRetry, (message) => {
  const cookie = Buffer.from([0, 44, 0, 4, 0, 2, 1, 2])
  const changed = Buffer.concat([message, cookie])
  const bodyLength = changed.length - 4
  changed[1] = bodyLength >> 16
  changed[2] = (bodyLength >> 8) & 0xff
  changed[3] = bodyLength & 0xff
  const extensionsLength = (changed[42] ?? 0) * 256 + (changed[43] ?? 0) + cookie.length
  changed[42] = extensionsLength >> 8
  changed[43] = extensionsLength & 0xff
  return changed
})
const cookieClientRetry = (() => {
  const message = Buffer.from(aes256ClientRetry.subarray(5))
  let extensionsLengthOffset = 4 + 2 + 32
  extensionsLengthOffset += 1 + (message[extensionsLengthOffset] ?? 0)
  const suitesLength =
    (message[extensionsLengthOffset] ?? 0) * 256 + (message[extensionsLengthOffset + 1] ?? 0)
  extensionsLengthOffset += 2 + suitesLength
  extensionsLengthOffset += 1 + (message[extensionsLengthOffset] ?? 0)
  const extensionsLength =
    (message[extensionsLengthOffset] ?? 0) * 256 + (message[extensionsLengthOffset + 1] ?? 0)
  const extensionsEnd = extensionsLengthOffset + 2 + extensionsLength
  if (extensionsEnd !== message.length) throw new Error('malformed retry ClientHello extensions')
  const cookieExtension = Buffer.from([0, 44, 0, 4, 0, 2, 1, 2])
  const changed = Buffer.concat([message, cookieExtension])
  const bodyLength = changed.length - 4
  changed[1] = bodyLength >> 16
  changed[2] = (bodyLength >> 8) & 0xff
  changed[3] = bodyLength & 0xff
  const changedExtensionsLength = extensionsLength + cookieExtension.length
  changed[extensionsLengthOffset] = changedExtensionsLength >> 8
  changed[extensionsLengthOffset + 1] = changedExtensionsLength & 0xff
  const header = Buffer.from(aes256ClientRetry.subarray(0, 5))
  header[3] = changed.length >> 8
  header[4] = changed.length & 0xff
  return Buffer.concat([header, changed])
})()
const changedSuiteAfterRetryFlight = mutateServerHello(aes256ServerFlight, (message) => {
  const changed = Buffer.from(message)
  changed[39] = 0x13
  changed[40] = 0x01
  return changed
})
const mutateEncryptedExtensions = (mutate: (body: Buffer) => Buffer): Buffer =>
  mutateHandshakeFlight('ecdsa-x25519-aes128', 'aes128', aes128ServerFlight, (messages) =>
    replaceHandshake(messages, 8, (message) => {
      const changedBody = mutate(Buffer.from(message.subarray(4)))
      return handshakeMessage(8, changedBody)
    }),
  )
const duplicateAlpnExtensionFlight = mutateEncryptedExtensions((body) => {
  const extensionLength = (body[0] ?? 0) * 256 + (body[1] ?? 0)
  const extension = body.subarray(2, 2 + extensionLength)
  const result = Buffer.concat([Buffer.alloc(2), extension, extension])
  const length = extension.length * 2
  result[0] = length >> 8
  result[1] = length & 0xff
  return result
})
const unofferedAlpnFlight = mutateEncryptedExtensions((body) => {
  const changed = Buffer.from(body)
  const h2 = changed.indexOf(Buffer.from('h2'))
  if (h2 < 0) throw new Error('missing selected h2')
  changed[h2 + 1] = '3'.charCodeAt(0)
  return changed
})
const malformedAlpnFlight = mutateEncryptedExtensions((body) => {
  const changed = Buffer.from(body)
  const h2 = changed.indexOf(Buffer.from('h2'))
  if (h2 < 1) throw new Error('missing selected h2 length')
  changed[h2 - 1] = 3
  return changed
})

const rsaClientSecret = clientApplicationSecret('rsa-x25519')
const expectedApplicationRecord = protectRecord(
  Buffer.from('queued-before-update'),
  23,
  rsaClientSecret,
  'chacha',
  0,
)
const expectedKeyUpdateRecord = protectRecord(
  handshakeMessage(24, Buffer.from([1])),
  22,
  rsaClientSecret,
  'chacha',
  1,
)
const expectedInitialKeyUpdateRecord = protectRecord(
  handshakeMessage(24, Buffer.from([1])),
  22,
  rsaClientSecret,
  'chacha',
  0,
)
const expectedInitialPeerKeyUpdateResponseRecord = protectRecord(
  handshakeMessage(24, Buffer.from([0])),
  22,
  rsaClientSecret,
  'chacha',
  0,
)
const expectedPeerKeyUpdateResponseRecord = protectRecord(
  handshakeMessage(24, Buffer.from([0])),
  22,
  rsaClientSecret,
  'chacha',
  1,
)
const expectedCloseNotifyRecord = protectRecord(
  Buffer.from([1, 0]),
  21,
  rsaClientSecret,
  'chacha',
  0,
)
const expectedCloseAfterApplicationRecord = protectRecord(
  Buffer.from([1, 0]),
  21,
  rsaClientSecret,
  'chacha',
  1,
)

const aes128HandshakeSecret = keyLogSecret('ecdsa-x25519-aes128', 'CLIENT_HANDSHAKE_TRAFFIC_SECRET')
const aes128Ranges = recordRanges(aes128ServerFlight)
const aes128ServerHelloRange = aes128Ranges.find((range) => range.contentType === 22)
const aes128ProtectedRange = aes128Ranges.find((range) => range.contentType === 23)
if (aes128ServerHelloRange === undefined || aes128ProtectedRange === undefined) {
  throw new Error('missing AES-128 handshake records')
}
const aes128ServerMessagesWithType = unprotectRecord(
  aes128ServerFlight.subarray(aes128ProtectedRange.start, aes128ProtectedRange.end),
  keyLogSecret('ecdsa-x25519-aes128', 'SERVER_HANDSHAKE_TRAFFIC_SECRET'),
  'aes128',
  0,
)
if (aes128ServerMessagesWithType.at(-1) !== 22) throw new Error('wrong AES-128 inner type')
const emptyClientCertificate = handshakeMessage(11, Buffer.from([0, 0, 0, 0]))
const clientFinishedTranscript = createHash('sha256')
  .update(aes128ClientHello.subarray(5))
  .update(aes128ServerFlight.subarray(aes128ServerHelloRange.start + 5, aes128ServerHelloRange.end))
  .update(aes128ServerMessagesWithType.subarray(0, -1))
  .update(emptyClientCertificate)
  .digest()
const clientFinishedKey = expandLabel(aes128HandshakeSecret, 'finished', 32, 'aes128')
const clientFinishedMessage = handshakeMessage(
  20,
  createHmac('sha256', clientFinishedKey).update(clientFinishedTranscript).digest(),
)
const expectedEmptyCertificateRecord = protectRecord(
  emptyClientCertificate,
  22,
  aes128HandshakeSecret,
  'aes128',
  0,
)
const expectedClientFinishedRecord = protectRecord(
  clientFinishedMessage,
  22,
  aes128HandshakeSecret,
  'aes128',
  1,
)
const serverHelloExtensionLength = (serverFlight[5 + 42] ?? 0) * 256 + (serverFlight[5 + 43] ?? 0)
const retryCookieLength = 2
const badTagFlight = Buffer.from(serverFlight)
badTagFlight[badTagFlight.length - 1] = (badTagFlight.at(-1) ?? 0) ^ 1

const nativeFixtureIds = {
  rootPem: 0,
  clientHello: 1,
  serverFlight: 2,
  aes128ClientHello: 3,
  aes128ServerFlight: 4,
  aes128NoAlpnServerFlight: 5,
  aes256ClientHello: 6,
  aes256ClientRetry: 7,
  aes256ServerRetry: 8,
  aes256ServerFlight: 9,
  badCertificateDerFlight: 10,
  badCertificateVerifyFlight: 11,
  badFinishedFlight: 12,
  unsolicitedExtensionFlight: 13,
  missingSignatureAlgorithmsFlight: 14,
  oddSignatureAlgorithmsFlight: 15,
  malformedAuthoritiesFlight: 16,
  duplicateRequestExtensionFlight: 17,
  unsolicitedRequestExtensionFlight: 18,
  emptyCookieRetry: 19,
  invalidCcs: 20,
  badTagFlight: 21,
  malformedTicketRecord: 22,
  duplicateTicketExtensionRecord: 23,
  peerKeyUpdateRecord: 24,
  fatalAlertRecord: 25,
  validCcs: 26,
  wrongNameClientHello: 27,
  wrongNameServerFlight: 28,
  ipClientHello: 29,
  ipServerFlight: 30,
  closeNotifyRecord: 31,
  userCanceledRecord: 32,
  postHandshakeCertificateRequestRecord: 33,
  validTicketRecord1: 34,
  validTicketRecord2: 35,
  coalescedServerHelloFlight: 36,
  invalidKeyShareFlight: 37,
  mismatchedKeyShareFlight: 38,
  alreadyOfferedGroupRetry: 39,
  changedSuiteAfterRetryFlight: 40,
  duplicateAlpnExtensionFlight: 41,
  unofferedAlpnFlight: 42,
  expectedApplicationRecord: 43,
  expectedKeyUpdateRecord: 44,
  expectedCloseNotifyRecord: 45,
  expectedEmptyCertificateRecord: 46,
  expectedClientFinishedRecord: 47,
  expectedPeerKeyUpdateResponseRecord: 48,
  expectedInitialKeyUpdateRecord: 49,
  expectedCloseAfterApplicationRecord: 50,
  cookieRetry: 51,
  cookieClientRetry: 52,
  malformedKeyUpdateRecord: 53,
  unsupportedGroupFlight: 54,
  unsupportedSuiteFlight: 55,
  alpnBoundaryBytes: 56,
  malformedAlpnFlight: 57,
  validOptionalRequestPrefix: 58,
  validUnknownRequestPrefix: 59,
  duplicateUnknownRequestPrefix: 60,
  malformedStatusRequestPrefix: 61,
  malformedSctRequestPrefix: 62,
  malformedOidFiltersPrefix: 63,
  illegalKeyShareRequestPrefix: 64,
  coalescedTicketKeyUpdateRecord: 65,
  expectedInitialPeerKeyUpdateResponseRecord: 66,
} as const

const nativeFixtures: ReadonlyArray<readonly [number, Uint8Array]> = [
  [nativeFixtureIds.rootPem, rootPem],
  [nativeFixtureIds.clientHello, clientHello],
  [nativeFixtureIds.serverFlight, serverFlight],
  [nativeFixtureIds.aes128ClientHello, aes128ClientHello],
  [nativeFixtureIds.aes128ServerFlight, aes128ServerFlight],
  [nativeFixtureIds.aes128NoAlpnServerFlight, aes128NoAlpnServerFlight],
  [nativeFixtureIds.aes256ClientHello, aes256ClientHello],
  [nativeFixtureIds.aes256ClientRetry, aes256ClientRetry],
  [nativeFixtureIds.aes256ServerRetry, aes256ServerRetry],
  [nativeFixtureIds.aes256ServerFlight, aes256ServerFlight],
  [nativeFixtureIds.badCertificateDerFlight, badCertificateDerFlight],
  [nativeFixtureIds.badCertificateVerifyFlight, badCertificateVerifyFlight],
  [nativeFixtureIds.badFinishedFlight, badFinishedFlight],
  [nativeFixtureIds.unsolicitedExtensionFlight, unsolicitedExtensionFlight],
  [nativeFixtureIds.missingSignatureAlgorithmsFlight, missingSignatureAlgorithmsFlight],
  [nativeFixtureIds.oddSignatureAlgorithmsFlight, oddSignatureAlgorithmsFlight],
  [nativeFixtureIds.malformedAuthoritiesFlight, malformedAuthoritiesFlight],
  [nativeFixtureIds.duplicateRequestExtensionFlight, duplicateRequestExtensionFlight],
  [nativeFixtureIds.unsolicitedRequestExtensionFlight, unsolicitedRequestExtensionFlight],
  [nativeFixtureIds.emptyCookieRetry, emptyCookieRetry],
  [nativeFixtureIds.invalidCcs, invalidCcs],
  [nativeFixtureIds.badTagFlight, badTagFlight],
  [nativeFixtureIds.malformedTicketRecord, malformedTicketRecord],
  [nativeFixtureIds.duplicateTicketExtensionRecord, duplicateTicketExtensionRecord],
  [nativeFixtureIds.peerKeyUpdateRecord, peerKeyUpdateRecord],
  [nativeFixtureIds.fatalAlertRecord, fatalAlertRecord],
  [nativeFixtureIds.validCcs, validCcs],
  [nativeFixtureIds.wrongNameClientHello, wrongNameClientHello],
  [nativeFixtureIds.wrongNameServerFlight, wrongNameServerFlight],
  [nativeFixtureIds.ipClientHello, ipClientHello],
  [nativeFixtureIds.ipServerFlight, ipServerFlight],
  [nativeFixtureIds.closeNotifyRecord, closeNotifyRecord],
  [nativeFixtureIds.userCanceledRecord, userCanceledRecord],
  [nativeFixtureIds.postHandshakeCertificateRequestRecord, postHandshakeCertificateRequestRecord],
  [nativeFixtureIds.validTicketRecord1, validTicketRecord1],
  [nativeFixtureIds.validTicketRecord2, validTicketRecord2],
  [nativeFixtureIds.coalescedServerHelloFlight, coalescedServerHelloFlight],
  [nativeFixtureIds.invalidKeyShareFlight, invalidKeyShareFlight],
  [nativeFixtureIds.mismatchedKeyShareFlight, mismatchedKeyShareFlight],
  [nativeFixtureIds.alreadyOfferedGroupRetry, alreadyOfferedGroupRetry],
  [nativeFixtureIds.changedSuiteAfterRetryFlight, changedSuiteAfterRetryFlight],
  [nativeFixtureIds.duplicateAlpnExtensionFlight, duplicateAlpnExtensionFlight],
  [nativeFixtureIds.unofferedAlpnFlight, unofferedAlpnFlight],
  [nativeFixtureIds.expectedApplicationRecord, expectedApplicationRecord],
  [nativeFixtureIds.expectedKeyUpdateRecord, expectedKeyUpdateRecord],
  [nativeFixtureIds.expectedCloseNotifyRecord, expectedCloseNotifyRecord],
  [nativeFixtureIds.expectedEmptyCertificateRecord, expectedEmptyCertificateRecord],
  [nativeFixtureIds.expectedClientFinishedRecord, expectedClientFinishedRecord],
  [nativeFixtureIds.expectedPeerKeyUpdateResponseRecord, expectedPeerKeyUpdateResponseRecord],
  [nativeFixtureIds.expectedInitialKeyUpdateRecord, expectedInitialKeyUpdateRecord],
  [nativeFixtureIds.expectedCloseAfterApplicationRecord, expectedCloseAfterApplicationRecord],
  [nativeFixtureIds.cookieRetry, cookieRetry],
  [nativeFixtureIds.cookieClientRetry, cookieClientRetry],
  [nativeFixtureIds.malformedKeyUpdateRecord, malformedKeyUpdateRecord],
  [nativeFixtureIds.unsupportedGroupFlight, unsupportedGroupFlight],
  [nativeFixtureIds.unsupportedSuiteFlight, unsupportedSuiteFlight],
  [nativeFixtureIds.alpnBoundaryBytes, alpnBoundaryBytes],
  [nativeFixtureIds.malformedAlpnFlight, malformedAlpnFlight],
  [nativeFixtureIds.validOptionalRequestPrefix, validOptionalRequestPrefix],
  [nativeFixtureIds.validUnknownRequestPrefix, validUnknownRequestPrefix],
  [nativeFixtureIds.duplicateUnknownRequestPrefix, duplicateUnknownRequestPrefix],
  [nativeFixtureIds.malformedStatusRequestPrefix, malformedStatusRequestPrefix],
  [nativeFixtureIds.malformedSctRequestPrefix, malformedSctRequestPrefix],
  [nativeFixtureIds.malformedOidFiltersPrefix, malformedOidFiltersPrefix],
  [nativeFixtureIds.illegalKeyShareRequestPrefix, illegalKeyShareRequestPrefix],
  [nativeFixtureIds.coalescedTicketKeyUpdateRecord, coalescedTicketKeyUpdateRecord],
  [
    nativeFixtureIds.expectedInitialPeerKeyUpdateResponseRecord,
    expectedInitialPeerKeyUpdateResponseRecord,
  ],
]

const cBytes = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => `0x${byte.toString(16).padStart(2, '0')}`).join(',')

/** Data-only native carrier. Silk remains the TLS oracle and verifies every copied length. */
export const tlsClientNativeFixtureSource = `#include <stddef.h>
#include <stdint.h>
#include <string.h>
${nativeFixtures
  .map(([id, bytes]) => `static const uint8_t fixture_${id}[] = {${cBytes(bytes)}};`)
  .join('\n')}

size_t silk_tls_fixture_size(int32_t id) {
  switch (id) {
${nativeFixtures.map(([id, bytes]) => `    case ${id}: return ${bytes.length};`).join('\n')}
    default: return 0;
  }
}

size_t silk_tls_fixture_copy(int32_t id, uint8_t *output, size_t capacity) {
  const uint8_t *source = NULL;
  size_t length = 0;
  switch (id) {
${nativeFixtures
  .map(([id, bytes]) => `    case ${id}: source = fixture_${id}; length = ${bytes.length}; break;`)
  .join('\n')}
    default: return 0;
  }
  if (output == NULL || capacity != length) return 0;
  memcpy(output, source, length);
  return length;
}
`

const tlsClientSourceTemplate = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.effect {Effect}
import silk.https_identity {HttpsIdentity, IdentityError, OriginHost, ReferenceIdentity}
import silk.layout {Layout}
import silk.random {Random}
import silk.result {Result}
import silk.option {Option}
import silk.slice {Slice}
import silk.system_clock {SystemClock}
import silk.tls_client {
  AlpnConfig,
  AlpnProtocol,
  Authentication,
  Client,
  ClientConfig,
  ClientLimits,
  ClientOperation,
  Demand,
  NamedGroup,
  Progress,
  ProtocolReason,
  TlsLimitKind,
  TlsError,
}
import silk.trust_anchor {TrustAnchor}
import silk.tls_record {CipherSuite}
import silk.trust_snapshot {SnapshotLimits, TrustLoadLimits, TrustSnapshot, TrustSourceError}
import silk.certificate_path {ValidationReason}
import silk.u8
import silk.usize
import silk.vector {Vector}

// Deterministic test double only. Production code must supply a CSPRNG implementation.
struct ScriptedRandom { filled: usize }

impl Random for ScriptedRandom {
  effect fn fillBytes(self: &mut Self, output: &mut [u8]) -> () {
    let mut index = usize.ZERO
    while index < output.length {
      output[index] = usize.toU8((self.filled + index + usize.ONE) % 251 + usize.ONE)
      index = index + usize.ONE
    }
    self.filled = self.filled + output.length
    return ()
  }
}

// TLS_CLIENT_NATIVE_EMPTY_TRUST_BEGIN
fn emptyTrust() -> TrustSnapshot {
  let made = TrustSnapshot.fromAnchors(
    Vector.make<TrustAnchor>(),
    SnapshotLimits {anchors: 0, encodedBytes: 0},
  )
  return match move made {
    Result<TrustSnapshot, TrustSourceError>.Success {value} => move value
    Result<TrustSnapshot, TrustSourceError>.Failure {error} => {
      let invalid = 1 / 0
      return emptyTrust()
    }
  }
}
// TLS_CLIENT_NATIVE_EMPTY_TRUST_END

// TLS_CLIENT_ROOT_TRUST_BEGIN
effect fn rootTrust() -> TrustSnapshot ! OutOfMemoryError ? &mut Allocator {
  let pem = ${silkBytes(rootPem)}
  let made = run TrustSnapshot.fromPem(pem, TrustLoadLimits.defaults())
  return match move made {
    Result<TrustSnapshot, TrustSourceError>.Success {value} => move value
    Result<TrustSnapshot, TrustSourceError>.Failure {error} => {
      let invalid = 1 / 0
      return run rootTrust()
    }
  }
}
// TLS_CLIENT_ROOT_TRUST_END

fn reference<'a>(bytes: &'a [u8]) -> ReferenceIdentity<'a> {
  let admitted = HttpsIdentity.reference(OriginHost<'a>.Dns {bytes: bytes})
  return match move admitted {
    Result<ReferenceIdentity<'a>, IdentityError>.Success {value} => value
    Result<ReferenceIdentity<'a>, IdentityError>.Failure {error} => {
      let invalid = 1 / 0
      return reference(bytes)
    }
  }
}

// TLS_CLIENT_NATIVE_HELPERS_BEGIN
fn hasBytes(haystack: &[u8], needle: &[u8]) -> bool {
  if needle.length > haystack.length { return false }
  let mut start = usize.ZERO
  while start <= haystack.length - needle.length {
    let mut equal = true
    let mut index = usize.ZERO
    while index < needle.length {
      if haystack[start + index] != needle[index] { equal = false }
      index = index + usize.ONE
    }
    if equal { return true }
    start = start + usize.ONE
  }
  return false
}

fn isNeedOutput(result: Result<Progress, TlsError>) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => value.demand == Demand.NeedOutput
    Result<Progress, TlsError>.Failure {error} => false
  }
}

fn isNeedInput(result: Result<Progress, TlsError>) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => value.demand == Demand.NeedInput
    Result<Progress, TlsError>.Failure {error} => false
  }
}

fn hasDemand(result: Result<Progress, TlsError>, expected: Demand) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => value.demand == expected
    Result<Progress, TlsError>.Failure {error} => false
  }
}

fn isPrematureWrite(result: Result<Progress, TlsError>) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => false
    Result<Progress, TlsError>.Failure {error} => match move error {
      TlsError.InvalidState {operation} => operation == ClientOperation.WritePlaintext
      _ => false
    }
  }
}

fn isPrematureRead(result: Result<Progress, TlsError>) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => false
    Result<Progress, TlsError>.Failure {error} => match move error {
      TlsError.InvalidState {operation} => operation == ClientOperation.ReadPlaintext
      _ => false
    }
  }
}

fn isTruncated(result: Result<Progress, TlsError>) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => false
    Result<Progress, TlsError>.Failure {error} => match move error {
      TlsError.Truncated => true
      _ => false
    }
  }
}

fn isFailureCode(result: Result<Progress, TlsError>, expected: i32) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => false
    Result<Progress, TlsError>.Failure {error} => feedFailureCode(move error) == expected
  }
}

fn isInvalidTime(result: Result<Client, TlsError>) -> bool {
  return match move result {
    Result<Client, TlsError>.Success {value} => false
    Result<Client, TlsError>.Failure {error} => match move error {
      TlsError.CertificatePath {error: pathError} => pathError.reason == ValidationReason.InvalidTime
      _ => false
    }
  }
}

fn validAes128Authentication<'a>(value: &Authentication<'a>) -> bool {
  let selected = value.selectedAlpn()
  return match move selected {
    Option.None => false
    Option.Some {value: selectedBytes} => selectedBytes.length == 2
      && selectedBytes[0] == 104
      && selectedBytes[1] == 50
      && value.suite() == CipherSuite.Aes128GcmSha256
      && value.group() == NamedGroup.X25519
  }
}

fn invalidLimit(result: Result<Client, TlsError>, expectedKind: TlsLimitKind, expected: usize) -> bool {
  return match move result {
    Result<Client, TlsError>.Success {value} => false
    Result<Client, TlsError>.Failure {error} => match move error {
      TlsError.LimitExceeded {kind, limit} => kind == expectedKind && limit == expected
      _ => false
    }
  }
}

fn exactPeerAlert(result: Result<Progress, TlsError>, expected: u8) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => false
    Result<Progress, TlsError>.Failure {error} => match move error {
      TlsError.PeerAlert {code} => code == expected
      _ => false
    }
  }
}

fn exactLimitFailure(
  result: Result<Progress, TlsError>,
  expectedKind: TlsLimitKind,
  expectedLimit: usize,
) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => false
    Result<Progress, TlsError>.Failure {error} => {
      return exactLimitError(move error, expectedKind, expectedLimit)
    }
  }
}

fn exactLimitError(
  error: TlsError,
  expectedKind: TlsLimitKind,
  expectedLimit: usize,
) -> bool {
  return match move error {
    TlsError.LimitExceeded {kind, limit} => kind == expectedKind && limit == expectedLimit
    _ => false
  }
}

fn sameBytes(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}
// TLS_CLIENT_NATIVE_HELPERS_END

fn protocolFailureCode(reason: ProtocolReason) -> i32 {
  return match reason {
    ProtocolReason.Record => 40
    ProtocolReason.UnexpectedMessage => 41
    ProtocolReason.InvalidLength => 42
    ProtocolReason.Extension => 43
    ProtocolReason.ServerHello => 44
    ProtocolReason.HelloRetryRequest => 45
    ProtocolReason.CompatibilityCcs => 46
    ProtocolReason.CertificateRequest => 47
    ProtocolReason.Certificate => 48
    ProtocolReason.PostHandshake => 49
    ProtocolReason.InternalState => 50
  }
}

fn feedFailureCode(error: TlsError) -> i32 {
  return match move error {
    TlsError.PeerAlert {code} => 30
    TlsError.BadRecordMac => 31
    TlsError.ProtocolViolation {reason} => protocolFailureCode(reason)
    TlsError.CertificateDecode {error: decodeError} => 51
    TlsError.CertificatePath {error: pathError} => 52
    TlsError.CertificateIdentity {error: identityError} => 53
    TlsError.CertificateVerify {error: verifyError} => 54
    TlsError.Finished => 55
    TlsError.UnsupportedProfile => 56
    TlsError.LimitExceeded {kind, limit} => 57
    TlsError.InvalidState {operation} => 58
    TlsError.EmptyBuffer => 59
    TlsError.HandshakeTruncated => 60
    TlsError.Truncated => 61
    TlsError.NoApplicationProtocol => 62
  }
}

fn alpnProtocol<'a>(bytes: &'a [u8]) -> AlpnProtocol<'a> {
  return AlpnProtocol<'a> {bytes: bytes}
}

// TLS_CLIENT_WASM_DEFAULTS_BEGIN
effect fn makeDefaultWithTrust(
  trust: TrustSnapshot,
  validationSeconds: i64,
) -> Result<Client, TlsError>
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let host = b"ExAmPlE.com"
  let config = ClientConfig {
    reference: reference(&host),
    alpn: AlpnConfig.defaults(),
    limits: ClientLimits.defaults(),
  }
  return run Client.make(&config, move trust, SystemClock.make(validationSeconds, 123456789))
}

effect fn makeDefaultClient() -> Result<Client, TlsError>
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let trust = run rootTrust()
  return run makeDefaultWithTrust(move trust, 1789156800)
}
// TLS_CLIENT_WASM_DEFAULTS_END

union FeedOutcome {
  Complete,
  Stalled,
  Failure { error: TlsError },
}

effect fn feedOutcome(
  client: &mut Client,
  input: &[u8],
  progressSteps: usize,
) -> FeedOutcome
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let mut offset = usize.ZERO
  while offset < input.length {
    let remaining = Slice.view<u8>(input, offset, input.length - offset)
    let fed = run Client.feedInput(&mut client, remaining)
    let accepted = match move fed {
      Result<Progress, TlsError>.Success {value} => value.consumed
      Result<Progress, TlsError>.Failure {error} => {
        return FeedOutcome.Failure {error: move error}
      }
    }
    if accepted == usize.ZERO { return FeedOutcome.Stalled }
    offset = offset + accepted
    let mut steps = usize.ZERO
    while steps < progressSteps {
      let advanced = run Client.progress(&mut client)
      if let Result<Progress, TlsError>.Failure {error} = move advanced {
        return FeedOutcome.Failure {error: move error}
      }
      steps = steps + usize.ONE
    }
  }
  return FeedOutcome.Complete
}

effect fn feedAll(
  client: &mut Client,
  input: &[u8],
) -> i32
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let outcome = run feedOutcome(&mut client.*, input, 8)
  return match move outcome {
    FeedOutcome.Complete => 0
    FeedOutcome.Stalled => 21
    FeedOutcome.Failure {error} => feedFailureCode(move error)
  }
}

// TLS_CLIENT_NATIVE_LIMIT_HELPER_BEGIN
effect fn feedExpectedLimit(
  client: &mut Client,
  input: &[u8],
  expectedKind: TlsLimitKind,
  expectedLimit: usize,
) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let outcome = run feedOutcome(&mut client.*, input, usize.ONE)
  return match move outcome {
    FeedOutcome.Failure {error} => {
      if !exactLimitError(move error, expectedKind, expectedLimit) { return false }
      return exactLimitFailure(run Client.progress(&mut client.*), expectedKind, expectedLimit)
    }
    FeedOutcome.Complete => false
    FeedOutcome.Stalled => false
  }
}
// TLS_CLIENT_NATIVE_LIMIT_HELPER_END

effect fn authenticate(
  client: &mut Client,
  flight: &[u8],
) -> i32
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let fed = run feedAll(&mut client.*, flight)
  if fed != 0 { return fed }
  let mut outputSteps = usize.ZERO
  while outputSteps < 3 {
    let mut steps = usize.ZERO
    while client.pendingOutput().length == 0 && steps < 8 {
      let advanced = run Client.progress(&mut client)
      if let Result<Progress, TlsError>.Failure {error} = move advanced {
        return feedFailureCode(move error)
      }
      steps = steps + usize.ONE
    }
    let outputLength = Client.pendingOutput(&client.*).length
    if outputLength == 0 { return 23 }
    let acknowledged = Client.ackWritten(&mut client, outputLength)
    match move acknowledged {
      Result<Progress, TlsError>.Success {value} => {
        if value.demand == Demand.Authenticated { return 0 }
      }
      Result<Progress, TlsError>.Failure {error} => { return feedFailureCode(move error) }
    }
    outputSteps = outputSteps + usize.ONE
  }
  return 24
}

// TLS_CLIENT_WASM_EXPECTATIONS_BEGIN
// TLS_CLIENT_WASM_EXPECTATIONS_END

// TLS_CLIENT_CASES_BEGIN
// TLS_CLIENT_CASES_END

effect fn recover(error: OutOfMemoryError) -> i32 { return 98 }

// TLS_CLIENT_MAIN_BEGIN
pub fn main() -> i32 {
  let h2: [u8; 2] = [104, 50]
  let protocols = [alpnProtocol(&h2)]
  return run Effect.catchAll(cases(&protocols), recover)
}
// TLS_CLIENT_MAIN_END
`

const tlsClientWasmCases = `effect fn cases<'a>(h2Protocols: &'a [AlpnProtocol<'a>]) -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut random = ScriptedRandom {filled: 0}
  let made = run makeDefaultClient()
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut client = match move made {
    Result<Client, TlsError>.Success {value} => move value
    Result<Client, TlsError>.Failure {error} => { return 1 }
  }
  let pending = client.pendingOutput()
  if pending.length != ${clientHello.length} { return 2 }
  drop pending
  drop client.ackWritten(${clientHello.length})
  let flight = ${silkBytes(serverFlight)}
  let authenticated = run authenticate(&mut client, flight)
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if authenticated != 0 { return 3 }
  let metadata = client.authentication()
  let valid = match move metadata {
    Option.None => false
    Option.Some {value} => value.suite() == CipherSuite.ChaCha20Poly1305Sha256
      && value.group() == NamedGroup.X25519
      && value.leafDer().length > 0
  }
  if !valid { return 4 }
  let mut plaintext: [u8; 40] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]
  let read = client.readPlaintext(&mut plaintext)
  return match move read {
    Result<Progress, TlsError>.Success {value} => {
      if value.written == 33 { return 42 }
      return 5
    }
    Result<Progress, TlsError>.Failure {error} => 6
  }
}

`

const tlsClientNativeCommon = `effect fn scenarioTrust(
  trusted: bool,
  master: &TrustSnapshot,
) -> TrustSnapshot
! OutOfMemoryError
? &mut Allocator {
  if !trusted { return emptyTrust() }
  let copied = run TrustSnapshot.copy(master, SnapshotLimits.defaults())
  return match move copied {
    Result<TrustSnapshot, TrustSourceError>.Success {value} => move value
    Result<TrustSnapshot, TrustSourceError>.Failure {error} => {
      let invalid = 1 / 0
      return run scenarioTrust(trusted, master)
    }
  }
}

effect fn makeClient<'a>(
  master: &TrustSnapshot,
  trusted: bool,
  selectedReference: ReferenceIdentity<'a>,
  selectedAlpn: AlpnConfig<'a>,
  limits: ClientLimits,
  seconds: i64,
) -> Result<Client, TlsError>
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let trust = run scenarioTrust(trusted, master)
  let config = ClientConfig {
    reference: selectedReference,
    alpn: selectedAlpn,
    limits: limits,
  }
  return run Client.make(&config, move trust, SystemClock.make(seconds, 123456789))
}

effect fn matchesHello(client: &Client, fixtureId: i32) -> bool
! OutOfMemoryError
? &mut Allocator {
  let owner = run loadFixture(fixtureId)
  let actual = client.pendingOutput()
  let expected = Bytes.asSlice(&owner)
  if actual.length != expected.length || actual.length < 5 { return false }
  if actual[0] != 22 || actual[1] != 3 || actual[2] != 3 { return false }
  if u8.toUsize(actual[3]) * 256 + u8.toUsize(actual[4]) + 5 != actual.length {
    return false
  }
  let mut index: usize = 5
  while index < actual.length {
    if actual[index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

fn validPlaintext(bytes: &[u8], written: usize) -> bool {
  let expected = b"coalesced authenticated plaintext"
  if written != expected.length { return false }
  let mut index = usize.ZERO
  while index < written {
    if bytes[index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

fn scenarioReference<'a>(id: i32, normal: &'a [u8], wrong: &'a [u8]) -> ReferenceIdentity<'a> {
  if id == 6 {
    let admitted = HttpsIdentity.reference(OriginHost<'a>.Ipv4 {bytes: [127, 0, 0, 1]})
    return match move admitted {
      Result<ReferenceIdentity<'a>, IdentityError>.Success {value} => value
      Result<ReferenceIdentity<'a>, IdentityError>.Failure {error} => reference(normal)
    }
  }
  if id == 5 { return reference(wrong) }
  return reference(normal)
}

effect fn feedFragments(client: &mut Client, input: &[u8]) -> i32
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let mut offset = usize.ZERO
  while offset < input.length {
    let fragment = Slice.view<u8>(input, offset, usize.ONE)
    let fed = run Client.feedInput(&mut client.*, fragment)
    let consumed = match move fed {
      Result<Progress, TlsError>.Success {value} => value.consumed
      Result<Progress, TlsError>.Failure {error} => { return feedFailureCode(move error) }
    }
    if consumed != usize.ONE { return 21 }
    offset = offset + usize.ONE
    let mut steps = usize.ZERO
    while steps < 8 {
      let advanced = run Client.progress(&mut client.*)
      if let Result<Progress, TlsError>.Failure {error} = move advanced {
        return feedFailureCode(move error)
      }
      steps = steps + usize.ONE
    }
  }
  return 0
}

effect fn authenticateFragments(client: &mut Client, flight: &[u8]) -> i32
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let fed = run feedFragments(&mut client.*, flight)
  if fed != 0 { return fed }
  let mut outputSteps = usize.ZERO
  while outputSteps < 3 {
    let outputLength = Client.pendingOutput(&client.*).length
    if outputLength == 0 { return 23 }
    let acknowledged = Client.ackWritten(&mut client.*, outputLength)
    match move acknowledged {
      Result<Progress, TlsError>.Success {value} => {
        if value.demand == Demand.Authenticated { return 0 }
      }
      Result<Progress, TlsError>.Failure {error} => { return feedFailureCode(move error) }
    }
    outputSteps = outputSteps + usize.ONE
  }
  return 24
}

`

const tlsClientDemandDrivenHelper = `effect fn feedToDemand(
  client: &mut Client,
  input: &[u8],
  expected: Demand,
) -> i32
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let mut offset = usize.ZERO
  while offset < input.length {
    let remaining = Slice.view<u8>(input, offset, input.length - offset)
    let fed = run Client.feedInput(&mut client.*, remaining)
    let progress = match move fed {
      Result<Progress, TlsError>.Success {value} => move value
      Result<Progress, TlsError>.Failure {error} => { return feedFailureCode(move error) }
    }
    if progress.consumed == usize.ZERO { return 21 }
    offset = offset + progress.consumed
    if progress.demand == expected && expected != Demand.NeedInput { return 0 }
    if offset < input.length && progress.demand != Demand.NeedInput { return 20 }
    if offset == input.length {
      if progress.demand == expected { return 0 }
      return 20
    }
  }
  return 21
}
`

const tlsClientDemandRequestCases = `${tlsClientNativeCommon}${tlsClientDemandDrivenHelper}
fn requestFixture(id: i32) -> i32 {
  if id == 2 { return ${nativeFixtureIds.validOptionalRequestPrefix} }
  if id == 3 { return ${nativeFixtureIds.validUnknownRequestPrefix} }
  if id == 4 { return ${nativeFixtureIds.duplicateUnknownRequestPrefix} }
  if id == 5 { return ${nativeFixtureIds.malformedStatusRequestPrefix} }
  if id == 6 { return ${nativeFixtureIds.malformedSctRequestPrefix} }
  if id == 7 { return ${nativeFixtureIds.malformedOidFiltersPrefix} }
  return ${nativeFixtureIds.illegalKeyShareRequestPrefix}
}

effect fn demandRequestCase<'a>(
  id: i32,
  master: &TrustSnapshot,
  protocols: &'a [AlpnProtocol<'a>],
) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let host = b"ExAmPlE.com"
  let mut alpn = AlpnConfig.defaults()
  let mut helloFixture = ${nativeFixtureIds.clientHello}
  if id != 1 {
    alpn = AlpnConfig.Offered {protocols: protocols, required: true}
    helloFixture = ${nativeFixtureIds.aes128ClientHello}
  }
  let made = run makeClient(
    master,
    true,
    reference(&host),
    alpn,
    ClientLimits.defaults(),
    1789156800,
  )
  let mut client = match move made {
    Result<Client, TlsError>.Success {value} => move value
    Result<Client, TlsError>.Failure {error} => { return false }
  }
  if !(run matchesHello(&client, helloFixture)) { return false }
  let helloLength = client.pendingOutput().length
  drop client.ackWritten(helloLength)

  if id == 0 {
    let flight = run loadFixture(${nativeFixtureIds.aes128ServerFlight})
    if (run feedToDemand(&mut client, Bytes.asSlice(&flight), Demand.NeedOutput)) != 0 {
      return false
    }
    let expected = run loadFixture(${nativeFixtureIds.expectedEmptyCertificateRecord})
    return sameBytes(client.pendingOutput(), Bytes.asSlice(&expected))
  }

  if id == 1 {
    let flight = run loadFixture(${nativeFixtureIds.serverFlight})
    if (run authenticate(&mut client, Bytes.asSlice(&flight))) != 0 { return false }
    let mut plaintext: [u8; 40] = [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]
    let read = client.readPlaintext(&mut plaintext)
    let written = match move read {
      Result<Progress, TlsError>.Success {value} => value.written
      Result<Progress, TlsError>.Failure {error} => usize.ZERO
    }
    if !validPlaintext(&plaintext, written) { return false }
    let coalesced = run loadFixture(${nativeFixtureIds.coalescedTicketKeyUpdateRecord})
    if (run feedToDemand(&mut client, Bytes.asSlice(&coalesced), Demand.NeedOutput)) != 0 {
      return false
    }
    let expected = run loadFixture(
      ${nativeFixtureIds.expectedInitialPeerKeyUpdateResponseRecord},
    )
    let response = client.pendingOutput()
    if !sameBytes(response, Bytes.asSlice(&expected)) { return false }
    let responseLength = response.length
    drop response
    return isNeedInput(client.ackWritten(responseLength))
  }

  let input = run loadFixture(requestFixture(id))
  let code = run feedToDemand(&mut client, Bytes.asSlice(&input), Demand.NeedInput)
  if id == 2 || id == 3 { return code == 0 }
  return code == 47 && isFailureCode(run client.progress(), 47)
}

effect fn cases<'a>(protocols: &'a [AlpnProtocol<'a>]) -> i32
! OutOfMemoryError
? &mut Allocator {
  let master = run rootTrust()
  let mut random = ScriptedRandom {filled: 0}
  let mut id = 0
  while id <= 8 {
    random.filled = usize.ZERO
    let passed = run demandRequestCase(id, &master, protocols)
      |> Effect.provideMut<Random>(&mut random)
    if !passed || random.filled != 64 { return id + 1 }
    id = id + 1
  }
  return 42
}
`

const tlsClientCoreCases = `fn coreAuthenticationHidden(client: &Client) -> bool {
  let metadata = client.authentication()
  return match move metadata {
    Option.None => true
    Option.Some {value} => false
  }
}

fn validCoreAuthentication(client: &Client) -> bool {
  let metadata = client.authentication()
  return match move metadata {
    Option.None => false
    Option.Some {value} => value.suite() == CipherSuite.ChaCha20Poly1305Sha256
      && value.group() == NamedGroup.X25519
      && value.anchorIndex() == 0
      && value.sanIndex() == 0
      && value.leafDer().length > 0
  }
}

fn corePlaintext(bytes: &[u8], written: usize) -> bool {
  let expected = b"coalesced authenticated plaintext"
  if written != expected.length { return false }
  let mut index = usize.ZERO
  while index < written {
    if bytes[index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

effect fn coreHelloMatches(client: &Client) -> bool
! OutOfMemoryError
? &mut Allocator {
  let owner = run loadFixture(${nativeFixtureIds.clientHello})
  let expected = Bytes.asSlice(&owner)
  let actual = client.pendingOutput()
  if actual.length != expected.length || actual.length < 5 { return false }
  if actual[0] != 22 || actual[1] != 3 || actual[2] != 3 { return false }
  if u8.toUsize(actual[3]) * 256 + u8.toUsize(actual[4]) + 5 != actual.length {
    return false
  }
  let mut index: usize = 5
  while index < actual.length {
    if actual[index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

effect fn feedCoreFragments(client: &mut Client, input: &[u8]) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let mut offset = usize.ZERO
  while offset < input.length {
    let fragment = Slice.view<u8>(input, offset, usize.ONE)
    let fed = run Client.feedInput(&mut client.*, fragment)
    let consumed = match move fed {
      Result<Progress, TlsError>.Success {value} => value.consumed
      Result<Progress, TlsError>.Failure {error} => { return false }
    }
    if consumed != usize.ONE { return false }
    offset = offset + usize.ONE
    let mut steps = usize.ZERO
    while steps < 8 {
      let advanced = run Client.progress(&mut client.*)
      if let Result<Progress, TlsError>.Failure {error} = move advanced {
        return false
      }
      steps = steps + usize.ONE
    }
  }
  return true
}

effect fn core() -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let host = b"ExAmPlE.com"
  let config = ClientConfig {
    reference: reference(&host),
    alpn: AlpnConfig.defaults(),
    limits: ClientLimits.defaults(),
  }
  let trust = run rootTrust()
  let made = run Client.make(&config, move trust, SystemClock.make(1789156800, 123456789))
  let mut client = match move made {
    Result<Client, TlsError>.Success {value} => move value
    Result<Client, TlsError>.Failure {error} => { return false }
  }
  if !coreAuthenticationHidden(&client) || !(run coreHelloMatches(&client)) { return false }
  let helloLength = client.pendingOutput().length
  if !isNeedInput(client.ackWritten(helloLength)) { return false }

  let flight = run loadFixture(${nativeFixtureIds.serverFlight})
  if !(run feedCoreFragments(&mut client, Bytes.asSlice(&flight))) { return false }
  let output = client.pendingOutput()
  if output.length < 2 { return false }
  let outputLength = output.length
  let second = output[1]
  drop output
  if !hasDemand(client.ackWritten(usize.ONE), Demand.NeedOutput) { return false }
  if !coreAuthenticationHidden(&client) { return false }
  if !isPrematureWrite(client.writePlaintext(b"blocked")) { return false }
  let mut blocked: [u8; 1] = [0]
  if !isPrematureRead(client.readPlaintext(&mut blocked)) { return false }
  let suffix = client.pendingOutput()
  if suffix.length + usize.ONE != outputLength || suffix[0] != second { return false }
  drop suffix
  if !hasDemand(client.ackWritten(outputLength - usize.ONE), Demand.Authenticated) {
    return false
  }
  if !validCoreAuthentication(&client) { return false }
  if hasDemand(run client.progress(), Demand.Authenticated) { return false }
  let mut plaintext: [u8; 40] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]
  let read = client.readPlaintext(&mut plaintext)
  let written = match move read {
    Result<Progress, TlsError>.Success {value} => value.written
    Result<Progress, TlsError>.Failure {error} => usize.ZERO
  }
  return corePlaintext(&plaintext, written)
}

effect fn cases() -> i32
! OutOfMemoryError
? &mut Allocator {
  let mut random = ScriptedRandom {filled: 0}
  let passed = run core() |> Effect.provideMut<Random>(&mut random)
  if !passed || random.filled != 64 { return 1 }
  return 42
}
`

const tlsClientKeyUpdateCases = `${tlsClientNativeCommon}
effect fn keyUpdateCase(id: i32, master: &TrustSnapshot) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let host = b"ExAmPlE.com"
  let made = run makeClient(
    master,
    true,
    reference(&host),
    AlpnConfig.defaults(),
    ClientLimits.defaults(),
    1789156800,
  )
  let mut client = match move made {
    Result<Client, TlsError>.Success {value} => move value
    Result<Client, TlsError>.Failure {error} => { return false }
  }
  if !(run matchesHello(&client, ${nativeFixtureIds.clientHello})) { return false }
  let helloLength = client.pendingOutput().length
  drop client.ackWritten(helloLength)
  let flight = run loadFixture(${nativeFixtureIds.serverFlight})
  if (run authenticate(&mut client, Bytes.asSlice(&flight))) != 0 { return false }
  let mut plaintext: [u8; 40] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]
  let read = client.readPlaintext(&mut plaintext)
  let written = match move read {
    Result<Progress, TlsError>.Success {value} => value.written
    Result<Progress, TlsError>.Failure {error} => usize.ZERO
  }
  if !validPlaintext(&plaintext, written) { return false }

  if id == 3 {
    let oversized = run Bytes.zeroed(16385)
    let accepted = client.writePlaintext(Bytes.asSlice(&oversized))
    let firstAccepted = match move accepted {
      Result<Progress, TlsError>.Success {value} =>
        value.consumed == 16384 && value.demand == Demand.NeedOutput
      Result<Progress, TlsError>.Failure {error} => false
    }
    if !firstAccepted { return false }
    let pending = client.pendingOutput()
    let pendingLength = pending.length
    if pendingLength != 16406
      || pending[0] != 23
      || pending[1] != 3
      || pending[2] != 3
      || pending[3] != 64
      || pending[4] != 17 { return false }
    let mut stable = run Bytes.zeroed(pendingLength)
    let mut stableView = Bytes.asMutSlice(&mut stable)
    let mut index = usize.ZERO
    while index < pendingLength {
      stableView[index] = pending[index]
      index = index + usize.ONE
    }
    drop stableView
    drop pending
    let blocked = client.writePlaintext(Bytes.asSlice(&oversized))
    let blockedCleanly = match move blocked {
      Result<Progress, TlsError>.Success {value} =>
        value.consumed == 0 && value.demand == Demand.NeedOutput
      Result<Progress, TlsError>.Failure {error} => false
    }
    if !blockedCleanly || !sameBytes(client.pendingOutput(), Bytes.asSlice(&stable)) {
      return false
    }
    if !isNeedInput(client.ackWritten(pendingLength)) { return false }
    let suffix = Slice.view<u8>(Bytes.asSlice(&oversized), 16384, usize.ONE)
    let retried = client.writePlaintext(suffix)
    return match move retried {
      Result<Progress, TlsError>.Success {value} =>
        value.consumed == usize.ONE && value.demand == Demand.NeedOutput
      Result<Progress, TlsError>.Failure {error} => false
    }
  }

  if id == 0 {
    if !hasDemand(client.writePlaintext(b"queued-before-update"), Demand.NeedOutput) {
      return false
    }
    if !isNeedOutput(client.requestKeyUpdate()) || !isNeedOutput(client.requestKeyUpdate()) {
      return false
    }
    let applicationOwner = run loadFixture(${nativeFixtureIds.expectedApplicationRecord})
    let application = client.pendingOutput()
    if !sameBytes(application, Bytes.asSlice(&applicationOwner)) { return false }
    let applicationLength = application.length
    drop application
    if !isNeedOutput(client.ackWritten(usize.ONE)) { return false }
    let peerUpdate = run loadFixture(${nativeFixtureIds.peerKeyUpdateRecord})
    if (run feedFragments(&mut client, Bytes.asSlice(&peerUpdate))) != 0 { return false }
    if !isNeedOutput(client.requestKeyUpdate()) { return false }
    if !isNeedOutput(client.ackWritten(applicationLength - usize.ONE)) { return false }
    let responseOwner = run loadFixture(${nativeFixtureIds.expectedPeerKeyUpdateResponseRecord})
    let response = client.pendingOutput()
    if !sameBytes(response, Bytes.asSlice(&responseOwner)) { return false }
    let responseLength = response.length
    drop response
    if !isNeedOutput(client.ackWritten(usize.ONE)) { return false }
    let responseSuffix = client.pendingOutput()
    let expectedSuffix = Slice.view<u8>(
      Bytes.asSlice(&responseOwner),
      usize.ONE,
      responseLength - usize.ONE,
    )
    if !sameBytes(responseSuffix, expectedSuffix) { return false }
    drop responseSuffix
    return isNeedInput(client.ackWritten(responseLength - usize.ONE))
  }

  if id == 1 {
    let malformed = run loadFixture(${nativeFixtureIds.malformedKeyUpdateRecord})
    let code = run feedFragments(&mut client, Bytes.asSlice(&malformed))
    return code == 49 && isFailureCode(run client.progress(), 49)
  }

  if !hasDemand(client.requestKeyUpdate(), Demand.NeedOutput) { return false }
  let expected = run loadFixture(${nativeFixtureIds.expectedInitialKeyUpdateRecord})
  let output = client.pendingOutput()
  if !sameBytes(output, Bytes.asSlice(&expected)) { return false }
  let length = output.length
  drop output
  if !isNeedOutput(client.ackWritten(usize.ONE)) { return false }
  let suffix = client.pendingOutput()
  let expectedSuffix = Slice.view<u8>(Bytes.asSlice(&expected), usize.ONE, length - usize.ONE)
  if !sameBytes(suffix, expectedSuffix) { return false }
  drop suffix
  return isNeedInput(client.ackWritten(length - usize.ONE))
}

effect fn cases() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let master = run rootTrust()
  let mut random = ScriptedRandom {filled: 0}
  let mut id = 0
  while id <= 3 {
    random.filled = usize.ZERO
    let passed = run keyUpdateCase(id, &master)
      |> Effect.provideMut<Random>(&mut random)
    if !passed || random.filled != 64 { return id + 1 }
    id = id + 1
  }
  return 42
}
`

const tlsClientHandshakePolicyCases = `${tlsClientNativeCommon}
fn policyHello(id: i32) -> i32 {
  if id == 0 || id == 3 || id == 4 || (id >= 11 && id <= 15)
    || id == 21 || id == 22 || id == 30 { return ${nativeFixtureIds.aes128ClientHello} }
  if id == 1 || id == 2 || id == 19 || id == 20 || id == 27 || id == 28 {
    return ${nativeFixtureIds.aes256ClientHello}
  }
  if id == 5 { return ${nativeFixtureIds.wrongNameClientHello} }
  if id == 6 { return ${nativeFixtureIds.ipClientHello} }
  return ${nativeFixtureIds.clientHello}
}

fn policyFlight(id: i32) -> i32 {
  if id == 0 { return ${nativeFixtureIds.aes128ServerFlight} }
  if id == 1 { return ${nativeFixtureIds.aes256ServerFlight} }
  if id == 3 || id == 4 { return ${nativeFixtureIds.aes128NoAlpnServerFlight} }
  if id == 5 { return ${nativeFixtureIds.wrongNameServerFlight} }
  if id == 6 { return ${nativeFixtureIds.ipServerFlight} }
  if id == 7 { return ${nativeFixtureIds.badCertificateDerFlight} }
  if id == 8 { return ${nativeFixtureIds.badCertificateVerifyFlight} }
  if id == 9 { return ${nativeFixtureIds.badFinishedFlight} }
  if id == 10 { return ${nativeFixtureIds.unsolicitedExtensionFlight} }
  if id == 11 { return ${nativeFixtureIds.missingSignatureAlgorithmsFlight} }
  if id == 12 { return ${nativeFixtureIds.oddSignatureAlgorithmsFlight} }
  if id == 13 { return ${nativeFixtureIds.malformedAuthoritiesFlight} }
  if id == 14 { return ${nativeFixtureIds.duplicateRequestExtensionFlight} }
  if id == 15 { return ${nativeFixtureIds.unsolicitedRequestExtensionFlight} }
  if id == 16 { return ${nativeFixtureIds.coalescedServerHelloFlight} }
  if id == 17 { return ${nativeFixtureIds.invalidKeyShareFlight} }
  if id == 18 { return ${nativeFixtureIds.mismatchedKeyShareFlight} }
  if id == 19 { return ${nativeFixtureIds.alreadyOfferedGroupRetry} }
  if id == 20 { return ${nativeFixtureIds.emptyCookieRetry} }
  if id == 21 { return ${nativeFixtureIds.duplicateAlpnExtensionFlight} }
  if id == 22 { return ${nativeFixtureIds.unofferedAlpnFlight} }
  if id == 23 { return ${nativeFixtureIds.unsupportedGroupFlight} }
  if id == 24 { return ${nativeFixtureIds.unsupportedSuiteFlight} }
  if id == 30 { return ${nativeFixtureIds.malformedAlpnFlight} }
  return ${nativeFixtureIds.serverFlight}
}

fn policyFailure(id: i32) -> i32 {
  if id == 4 || id == 22 { return 62 }
  if id == 5 || id == 6 { return 53 }
  if id == 7 { return 51 }
  if id == 8 { return 54 }
  if id == 9 { return 55 }
  if id == 10 || id == 21 || id == 30 { return 43 }
  if id >= 11 && id <= 15 { return 47 }
  if id == 16 { return 44 }
  if id == 17 || id == 18 { return 56 }
  if id == 19 || id == 20 { return 45 }
  if id == 23 || id == 24 { return 56 }
  if id == 29 { return 52 }
  return 0
}

fn validPolicyAuthentication<'a>(id: i32, value: &Authentication<'a>) -> bool {
  if id == 0 { return validAes128Authentication(value) }
  if id == 1 {
    return value.suite() == CipherSuite.Aes256GcmSha384
      && value.group() == NamedGroup.P256
  }
  if id == 3 {
    return match move value.selectedAlpn() {
      Option.None => true
      Option.Some {value: selected} => false
    }
  }
  return value.suite() == CipherSuite.ChaCha20Poly1305Sha256
    && value.group() == NamedGroup.X25519
}

effect fn handshakePolicyCase<'a>(
  id: i32,
  master: &TrustSnapshot,
  protocols: &'a [AlpnProtocol<'a>],
) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let normal = b"ExAmPlE.com"
  let wrong = b"wrong.example"
  let mut selectedAlpn = AlpnConfig.defaults()
  if id == 0 || id == 4 || (id >= 11 && id <= 15) || id == 21 || id == 22 || id == 30 {
    selectedAlpn = AlpnConfig.Offered {protocols: protocols, required: true}
  } else if id == 3 {
    selectedAlpn = AlpnConfig.Offered {protocols: protocols, required: false}
  }
  let trusted = id != 29
  let made = run makeClient(
    master,
    trusted,
    scenarioReference(id, &normal, &wrong),
    selectedAlpn,
    ClientLimits.defaults(),
    1789156800,
  )
  let mut client = match move made {
    Result<Client, TlsError>.Success {value} => move value
    Result<Client, TlsError>.Failure {error} => { return false }
  }
  if !(run matchesHello(&client, policyHello(id))) { return false }
  let helloLength = client.pendingOutput().length
  drop client.ackWritten(helloLength)

  if id == 2 {
    let retry = run loadFixture(${nativeFixtureIds.cookieRetry})
    if (run feedAll(&mut client, Bytes.asSlice(&retry))) != 0 { return false }
    return run matchesHello(&client, ${nativeFixtureIds.cookieClientRetry})
  }

  if id == 1 || id == 27 || id == 28 {
    let retry = run loadFixture(${nativeFixtureIds.aes256ServerRetry})
    if (run feedAll(&mut client, Bytes.asSlice(&retry))) != 0 { return false }
    if !(run matchesHello(&client, ${nativeFixtureIds.aes256ClientRetry})) { return false }
    let retryLength = client.pendingOutput().length
    drop client.ackWritten(retryLength)
    if id == 27 {
      let changed = run loadFixture(${nativeFixtureIds.changedSuiteAfterRetryFlight})
      let code = run feedAll(&mut client, Bytes.asSlice(&changed))
      return code == 44 && isFailureCode(run client.progress(), 44)
    }
    if id == 28 {
      let second = run loadFixture(${nativeFixtureIds.aes256ServerRetry})
      let code = run feedAll(&mut client, Bytes.asSlice(&second))
      return code == 45 && isFailureCode(run client.progress(), 45)
    }
  }

  if id == 25 {
    let ccs = run loadFixture(${nativeFixtureIds.validCcs})
    if (run feedAll(&mut client, Bytes.asSlice(&ccs))) != 0 { return false }
  }

  let flight = run loadFixture(policyFlight(id))
  if id == 0 {
    if (run feedAll(&mut client, Bytes.asSlice(&flight))) != 0 { return false }
    let expectedCertificate = run loadFixture(${nativeFixtureIds.expectedEmptyCertificateRecord})
    let certificate = client.pendingOutput()
    if !sameBytes(certificate, Bytes.asSlice(&expectedCertificate)) { return false }
    let certificateLength = certificate.length
    drop certificate
    if !hasDemand(client.ackWritten(certificateLength), Demand.NeedOutput) { return false }
    let expectedFinished = run loadFixture(${nativeFixtureIds.expectedClientFinishedRecord})
    let finished = client.pendingOutput()
    if !sameBytes(finished, Bytes.asSlice(&expectedFinished)) { return false }
    let finishedLength = finished.length
    drop finished
    if !hasDemand(client.ackWritten(finishedLength), Demand.Authenticated) { return false }
    let metadata = client.authentication()
    return match move metadata {
      Option.None => false
      Option.Some {value} => validPolicyAuthentication(id, &value)
    }
  }
  let expectedFailure = policyFailure(id)
  if expectedFailure != 0 {
    let code = run feedAll(&mut client, Bytes.asSlice(&flight))
    return code == expectedFailure && isFailureCode(run client.progress(), expectedFailure)
  }
  if (run authenticate(&mut client, Bytes.asSlice(&flight))) != 0 { return false }
  if id == 26 {
    let mut plaintext: [u8; 40] = [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]
    if !hasDemand(client.readPlaintext(&mut plaintext), Demand.NeedInput) { return false }
    let ccs = run loadFixture(${nativeFixtureIds.validCcs})
    let code = run feedAll(&mut client, Bytes.asSlice(&ccs))
    return code == 46 && isFailureCode(run client.progress(), 46)
  }
  let metadata = client.authentication()
  return match move metadata {
    Option.None => false
    Option.Some {value} => validPolicyAuthentication(id, &value)
  }
}

effect fn cases<'a>(protocols: &'a [AlpnProtocol<'a>]) -> i32
! OutOfMemoryError
? &mut Allocator {
  let master = run rootTrust()
  let mut random = ScriptedRandom {filled: 0}
  let mut id = 0
  while id <= 30 {
    random.filled = usize.ZERO
    let passed = run handshakePolicyCase(id, &master, protocols)
      |> Effect.provideMut<Random>(&mut random)
    let mut expectedEntropy: usize = 64
    if id == 1 || id == 2 || id == 27 || id == 28 { expectedEntropy = 96 }
    if !passed || random.filled != expectedEntropy { return id + 1 }
    id = id + 1
  }
  return 42
}
`

const tlsClientClosureControlCases = `${tlsClientNativeCommon}
fn isHandshakeTruncated(result: Result<Progress, TlsError>) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => false
    Result<Progress, TlsError>.Failure {error} => match move error {
      TlsError.HandshakeTruncated => true
      _ => false
    }
  }
}

fn isEmptyBuffer(result: Result<Progress, TlsError>) -> bool {
  return match move result {
    Result<Progress, TlsError>.Success {value} => false
    Result<Progress, TlsError>.Failure {error} => match move error {
      TlsError.EmptyBuffer => true
      _ => false
    }
  }
}

effect fn closureControlCase(id: i32, master: &TrustSnapshot) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let host = b"ExAmPlE.com"
  let made = run makeClient(
    master,
    true,
    reference(&host),
    AlpnConfig.defaults(),
    ClientLimits.defaults(),
    1789156800,
  )
  let mut client = match move made {
    Result<Client, TlsError>.Success {value} => move value
    Result<Client, TlsError>.Failure {error} => { return false }
  }
  if !(run matchesHello(&client, ${nativeFixtureIds.clientHello})) { return false }
  if id == 6 {
    let before = client.pendingOutput().length
    if !isHandshakeTruncated(client.endInput()) { return false }
    return before > 0 && client.pendingOutput().length == 0
      && isHandshakeTruncated(client.ackWritten(usize.ZERO))
  }
  let helloLength = client.pendingOutput().length
  drop client.ackWritten(helloLength)
  if id == 4 {
    let badTag = run loadFixture(${nativeFixtureIds.badTagFlight})
    let code = run feedAll(&mut client, Bytes.asSlice(&badTag))
    return code == 31 && isFailureCode(run client.progress(), 31)
  }
  let flight = run loadFixture(${nativeFixtureIds.serverFlight})
  if (run authenticate(&mut client, Bytes.asSlice(&flight))) != 0 { return false }
  let mut plaintext: [u8; 40] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]

  if id == 0 {
    if !hasDemand(client.endInput(), Demand.PlaintextReady) { return false }
    let drained = client.readPlaintext(&mut plaintext)
    let written = match move drained {
      Result<Progress, TlsError>.Success {value} => value.written
      Result<Progress, TlsError>.Failure {error} => usize.ZERO
    }
    let mut empty: [u8; 0] = []
    return validPlaintext(&plaintext, written)
      && isEmptyBuffer(client.readPlaintext(&mut empty))
      && isTruncated(client.readPlaintext(&mut plaintext))
  }

  let initialRead = client.readPlaintext(&mut plaintext)
  let initialWritten = match move initialRead {
    Result<Progress, TlsError>.Success {value} => value.written
    Result<Progress, TlsError>.Failure {error} => usize.ZERO
  }
  if !validPlaintext(&plaintext, initialWritten) { return false }

  if id == 1 {
    let close = run loadFixture(${nativeFixtureIds.closeNotifyRecord})
    if (run feedAll(&mut client, Bytes.asSlice(&close))) != 0 { return false }
    let trailing = b"ignored after close_notify"
    let ignored = run client.feedInput(trailing)
    let clean = match move ignored {
      Result<Progress, TlsError>.Success {value} =>
        value.consumed == trailing.length && value.demand == Demand.PeerClosed
      Result<Progress, TlsError>.Failure {error} => false
    }
    if !clean || !hasDemand(client.writePlaintext(b"queued-before-update"), Demand.NeedOutput) {
      return false
    }
    let applicationOwner = run loadFixture(${nativeFixtureIds.expectedApplicationRecord})
    let application = client.pendingOutput()
    if !sameBytes(application, Bytes.asSlice(&applicationOwner)) { return false }
    let applicationLength = application.length
    drop application
    if !hasDemand(client.ackWritten(applicationLength), Demand.PeerClosed) { return false }
    if !hasDemand(client.closeWrite(), Demand.NeedOutput) { return false }
    let closeOwner = run loadFixture(${nativeFixtureIds.expectedCloseAfterApplicationRecord})
    let output = client.pendingOutput()
    if !sameBytes(output, Bytes.asSlice(&closeOwner)) { return false }
    let closeLength = output.length
    drop output
    return hasDemand(client.ackWritten(closeLength), Demand.Closed)
  }

  if id == 2 {
    let warning = run loadFixture(${nativeFixtureIds.userCanceledRecord})
    if (run feedAll(&mut client, Bytes.asSlice(&warning))) != 0 { return false }
    if !isTruncated(client.endInput()) { return false }
    let mut empty: [u8; 0] = []
    return isTruncated(client.readPlaintext(&mut empty))
  }

  if id == 3 {
    if !hasDemand(client.writePlaintext(b"queued-before-update"), Demand.NeedOutput) {
      return false
    }
    let pending = client.pendingOutput().length
    if pending < 2 || !isNeedOutput(client.ackWritten(usize.ONE)) { return false }
    let alert = run loadFixture(${nativeFixtureIds.fatalAlertRecord})
    let failed = run client.feedInput(Bytes.asSlice(&alert))
    return exactPeerAlert(move failed, 40) && client.pendingOutput().length == 0
      && exactPeerAlert(client.ackWritten(usize.ZERO), 40)
  }

  if id == 5 {
    if !hasDemand(client.writePlaintext(b"queued-before-update"), Demand.NeedOutput)
      || !hasDemand(client.closeWrite(), Demand.NeedOutput) { return false }
    let applicationOwner = run loadFixture(${nativeFixtureIds.expectedApplicationRecord})
    let application = client.pendingOutput()
    if !sameBytes(application, Bytes.asSlice(&applicationOwner)) { return false }
    let applicationLength = application.length
    drop application
    if !hasDemand(client.ackWritten(applicationLength), Demand.NeedOutput) { return false }
    let closeOwner = run loadFixture(${nativeFixtureIds.expectedCloseAfterApplicationRecord})
    let close = client.pendingOutput()
    if !sameBytes(close, Bytes.asSlice(&closeOwner)) { return false }
    let closeLength = close.length
    drop close
    if !hasDemand(client.ackWritten(closeLength), Demand.NeedInput) { return false }
    return isPrematureWrite(client.writePlaintext(b"closed"))
  }

  if id == 7 || id == 8 {
    let mut fixtureId = ${nativeFixtureIds.malformedTicketRecord}
    if id == 8 { fixtureId = ${nativeFixtureIds.duplicateTicketExtensionRecord} }
    let ticket = run loadFixture(fixtureId)
    let code = run feedAll(&mut client, Bytes.asSlice(&ticket))
    return code == 49 && isFailureCode(run client.progress(), 49)
  }

  let request = run loadFixture(${nativeFixtureIds.postHandshakeCertificateRequestRecord})
  let code = run feedAll(&mut client, Bytes.asSlice(&request))
  return code == 41 && isFailureCode(run client.progress(), 41)
}

effect fn cases() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let master = run rootTrust()
  let mut random = ScriptedRandom {filled: 0}
  let mut id = 0
  while id <= 9 {
    random.filled = usize.ZERO
    let passed = run closureControlCase(id, &master)
      |> Effect.provideMut<Random>(&mut random)
    if !passed || random.filled != 64 { return id + 1 }
    id = id + 1
  }
  return 42
}
`

const tlsClientResourcePolicyCases = `${tlsClientNativeCommon}
struct CountingAllocator {calls: usize}

effect fn allocate(self: &mut CountingAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  self.calls = self.calls + usize.ONE
  let mut system = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut<Allocator>(&mut system)
}

impl Allocator for CountingAllocator {allocate: CountingAllocator.allocate}

effect fn limitsCase<'a>(
  id: i32,
  master: &TrustSnapshot,
  acceptedBoundary: &'a [AlpnProtocol<'a>],
  rejectedBoundary: &'a [AlpnProtocol<'a>],
) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let host = b"ExAmPlE.com"
  let mut limits = ClientLimits.defaults()
  if id == 1 { limits.handshakeBodyBytes = usize.ONE }
  if id == 3 { limits.certificateDecode.nodes = usize.ZERO }
  if id == 4 { limits.sanDecode.identities = 257 }
  if id == 5 { limits.identity.maxSanBytes = usize.ZERO }
  if id == 6 { limits.path.signatureVerifications = usize.ZERO }
  if id == 7 { limits.path.profile.nodes = usize.ZERO }
  if id == 8 { limits.cookieBytes = 65535 }
  if id == 9 { limits.handshakeBodyBytes = usize.MAX }
  if id == 10 { limits.handshakeMessages = usize.ONE }
  if id == 11 { limits.peerCertificates = usize.ONE }
  if id == 12 { limits.certificateBytes = ${rsaCertificateBytes - 1} }
  if id == 13 { limits.certificateTotalBytes = ${rsaCertificateTotalBytes - 1} }
  if id == 14 { limits.extensionBytes = ${serverHelloExtensionLength - 1} }
  if id == 15 { limits.cookieBytes = ${retryCookieLength - 1} }
  if id == 16 { limits.emptyRecords = usize.ONE }
  if id == 17 { limits.handshakeBytes = ${rsaHandshakeBytes - 1} }
  if id == 20 { limits.tickets = usize.ONE }
  if id == 21 { limits.ticketBytes = ${validTicketMessage.length} }
  if id == 22 { limits.postHandshakeControls = usize.ONE }
  if id == 23 {
    limits.handshakeBodyBytes = ${rsaHandshakeBodyBytes - 1}
    limits.cookieBytes = ${rsaExactBoundaryCookieBytes - 1}
  }
  if id == 19 {
    limits.handshakeBodyBytes = ${rsaHandshakeBodyBytes}
    limits.cookieBytes = ${rsaExactBoundaryCookieBytes}
    limits.handshakeBytes = ${rsaHandshakeBytes}
    limits.handshakeMessages = ${rsaHandshakeMessages}
    limits.peerCertificates = ${capturedRsaChain.length}
    limits.certificateBytes = ${rsaCertificateBytes}
    limits.certificateTotalBytes = ${rsaCertificateTotalBytes}
    limits.extensionBytes = ${rsaExtensionBytes}
  }
  let mut selectedAlpn = AlpnConfig.defaults()
  if id == 2 {
    selectedAlpn = AlpnConfig.Offered {protocols: rejectedBoundary, required: false}
  } else if id == 18 {
    selectedAlpn = AlpnConfig.Offered {protocols: acceptedBoundary, required: false}
  }
  let mut seconds: i64 = 1789156800
  if id == 0 { seconds = 253402300800 }
  let constructorFailure = id <= 9
  let made = run makeClient(
    master,
    !constructorFailure,
    reference(&host),
    selectedAlpn,
    limits,
    seconds,
  )
  if id == 0 { return isInvalidTime(move made) }
  if id == 1 {
    return invalidLimit(move made, TlsLimitKind.HandshakeBodyBytes, usize.ONE)
  }
  if id == 2 { return invalidLimit(move made, TlsLimitKind.Alpn, 1024) }
  if id == 3 {
    return invalidLimit(move made, TlsLimitKind.CertificateDecode, usize.ZERO)
  }
  if id == 4 {
    return invalidLimit(move made, TlsLimitKind.CertificateSanDecode, 257)
  }
  if id == 5 {
    return invalidLimit(move made, TlsLimitKind.CertificateIdentity, usize.ZERO)
  }
  if id == 6 {
    return invalidLimit(move made, TlsLimitKind.CertificatePath, usize.ZERO)
  }
  if id == 7 {
    return invalidLimit(move made, TlsLimitKind.CertificateProfile, usize.ZERO)
  }
  if id == 8 { return invalidLimit(move made, TlsLimitKind.CookieBytes, 65535) }
  if id == 9 { return invalidLimit(move made, TlsLimitKind.HandshakeBodyBytes, usize.MAX) }
  let mut client = match move made {
    Result<Client, TlsError>.Success {value} => move value
    Result<Client, TlsError>.Failure {error} => { return false }
  }
  if id == 18 { return true }
  if !(run matchesHello(&client, ${nativeFixtureIds.clientHello})) { return false }
  let helloLength = client.pendingOutput().length
  drop client.ackWritten(helloLength)
  if id == 19 {
    let exactFlight = run loadFixture(${nativeFixtureIds.serverFlight})
    return run authenticateWithinLimits(&mut client, Bytes.asSlice(&exactFlight))
  }
  if id >= 20 && id <= 22 {
    let exactFlight = run loadFixture(${nativeFixtureIds.serverFlight})
    if !(run authenticateWithinLimits(&mut client, Bytes.asSlice(&exactFlight))) { return false }
    let mut plaintext: [u8; 40] = [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]
    let read = client.readPlaintext(&mut plaintext)
    let written = match move read {
      Result<Progress, TlsError>.Success {value} => value.written
      Result<Progress, TlsError>.Failure {error} => usize.ZERO
    }
    if !validPlaintext(&plaintext, written) { return false }
    let first = run loadFixture(${nativeFixtureIds.validTicketRecord1})
    if !(run feedComplete(&mut client, Bytes.asSlice(&first), usize.ONE)) { return false }
    let second = run loadFixture(${nativeFixtureIds.validTicketRecord2})
    let mut kind = TlsLimitKind.TicketBytes
    let mut limit: usize = ${validTicketMessage.length}
    if id == 20 {
      kind = TlsLimitKind.Tickets
      limit = usize.ONE
    } else if id == 22 {
      kind = TlsLimitKind.PostHandshakeControls
      limit = usize.ONE
    }
    return run feedExpectedLimit(&mut client, Bytes.asSlice(&second), kind, limit)
  }
  if id == 15 {
    let retry = run loadFixture(${nativeFixtureIds.cookieRetry})
    return run feedExpectedLimit(
      &mut client,
      Bytes.asSlice(&retry),
      TlsLimitKind.CookieBytes,
      ${retryCookieLength - 1},
    )
  }
  if id == 16 {
    let ccs = run loadFixture(${nativeFixtureIds.validCcs})
    if !(run feedComplete(&mut client, Bytes.asSlice(&ccs), 8)) { return false }
    return run feedExpectedLimit(
      &mut client,
      Bytes.asSlice(&ccs),
      TlsLimitKind.EmptyRecords,
      usize.ONE,
    )
  }
  let flight = run loadFixture(${nativeFixtureIds.serverFlight})
  if id == 10 {
    return run feedExpectedLimit(
      &mut client,
      Bytes.asSlice(&flight),
      TlsLimitKind.HandshakeMessages,
      usize.ONE,
    )
  }
  if id == 23 {
    return run feedExpectedLimit(
      &mut client,
      Bytes.asSlice(&flight),
      TlsLimitKind.HandshakeBodyBytes,
      ${rsaHandshakeBodyBytes - 1},
    )
  }
  if id == 11 {
    return run feedExpectedLimit(
      &mut client,
      Bytes.asSlice(&flight),
      TlsLimitKind.PeerCertificates,
      usize.ONE,
    )
  }
  if id == 12 {
    return run feedExpectedLimit(
      &mut client,
      Bytes.asSlice(&flight),
      TlsLimitKind.CertificateBytes,
      ${rsaCertificateBytes - 1},
    )
  }
  if id == 13 {
    return run feedExpectedLimit(
      &mut client,
      Bytes.asSlice(&flight),
      TlsLimitKind.CertificateTotalBytes,
      ${rsaCertificateTotalBytes - 1},
    )
  }
  if id == 14 {
    return run feedExpectedLimit(
      &mut client,
      Bytes.asSlice(&flight),
      TlsLimitKind.ExtensionBytes,
      ${serverHelloExtensionLength - 1},
    )
  }
  return run feedExpectedLimit(
    &mut client,
    Bytes.asSlice(&flight),
    TlsLimitKind.HandshakeBytes,
    ${rsaHandshakeBytes - 1},
  )
}

effect fn feedComplete(client: &mut Client, input: &[u8], steps: usize) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  let outcome = run feedOutcome(&mut client.*, input, steps)
  return match move outcome {
    FeedOutcome.Complete => true
    FeedOutcome.Stalled => false
    FeedOutcome.Failure {error} => false
  }
}

effect fn authenticateWithinLimits(client: &mut Client, flight: &[u8]) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  if !(run feedComplete(&mut client.*, flight, 8)) { return false }
  let mut steps = usize.ZERO
  while steps < 3 {
    let length = client.pendingOutput().length
    if length == 0 { return false }
    let acknowledged = Client.ackWritten(&mut client.*, length)
    if let Result<Progress, TlsError>.Success {value} = move acknowledged {
      if value.demand == Demand.Authenticated { return true }
    }
    steps = steps + usize.ONE
  }
  return false
}

effect fn runLimitCase<'a>(
  id: i32,
  master: &TrustSnapshot,
  accepted: &'a [AlpnProtocol<'a>],
  rejected: &'a [AlpnProtocol<'a>],
  audit: &mut CountingAllocator,
) -> bool
! OutOfMemoryError
? &mut Allocator | &mut Random {
  if id <= 9 {
    return run limitsCase(id, master, accepted, rejected)
      |> Effect.provideMut<Allocator>(audit)
  }
  return run limitsCase(id, master, accepted, rejected)
}

effect fn cases() -> i32
! OutOfMemoryError
? &mut Allocator {
  let boundaryOwner = run loadFixture(${nativeFixtureIds.alpnBoundaryBytes})
  let boundaries = alpnBoundaries(Bytes.asSlice(&boundaryOwner))
  let master = run rootTrust()
  let mut random = ScriptedRandom {filled: 0}
  let mut allocationAudit = CountingAllocator {calls: usize.ZERO}
  let mut id = 0
  while id <= 23 {
    random.filled = usize.ZERO
    allocationAudit.calls = usize.ZERO
    let passed = run runLimitCase(
      id,
      &master,
      &boundaries.accepted,
      &boundaries.rejected,
      &mut allocationAudit,
    ) |> Effect.provideMut<Random>(&mut random)
    if id <= 9 && !(allocationAudit.calls == usize.ZERO) { return id + 101 }
    let mut expectedEntropy: usize = 64
    if id <= 9 { expectedEntropy = usize.ZERO }
    if !passed || random.filled != expectedEntropy { return id + 1 }
    id = id + 1
  }
  return 42
}
`

const tlsClientResourcePolicyMain = `// TLS_CLIENT_MAIN_BEGIN
struct AlpnBoundaries<'a> {
  accepted: [AlpnProtocol<'a>; 4]
  rejected: [AlpnProtocol<'a>; 5]
}

fn alpnBoundaries<'a>(bytes: &'a [u8]) -> AlpnBoundaries<'a> {
  let one: &'a [u8] = Slice.view<u8>(bytes, 0, 255)
  let two: &'a [u8] = Slice.view<u8>(bytes, 255, 255)
  let three: &'a [u8] = Slice.view<u8>(bytes, 510, 255)
  let four: &'a [u8] = Slice.view<u8>(bytes, 765, 255)
  let five: &'a [u8] = Slice.view<u8>(bytes, 1020, 255)
  let rejectedFour: &'a [u8] = Slice.view<u8>(four, 0, 251)
  let rejectedFive: &'a [u8] = Slice.view<u8>(five, 0, 4)
  let accepted: [AlpnProtocol<'a>; 4] = [
    AlpnProtocol<'a> {bytes: one},
    AlpnProtocol<'a> {bytes: two},
    AlpnProtocol<'a> {bytes: three},
    AlpnProtocol<'a> {bytes: four},
  ]
  let rejected: [AlpnProtocol<'a>; 5] = [
    AlpnProtocol<'a> {bytes: one},
    AlpnProtocol<'a> {bytes: two},
    AlpnProtocol<'a> {bytes: three},
    AlpnProtocol<'a> {bytes: rejectedFour},
    AlpnProtocol<'a> {bytes: rejectedFive},
  ]
  return AlpnBoundaries<'a> {accepted: accepted, rejected: rejected}
}

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(cases(), recover)
    |> Effect.provideMut<Allocator>(&mut allocator)
}
// TLS_CLIENT_MAIN_END`

const tlsClientCoreMain = `// TLS_CLIENT_MAIN_BEGIN
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(cases(), recover)
    |> Effect.provideMut<Allocator>(&mut allocator)
}
// TLS_CLIENT_MAIN_END`

const tlsClientSimpleMain = `// TLS_CLIENT_MAIN_BEGIN
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  let h2 = b"h2"
  let protocols = [alpnProtocol(&h2)]
  return run Effect.catchAll(cases(&protocols), recover)
    |> Effect.provideMut<Allocator>(&mut allocator)
}
// TLS_CLIENT_MAIN_END`

const nativeFixtureSupport = `import silk.bytes {Bytes}
import silk.pointer {Pointer}

unsafe extern "C" fn silk_tls_fixture_size(id: i32) -> usize
unsafe extern "C" fn silk_tls_fixture_copy(
  id: i32,
  output: ?[*]mut u8,
  capacity: usize,
) -> usize with Intrinsic.foreign(noCapture: ("output",))
effect fn loadFixture(id: i32) -> Bytes ! OutOfMemoryError ? &mut Allocator {
  let length = unsafe silk_tls_fixture_size(id)
  let mut bytes = run Bytes.zeroed(length)
  let copied = unsafe silk_tls_fixture_copy(id, Pointer.fromMutSlice(Bytes.asMutSlice(&mut bytes)), length)
  if copied != length { return Bytes.make() }
  return move bytes
}

`

const replaceExactlyOnce = (source: string, search: string, replacement: string): string => {
  const first = source.indexOf(search)
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`expected one TLS source marker: ${search.slice(0, 48)}`)
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`
}

const replaceMarkerBlock = (source: string, marker: string, replacement: string): string => {
  const begin = `// ${marker}_BEGIN`
  const end = `// ${marker}_END`
  const start = source.indexOf(begin)
  const finish = source.indexOf(end, start + begin.length)
  if (
    start < 0 ||
    finish < 0 ||
    source.indexOf(begin, start + begin.length) >= 0 ||
    source.indexOf(end, finish + end.length) >= 0
  ) {
    throw new Error(`expected one TLS source marker block: ${marker}`)
  }
  return `${source.slice(0, start)}${replacement}${source.slice(finish + end.length)}`
}

let tlsClientWasm = replaceMarkerBlock(
  tlsClientSourceTemplate,
  'TLS_CLIENT_CASES',
  `// TLS_CLIENT_CASES_BEGIN\n${tlsClientWasmCases}// TLS_CLIENT_CASES_END`,
)
tlsClientWasm = replaceMarkerBlock(tlsClientWasm, 'TLS_CLIENT_NATIVE_HELPERS', '')
tlsClientWasm = replaceMarkerBlock(tlsClientWasm, 'TLS_CLIENT_NATIVE_EMPTY_TRUST', '')
tlsClientWasm = replaceMarkerBlock(tlsClientWasm, 'TLS_CLIENT_NATIVE_LIMIT_HELPER', '')
tlsClientWasm = replaceMarkerBlock(tlsClientWasm, 'TLS_CLIENT_WASM_EXPECTATIONS', '')
export const tlsClientWasmSource = tlsClientWasm

const composeNative = (cases: string, main: string): string => {
  let source = replaceExactlyOnce(
    tlsClientSourceTemplate,
    'import silk.effect {Effect}\n',
    `import silk.effect {Effect}\n${nativeFixtureSupport}`,
  )
  source = replaceMarkerBlock(
    source,
    'TLS_CLIENT_CASES',
    `// TLS_CLIENT_CASES_BEGIN\n${cases}// TLS_CLIENT_CASES_END`,
  )
  source = replaceMarkerBlock(source, 'TLS_CLIENT_MAIN', main)
  source = replaceMarkerBlock(source, 'TLS_CLIENT_WASM_DEFAULTS', '')
  source = replaceMarkerBlock(source, 'TLS_CLIENT_WASM_EXPECTATIONS', '')
  source = replaceExactlyOnce(
    source,
    `let pem = ${silkBytes(rootPem)}`,
    `let pemOwner = run loadFixture(${nativeFixtureIds.rootPem})
  if Bytes.length(&pemOwner) != ${rootPem.length} {
    let invalid = 1 / 0
    return run rootTrust()
  }
  let pem = Bytes.asSlice(&pemOwner)`,
  )
  return source
}

const focusedBaseFunctions = [
  'emptyTrust',
  'hasBytes',
  'isNeedOutput',
  'isNeedInput',
  'hasDemand',
  'isPrematureWrite',
  'isPrematureRead',
  'isTruncated',
  'isFailureCode',
  'isInvalidTime',
  'validAes128Authentication',
  'invalidLimit',
  'exactPeerAlert',
  'exactLimitFailure',
  'exactLimitError',
  'sameBytes',
  'protocolFailureCode',
  'feedFailureCode',
  'alpnProtocol',
  'feedOutcome',
  'feedAll',
  'feedExpectedLimit',
  'authenticate',
] as const

const removeTopLevelFunction = (source: string, name: string): string => {
  const pattern = new RegExp(`^(?:pub )?(?:effect )?fn ${name}(?:<|\\()`, 'm')
  const match = pattern.exec(source)
  if (match === null) throw new Error(`missing focused TLS helper ${name}`)
  const body = source.indexOf('{', match.index)
  if (body < 0) throw new Error(`missing focused TLS helper body ${name}`)
  let depth = 0
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        let end = index + 1
        while (source[end] === '\n') end += 1
        return `${source.slice(0, match.index)}${source.slice(end)}`
      }
    }
  }
  throw new Error(`unterminated focused TLS helper ${name}`)
}

const composeFocusedNative = (
  cases: string,
  main: string,
  helpers: ReadonlySet<(typeof focusedBaseFunctions)[number]>,
  omittedCaseFunctions: ReadonlyArray<string> = [],
): string => {
  let source = composeNative(cases, main)
  for (const helper of focusedBaseFunctions) {
    if (!helpers.has(helper)) source = removeTopLevelFunction(source, helper)
  }
  for (const helper of omittedCaseFunctions) source = removeTopLevelFunction(source, helper)
  return source
}

export const tlsClientCoreNativeSource = composeNative(tlsClientCoreCases, tlsClientCoreMain)
export const tlsClientDemandRequestNativeSource = composeFocusedNative(
  tlsClientDemandRequestCases,
  tlsClientSimpleMain,
  new Set([
    'emptyTrust',
    'isNeedInput',
    'isFailureCode',
    'sameBytes',
    'protocolFailureCode',
    'feedFailureCode',
    'alpnProtocol',
    'feedOutcome',
    'feedAll',
    'authenticate',
  ]),
  ['scenarioReference', 'feedFragments', 'authenticateFragments'],
)
export const tlsClientKeyUpdateNativeSource = composeFocusedNative(
  tlsClientKeyUpdateCases,
  tlsClientCoreMain,
  new Set([
    'emptyTrust',
    'isNeedOutput',
    'isNeedInput',
    'hasDemand',
    'isFailureCode',
    'sameBytes',
    'protocolFailureCode',
    'feedFailureCode',
    'feedOutcome',
    'feedAll',
    'authenticate',
  ]),
  ['scenarioReference', 'authenticateFragments'],
)
export const tlsClientClosureControlNativeSource = composeFocusedNative(
  tlsClientClosureControlCases,
  tlsClientCoreMain,
  new Set([
    'emptyTrust',
    'isNeedOutput',
    'hasDemand',
    'isPrematureWrite',
    'isTruncated',
    'isFailureCode',
    'exactPeerAlert',
    'sameBytes',
    'protocolFailureCode',
    'feedFailureCode',
    'feedOutcome',
    'feedAll',
    'authenticate',
  ]),
  ['scenarioReference', 'feedFragments', 'authenticateFragments'],
)
export const tlsClientHandshakePolicyNativeSource = composeFocusedNative(
  tlsClientHandshakePolicyCases,
  tlsClientSimpleMain,
  new Set([
    'emptyTrust',
    'hasDemand',
    'isFailureCode',
    'validAes128Authentication',
    'sameBytes',
    'protocolFailureCode',
    'feedFailureCode',
    'alpnProtocol',
    'feedOutcome',
    'feedAll',
    'authenticate',
  ]),
  ['validPlaintext', 'feedFragments', 'authenticateFragments'],
)
export const tlsClientResourcePolicyNativeSource = composeFocusedNative(
  tlsClientResourcePolicyCases,
  tlsClientResourcePolicyMain,
  new Set([
    'emptyTrust',
    'isInvalidTime',
    'invalidLimit',
    'exactLimitFailure',
    'exactLimitError',
    'feedOutcome',
    'feedExpectedLimit',
  ]),
  ['scenarioReference', 'feedFragments', 'authenticateFragments'],
)
export const tlsClientNativeOnlySource = `pub fn main() -> i32 { return 42 }`
export const tlsClientAcceptanceSource = tlsClientWasmSource
