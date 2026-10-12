import fixtures from '../fixtures/certificate-profile-limbo.json' with { type: 'json' }
import { certificateUniqueIdsDer } from './certificateAcceptance.js'

const literal = (base64: string): string => {
  const bytes = Buffer.from(base64, 'base64')
  return `b"${Array.from(bytes, (byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`
}

const fixture = (id: string): string => {
  const selected = fixtures.fixtures.find((candidate) => candidate.id === id)
  if (selected === undefined) throw new Error(`Missing certificate-profile fixture ${id}`)
  return literal(selected.der)
}

const fixtureBytes = (id: string): Buffer => {
  const selected = fixtures.fixtures.find((candidate) => candidate.id === id)
  if (selected === undefined) throw new Error(`Missing certificate-profile fixture ${id}`)
  return Buffer.from(selected.der, 'base64')
}

interface DerNode {
  readonly start: number
  readonly content: number
  readonly end: number
  readonly lengthOctets: number
  readonly tag: number
}

const derNode = (bytes: Buffer, start: number): DerNode => {
  const tag = bytes[start]
  const firstLength = bytes[start + 1]
  if (tag === undefined || firstLength === undefined) throw new Error('Truncated DER node')
  const lengthOctets = (firstLength & 0x80) === 0 ? 0 : firstLength & 0x7f
  if (lengthOctets > 4) throw new Error('Unsupported fixture DER length width')
  let length = (firstLength & 0x80) === 0 ? firstLength : 0
  for (let index = 0; index < lengthOctets; index += 1) {
    const octet = bytes[start + 2 + index]
    if (octet === undefined) throw new Error('Truncated fixture DER length')
    length = length * 256 + octet
  }
  const content = start + 2 + lengthOctets
  const end = content + length
  if (end > bytes.length) throw new Error('Fixture DER node escapes its input')
  return { start, content, end, lengthOctets, tag }
}

const rebuildDerNode = (
  bytes: Buffer,
  node: DerNode,
  targetStart: number,
  targetEnd: number,
  replacement: Buffer,
): Buffer => {
  if (node.start === targetStart && node.end === targetEnd) return replacement
  if (targetStart < node.content || targetEnd > node.end || (node.tag & 0x20) === 0) {
    throw new Error('Replacement target is not a complete constructed DER child')
  }
  const children: Array<Buffer> = []
  let childStart = node.content
  let replaced = false
  while (childStart < node.end) {
    const child = derNode(bytes, childStart)
    if (targetStart >= child.start && targetEnd <= child.end) {
      children.push(rebuildDerNode(bytes, child, targetStart, targetEnd, replacement))
      replaced = true
    } else {
      children.push(bytes.subarray(child.start, child.end))
    }
    childStart = child.end
  }
  if (childStart !== node.end || !replaced) {
    throw new Error('Replacement target is not in the fixture DER tree')
  }
  const content = Buffer.concat(children)
  return Buffer.concat([Buffer.from([node.tag, ...derLength(content.length)]), content])
}

const replaceDerNodeAt = (
  bytes: Buffer,
  target: DerNode,
  replacement: ReadonlyArray<number>,
): Buffer =>
  rebuildDerNode(bytes, derNode(bytes, 0), target.start, target.end, Buffer.from(replacement))

const withEmptySubject = (bytes: Buffer, id: string): Buffer => {
  const certificate = derNode(bytes, 0)
  const tbs = derNode(bytes, certificate.content)
  let at = tbs.content
  let child = derNode(bytes, at)
  if (child.tag === 0xa0) {
    at = child.end
  }
  // Skip serial, signature, issuer, and validity to reach the subject Name.
  for (let index = 0; index < 4; index += 1) {
    child = derNode(bytes, at)
    at = child.end
  }
  const subject = derNode(bytes, at)
  if (subject.tag !== 0x30) throw new Error(`Unexpected subject Name in ${id}`)
  return replaceDerNodeAt(bytes, subject, [0x30, 0x00])
}

const rewriteDerNodes = (
  input: Buffer,
  id: string,
  needle: ArrayLike<number>,
  replacement: ArrayLike<number>,
  count: number,
): Buffer => {
  const selected = Buffer.from(needle)
  let bytes: Buffer = Buffer.from(input)
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const offset = bytes.indexOf(selected)
    if (offset < 0) throw new Error(`Missing DER replacement ${ordinal} in ${id}`)
    const target = derNode(bytes, offset)
    if (target.end !== offset + selected.length)
      throw new Error(`Replacement is not one DER node in ${id}`)
    const replacementBytes = Buffer.from(replacement)
    bytes = rebuildDerNode(bytes, derNode(bytes, 0), offset, target.end, replacementBytes)
  }
  if (bytes.indexOf(selected) >= 0) throw new Error(`Unexpected extra DER replacement in ${id}`)
  return bytes
}

const replaceDerNodes = (
  id: string,
  needle: ArrayLike<number>,
  replacement: ArrayLike<number>,
  count: number,
): string => {
  const bytes = rewriteDerNodes(fixtureBytes(id), id, needle, replacement, count)
  return literal(bytes.toString('base64'))
}

const removeContainingNode = (
  input: Buffer,
  id: string,
  needle: ArrayLike<number>,
  tag: number,
): Buffer => {
  const offset = input.indexOf(Buffer.from(needle))
  if (offset < 0) throw new Error(`Missing contained DER value in ${id}`)
  let selected: DerNode | undefined
  const find = (node: DerNode): void => {
    if (offset < node.content || offset + needle.length > node.end) return
    if (node.tag === tag) selected = node
    if ((node.tag & 0x20) === 0) return
    let childStart = node.content
    while (childStart < node.end) {
      const child = derNode(input, childStart)
      find(child)
      childStart = child.end
    }
  }
  find(derNode(input, 0))
  if (selected === undefined) throw new Error(`Missing containing DER tag ${tag} in ${id}`)
  return rewriteDerNodes(input, id, input.subarray(selected.start, selected.end), [], 1)
}

const derLength = (length: number): Array<number> => {
  if (length < 128) return [length]
  if (length < 256) return [0x81, length]
  if (length < 65536) return [0x82, Math.floor(length / 256), length & 0xff]
  throw new Error('Generated fixture DER value is too long')
}

const derTlv = (tag: number, content: ReadonlyArray<number>): Array<number> => [
  tag,
  ...derLength(content.length),
  ...content,
]

const sanExtension = (
  tag: number,
  payload: ReadonlyArray<number>,
  critical: boolean,
): Array<number> => {
  const oid = [0x06, 0x03, 0x55, 0x1d, 0x11]
  const names = derTlv(0x30, derTlv(tag, payload))
  return derTlv(0x30, [...oid, ...(critical ? [0x01, 0x01, 0xff] : []), ...derTlv(0x04, names)])
}

const mutateUnique = (
  id: string,
  needle: ReadonlyArray<number>,
  mutate: (bytes: Buffer, offset: number) => void,
): string => {
  const bytes = fixtureBytes(id)
  const found: Array<number> = []
  for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    if (needle.every((value, index) => bytes[offset + index] === value)) found.push(offset)
  }
  if (found.length !== 1) {
    throw new Error(`Expected one ${id} mutation site, found ${found.length}`)
  }
  const offset = found[0]
  if (offset === undefined) throw new Error(`Missing ${id} mutation offset`)
  mutate(bytes, offset)
  return literal(bytes.toString('base64'))
}

const mutateOccurrence = (
  id: string,
  needle: ReadonlyArray<number>,
  ordinal: number,
  relativeOffset: number,
  value: number,
): string => {
  const bytes = fixtureBytes(id)
  const selected = Buffer.from(needle)
  let offset = -1
  for (let index = 0; index <= ordinal; index += 1) {
    offset = bytes.indexOf(selected, offset + 1)
    if (offset < 0) throw new Error(`Missing mutation occurrence ${ordinal} in ${id}`)
  }
  bytes[offset + relativeOffset] = value
  return literal(bytes.toString('base64'))
}

const mutateFinalBitStringUnused = (id: string): string => {
  const bytes = fixtureBytes(id)
  for (let offset = bytes.length - 1; offset >= 0; offset -= 1) {
    if (bytes[offset] !== 0x03) continue
    const firstLength = bytes[offset + 1]
    if (firstLength === undefined) continue
    const lengthOctets = (firstLength & 0x80) === 0 ? 0 : firstLength & 0x7f
    let length = (firstLength & 0x80) === 0 ? firstLength : 0
    for (let index = 0; index < lengthOctets; index += 1) {
      const octet = bytes[offset + 2 + index]
      if (octet === undefined) throw new Error(`Truncated final BIT STRING in ${id}`)
      length = length * 256 + octet
    }
    const headerLength = 2 + lengthOctets
    if (offset + headerLength + length !== bytes.length || length === 0) continue
    const finalOctet = bytes.at(-1)
    if (finalOctet === undefined) throw new Error(`Missing final BIT STRING payload in ${id}`)
    bytes[offset + headerLength] = 1
    bytes[bytes.length - 1] = finalOctet & 0xfe
    return literal(bytes.toString('base64'))
  }
  throw new Error(`Missing final BIT STRING in ${id}`)
}

const mismatchOuterSignatureAlgorithm = (id: string): string => {
  const bytes = fixtureBytes(id)
  const ecdsaSha256 = Buffer.from([
    0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02,
  ])
  const rsaPkcs1Sha256 = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
  ])
  const first = bytes.indexOf(ecdsaSha256)
  const second = bytes.indexOf(ecdsaSha256, first + 1)
  if (first < 0 || second < 0 || bytes.indexOf(ecdsaSha256, second + 1) >= 0) {
    throw new Error(`Expected exactly two ECDSA signature algorithms in ${id}`)
  }
  if (bytes[0] !== 0x30 || bytes[1] !== 0x82 || bytes.readUInt16BE(2) !== bytes.length - 4) {
    throw new Error(`Unexpected certificate envelope in ${id}`)
  }
  const result = Buffer.concat([
    bytes.subarray(0, second),
    rsaPkcs1Sha256,
    bytes.subarray(second + ecdsaSha256.length),
  ])
  result.writeUInt16BE(result.length - 4, 2)
  return literal(result.toString('base64'))
}

const leaf = fixture('rfc5280::no-keyusage/peer_certificate')
const root = fixture('rfc5280::no-keyusage/trusted_certs[0]')
const zeroSerial = fixture('rfc5280::serial::zero/peer_certificate')
const wrongEku = fixture('rfc5280::eku::ee-wrong-eku/peer_certificate')
const wildcardConstraint = fixture('rfc5280::nc::invalid-dnsname-wildcard/trusted_certs[0]')
const constrainedRoot = fixture('rfc5280::nc::permitted-dns-match/trusted_certs[0]')
// The explicit `02 01 00` pathLenConstraint is legal DER and must remain distinguishable from an
// absent bound. Its pinned upstream bytes and digest live in certificate-profile-limbo.json.
const pathLengthZeroIntermediate = fixture(
  'pathlen::ee-with-intermediate-pathlen-0/untrusted_intermediates[0]',
)
const rsaLeafId = 'webpki::cryptographydotio-chain/peer_certificate'
const rsaLeaf = fixture(rsaLeafId)
const rsaEncryptionNull = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]
const rsaEncryptionAbsent = [
  0x30, 0x0b, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
]
const rsaPkcs1Null = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
]
const rsaPkcs1Absent = [
  0x30, 0x0b, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
]
const rsaPssSha256 = [
  0x30, 0x41, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a, 0x30, 0x34, 0xa0,
  0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00,
  0xa1, 0x1c, 0x30, 0x1a, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30,
  0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0xa2, 0x03,
  0x02, 0x01, 0x20,
]
const rsaPssDefaults = [
  0x30, 0x0b, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a,
]
const rsaPssBadSalt = rsaPssSha256.map((value, index) =>
  index === rsaPssSha256.length - 1 ? 0x1f : value,
)
const rsaSpkiAbsent = replaceDerNodes(rsaLeafId, rsaEncryptionNull, rsaEncryptionAbsent, 1)
const rsaSignatureAbsent = replaceDerNodes(rsaLeafId, rsaPkcs1Null, rsaPkcs1Absent, 2)
const rsaPss = replaceDerNodes(rsaLeafId, rsaPkcs1Null, rsaPssSha256, 2)
const rsaPssMissingParameters = replaceDerNodes(rsaLeafId, rsaPkcs1Null, rsaPssDefaults, 2)
const rsaPssBadParameters = replaceDerNodes(rsaLeafId, rsaPkcs1Null, rsaPssBadSalt, 2)
const versionTwo = literal(Buffer.from(certificateUniqueIdsDer).toString('base64'))
const uniqueIds = (() => {
  const bytes = Buffer.from(certificateUniqueIdsDer)
  bytes[8] = 2
  return literal(bytes.toString('base64'))
})()
const wrongCurve = mutateUnique(
  'rfc5280::no-keyusage/peer_certificate',
  [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
  (bytes, offset) => {
    bytes[offset + 9] = 8
  },
)
const invalidPoint = mutateUnique(
  'rfc5280::no-keyusage/peer_certificate',
  [0x03, 0x42, 0x00, 0x04],
  (bytes, offset) => {
    bytes[offset + 3] = 2
  },
)
const ecdsaSha256Identifier = [
  0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02,
]
const ecdsaSha256WithNull = [
  0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02, 0x05, 0x00,
]
const ecdsaForbiddenParameters = replaceDerNodes(
  'rfc5280::no-keyusage/peer_certificate',
  ecdsaSha256Identifier,
  ecdsaSha256WithNull,
  2,
)
const innerUnknownSignatureAlgorithm = mutateOccurrence(
  'rfc5280::no-keyusage/peer_certificate',
  ecdsaSha256Identifier,
  0,
  11,
  0x7f,
)
const outerUnknownSignatureAlgorithm = mutateOccurrence(
  'rfc5280::no-keyusage/peer_certificate',
  ecdsaSha256Identifier,
  1,
  11,
  0x7f,
)
const missingCaKeyUsage = mutateUnique(
  'rfc5280::no-keyusage/trusted_certs[0]',
  [0x04, 0x04, 0x03, 0x02, 0x01, 0x06],
  (bytes, offset) => {
    bytes[offset + 4] = 7
    bytes[offset + 5] = 0x80
  },
)
const originalSanExtension = sanExtension(
  0x82,
  Array.from(Buffer.from('example.com', 'ascii')),
  false,
)
const emptyCriticalSanExtension = derTlv(0x30, [
  0x06,
  0x03,
  0x55,
  0x1d,
  0x11,
  0x01,
  0x01,
  0xff,
  ...derTlv(0x04, derTlv(0x30, [])),
])
const emptySubjectMissingSan = (() => {
  const id = 'rfc5280::no-keyusage/peer_certificate'
  const withoutSan = rewriteDerNodes(fixtureBytes(id), id, originalSanExtension, [], 1)
  return literal(withEmptySubject(withoutSan, id).toString('base64'))
})()
const emptySubjectNoncriticalSan = (() => {
  const id = 'rfc5280::no-keyusage/peer_certificate'
  return literal(withEmptySubject(fixtureBytes(id), id).toString('base64'))
})()
const emptySubjectEmptyCriticalSan = (() => {
  const id = 'rfc5280::no-keyusage/peer_certificate'
  const withEmptySan = rewriteDerNodes(
    fixtureBytes(id),
    id,
    originalSanExtension,
    emptyCriticalSanExtension,
    1,
  )
  return literal(withEmptySubject(withEmptySan, id).toString('base64'))
})()
const nonemptySubjectEmptyCriticalSan = replaceDerNodes(
  'rfc5280::no-keyusage/peer_certificate',
  originalSanExtension,
  emptyCriticalSanExtension,
  1,
)
const unsupportedCriticalSan = replaceDerNodes(
  'rfc5280::no-keyusage/trusted_certs[0]',
  originalSanExtension,
  sanExtension(0x81, [0x61], true),
  1,
)
const numericSan = replaceDerNodes(
  'rfc5280::no-keyusage/peer_certificate',
  originalSanExtension,
  sanExtension(0x82, Array.from(Buffer.from('example.123', 'ascii')), false),
  1,
)
const wildcard254Name = Array.from(
  Buffer.from(`*.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(62)}.${'d'.repeat(61)}`, 'ascii'),
)
if (wildcard254Name.length !== 254) throw new Error('Wildcard regression must be 254 octets')
const oversizedWildcardSan = replaceDerNodes(
  'rfc5280::no-keyusage/peer_certificate',
  originalSanExtension,
  sanExtension(0x82, wildcard254Name, false),
  1,
)
const invalidIpSan = replaceDerNodes(
  'rfc5280::no-keyusage/peer_certificate',
  originalSanExtension,
  sanExtension(0x87, [192, 0, 2, 1, 0], false),
  1,
)
const validIpSan = replaceDerNodes(
  'rfc5280::no-keyusage/peer_certificate',
  originalSanExtension,
  sanExtension(0x87, [192, 0, 2, 1], false),
  1,
)
const policyProcessing = mutateUnique(
  'rfc5280::no-keyusage/trusted_certs[0]',
  [0x06, 0x03, 0x55, 0x1d, 0x13],
  (bytes, offset) => {
    bytes[offset + 4] = 0x20
  },
)
const tlsFeature = mutateUnique(
  rsaLeafId,
  [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01],
  (bytes, offset) => {
    bytes[offset + 9] = 0x18
  },
)
const unpairedAkiSerial = mutateUnique(
  'rfc5280::no-keyusage/peer_certificate',
  [0x30, 0x16, 0x80, 0x14],
  (bytes, offset) => {
    bytes[offset + 2] = 0x82
    bytes[offset + 4] = 1
  },
)
const v1Anchor = (() => {
  const id = 'rfc5280::no-keyusage/trusted_certs[0]'
  let bytes = rewriteDerNodes(fixtureBytes(id), id, [0xa0, 0x03, 0x02, 0x01, 0x02], [], 1)
  bytes = removeContainingNode(bytes, id, [0x06, 0x03, 0x55, 0x1d, 0x13], 0xa3)
  return literal(bytes.toString('base64'))
})()
const ignoredAnchorMetadata = (() => {
  const id = 'rfc5280::no-keyusage/trusted_certs[0]'
  let bytes = fixtureBytes(id)
  const rootNode = derNode(bytes, 0)
  const tbs = derNode(bytes, rootNode.content)
  const version = derNode(bytes, tbs.content)
  const serial = derNode(bytes, version.end)
  bytes = rewriteDerNodes(
    bytes,
    id,
    bytes.subarray(serial.start, serial.end),
    [0x02, 0x01, 0x00],
    1,
  )
  let offset = bytes.indexOf(Buffer.from(ecdsaSha256Identifier))
  while (offset >= 0) {
    bytes[offset + ecdsaSha256Identifier.length - 1] = 3
    offset = bytes.indexOf(Buffer.from(ecdsaSha256Identifier), offset + 1)
  }
  const finalOctet = bytes.at(-1)
  if (finalOctet === undefined) throw new Error('Missing anchor signature')
  bytes[bytes.length - 1] = finalOctet ^ 1
  return literal(bytes.toString('base64'))
})()
const duplicateExtension = mutateUnique(
  'rfc5280::no-keyusage/trusted_certs[0]',
  [0x06, 0x03, 0x55, 0x1d, 0x0f],
  (bytes, offset) => {
    bytes[offset + 4] = 0x13
  },
)
const unknownCriticalExtension = mutateUnique(
  'rfc5280::no-keyusage/trusted_certs[0]',
  [0x06, 0x03, 0x55, 0x1d, 0x13],
  (bytes, offset) => {
    bytes[offset + 4] = 0x7f
  },
)
const malformedBasicConstraints = mutateUnique(
  'rfc5280::no-keyusage/trusted_certs[0]',
  [0x04, 0x05, 0x30, 0x03, 0x01, 0x01, 0xff],
  (bytes, offset) => {
    bytes[offset + 6] = 0x01
  },
)
const publicKeyUnusedBits = mutateUnique(
  'rfc5280::no-keyusage/peer_certificate',
  [0x03, 0x42, 0x00, 0x04],
  (bytes, offset) => {
    const finalOctet = bytes[offset + 67]
    if (finalOctet === undefined) throw new Error('Missing public-key BIT STRING payload')
    bytes[offset + 2] = 1
    bytes[offset + 67] = finalOctet & 0xfe
  },
)
const signatureUnusedBits = mutateFinalBitStringUnused('rfc5280::no-keyusage/peer_certificate')
const mismatchedSignatureAlgorithm = mismatchOuterSignatureAlgorithm(
  'rfc5280::no-keyusage/peer_certificate',
)
const invalidSignature = mutateUnique(
  'rfc5280::no-keyusage/peer_certificate',
  [0x30, 0x45, 0x02, 0x21],
  (bytes) => {
    const finalOctet = bytes.at(-1)
    if (finalOctet === undefined) throw new Error('Missing certificate signature payload')
    bytes[bytes.length - 1] = finalOctet ^ 0x01
  },
)

/**
 * One consolidated semantic-profile and owned-anchor witness. The selected certificates retain
 * their x509-limbo IDs, source pin, license, DER hashes, and profile-specific expected outcomes in
 * certificate-profile-limbo.json; this program does not claim full path validation.
 */
export const certificateProfileAcceptanceSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.certificate { Certificate, DecodeError, DecodeLimits, ExtensionView }
import silk.certificate_profile { CertificateKeyKind, CertificateProfile, CertificateRole, ExtendedKeyUsage, KeyUsage, ProfileClass, ProfileError, ProfileLimits, ProfileOffsetSpace, ProfileReason }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.option { Option }
import silk.result { Result }
import silk.trust_anchor { TrustAnchor }
import silk.usize

fn profileFailure<'a>(
  outcome: Result<CertificateProfile<'a>, ProfileError>,
  kind: ProfileClass,
  reason: ProfileReason,
) -> bool {
  return match move outcome {
    Result<CertificateProfile<'a>, ProfileError>.Success {value} => false
    Result<CertificateProfile<'a>, ProfileError>.Failure {error} => error.kind == kind && error.reason == reason
  }
}

fn profileFailureAt<'a>(
  outcome: Result<CertificateProfile<'a>, ProfileError>,
  kind: ProfileClass,
  reason: ProfileReason,
  offset: usize,
) -> bool {
  return match move outcome {
    Result<CertificateProfile<'a>, ProfileError>.Success {value} => false
    Result<CertificateProfile<'a>, ProfileError>.Failure {error} => error.kind == kind
        && error.reason == reason
        && error.offsetSpace == ProfileOffsetSpace.CertificateDer
        && error.offset == offset
  }
}

fn profileSuccess<'a>(outcome: Result<CertificateProfile<'a>, ProfileError>) -> bool {
  return match move outcome {
    Result<CertificateProfile<'a>, ProfileError>.Success {value} => true
    Result<CertificateProfile<'a>, ProfileError>.Failure {error} => false
  }
}

fn constraintFailure(
  outcome: Result<(), ProfileError>,
  kind: ProfileClass,
  reason: ProfileReason,
) -> bool {
  return match move outcome {
    Result<(), ProfileError>.Success {value} => false
    Result<(), ProfileError>.Failure {error} => error.kind == kind
        && error.reason == reason
        && error.offsetSpace == ProfileOffsetSpace.ConfiguredConstraintDer
  }
}

fn unitSuccess(outcome: Result<(), ProfileError>) -> bool {
  return match move outcome {
    Result<(), ProfileError>.Success {value} => true
    Result<(), ProfileError>.Failure {error} => false
  }
}

fn embeddedConstraint<'a>(
  outcome: Result<CertificateProfile<'a>, ProfileError>,
  expected: &[u8],
) -> bool {
  return match move outcome {
    Result<CertificateProfile<'a>, ProfileError>.Failure {error} => false
    Result<CertificateProfile<'a>, ProfileError>.Success {value} => {
      return optionBytes(CertificateProfile.nameConstraintsDer(&value), expected)
    }
  }
}

fn absentPathLength(option: Option<usize>) -> bool {
  return match move option {
    Option<usize>.None => true
    Option<usize>.Some {value} => false
  }
}

fn absentKeyUsage(option: Option<KeyUsage>) -> bool {
  return match move option {
    Option<KeyUsage>.None => true
    Option<KeyUsage>.Some {value} => false
  }
}

fn absentExtendedKeyUsage(option: Option<ExtendedKeyUsage>) -> bool {
  return match move option {
    Option<ExtendedKeyUsage>.None => true
    Option<ExtendedKeyUsage>.Some {value} => false
  }
}

fn absentBytes(option: Option<&[u8]>) -> bool {
  return match move option {
    Option<&[u8]>.None => true
    Option<&[u8]>.Some {value} => false
  }
}

fn serverUsage(option: Option<ExtendedKeyUsage>) -> bool {
  return match move option {
    Option<ExtendedKeyUsage>.None => false
    Option<ExtendedKeyUsage>.Some {value} => value.serverAuth
        && !value.anyExtendedKeyUsage
        && value.purposeCount == usize.ONE
  }
}

fn caUsage(option: Option<KeyUsage>) -> bool {
  return match move option {
    Option<KeyUsage>.None => false
    Option<KeyUsage>.Some {value} => !value.digitalSignature
        && value.keyCertSign
        && value.crlSign
        && !value.keyAgreement
  }
}

fn profilesLink<'leaf, 'root>(
  leaf: Result<CertificateProfile<'leaf>, ProfileError>,
  root: Result<CertificateProfile<'root>, ProfileError>,
) -> bool {
  return match move leaf {
    Result<CertificateProfile<'leaf>, ProfileError>.Failure {error} => false
    Result<CertificateProfile<'leaf>, ProfileError>.Success {value: leafProfile} => {
      return match move root {
        Result<CertificateProfile<'root>, ProfileError>.Failure {error} => false
        Result<CertificateProfile<'root>, ProfileError>.Success {value: rootProfile} => {
          return match move CertificateProfile.verifyIssuedBy(&leafProfile, &rootProfile) {
            Result<(), ProfileError>.Failure {error} => false
            Result<(), ProfileError>.Success {value} => true
          }
        }
      }
    }
  }
}

fn profilesReject<'subject, 'issuer>(
  subject: Result<CertificateProfile<'subject>, ProfileError>,
  issuer: Result<CertificateProfile<'issuer>, ProfileError>,
  reason: ProfileReason,
) -> bool {
  return match move subject {
    Result<CertificateProfile<'subject>, ProfileError>.Failure {error} => false
    Result<CertificateProfile<'subject>, ProfileError>.Success {value: subjectProfile} => {
      return match move issuer {
        Result<CertificateProfile<'issuer>, ProfileError>.Failure {error} => false
        Result<CertificateProfile<'issuer>, ProfileError>.Success {value: issuerProfile} => {
          return match move CertificateProfile.verifyIssuedBy(&subjectProfile, &issuerProfile) {
            Result<(), ProfileError>.Success {value} => false
            Result<(), ProfileError>.Failure {error} => error.reason == reason
          }
        }
      }
    }
  }
}

fn pathLength(value: Option<usize>, expected: usize) -> bool {
  return match move value {
    Option<usize>.None => false
    Option<usize>.Some {value: found} => found == expected
  }
}

fn inspectedPathLength<'a>(
  outcome: Result<CertificateProfile<'a>, ProfileError>,
  expected: usize,
) -> bool {
  return match move outcome {
    Result<CertificateProfile<'a>, ProfileError>.Failure {error} => false
    Result<CertificateProfile<'a>, ProfileError>.Success {value} => {
      return pathLength(CertificateProfile.pathLength(&value), expected)
    }
  }
}

fn equalBytes(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

fn optionBytes(value: Option<&[u8]>, expected: &[u8]) -> bool {
  return match move value {
    Option<&[u8]>.None => false
    Option<&[u8]>.Some {value: found} => equalBytes(found, expected)
  }
}

fn sameExtension<'left, 'right>(
  left: Option<ExtensionView<'left>>,
  right: Option<ExtensionView<'right>>,
) -> bool {
  return match move left {
    Option<ExtensionView<'left>>.None => match move right {
      Option<ExtensionView<'right>>.None => true
      Option<ExtensionView<'right>>.Some {value} => false
    }
    Option<ExtensionView<'left>>.Some {value: leftValue} => match move right {
      Option<ExtensionView<'right>>.None => false
      Option<ExtensionView<'right>>.Some {value: rightValue} => {
        return leftValue.critical == rightValue.critical
            && leftValue.offset == rightValue.offset
            && leftValue.valueOffset == rightValue.valueOffset
            && equalBytes(leftValue.der, rightValue.der)
            && equalBytes(leftValue.oid, rightValue.oid)
            && equalBytes(leftValue.value, rightValue.value)
      }
    }
  }
}

fn sameCertificate(left: &Certificate, right: &Certificate) -> bool {
  if !equalBytes(Certificate.der(left), Certificate.der(right)) { return false }
  let count = Certificate.extensionCount(left)
  if count != Certificate.extensionCount(right) { return false }
  let mut index = usize.ZERO
  while index < count {
    if !sameExtension(Certificate.extension(left, index), Certificate.extension(right, index)) {
      return false
    }
    index = index + usize.ONE
  }
  return true
}

fn leafGetters<'a>(
  outcome: Result<CertificateProfile<'a>, ProfileError>,
  certificate: &Certificate,
) -> bool {
  let expectedSan: [u8; 15] = [48, 13, 130, 11, 101, 120, 97, 109, 112, 108, 101, 46, 99, 111, 109]
  return match move outcome {
    Result<CertificateProfile<'a>, ProfileError>.Failure {error} => false
    Result<CertificateProfile<'a>, ProfileError>.Success {value} => {
      return sameCertificate(CertificateProfile.certificate(&value), certificate)
        && CertificateProfile.certificateRole(&value) == CertificateRole.ServerLeaf
        && CertificateProfile.keyKind(&value) == CertificateKeyKind.P256
        && !CertificateProfile.ca(&value)
        && absentPathLength(CertificateProfile.pathLength(&value))
        && absentKeyUsage(CertificateProfile.keyUsage(&value))
        && serverUsage(CertificateProfile.extendedKeyUsage(&value))
        && optionBytes(CertificateProfile.subjectAltNamesDer(&value), &expectedSan)
        && absentBytes(CertificateProfile.nameConstraintsDer(&value))
    }
  }
}

fn rootGetters<'a>(
  outcome: Result<CertificateProfile<'a>, ProfileError>,
  certificate: &Certificate,
) -> bool {
  let expectedSan: [u8; 15] = [48, 13, 130, 11, 101, 120, 97, 109, 112, 108, 101, 46, 99, 111, 109]
  return match move outcome {
    Result<CertificateProfile<'a>, ProfileError>.Failure {error} => false
    Result<CertificateProfile<'a>, ProfileError>.Success {value} => {
      return sameCertificate(CertificateProfile.certificate(&value), certificate)
        && CertificateProfile.certificateRole(&value) == CertificateRole.Anchor
        && CertificateProfile.keyKind(&value) == CertificateKeyKind.P256
        && CertificateProfile.ca(&value)
        && absentPathLength(CertificateProfile.pathLength(&value))
        && caUsage(CertificateProfile.keyUsage(&value))
        && absentExtendedKeyUsage(CertificateProfile.extendedKeyUsage(&value))
        && optionBytes(CertificateProfile.subjectAltNamesDer(&value), &expectedSan)
        && absentBytes(CertificateProfile.nameConstraintsDer(&value))
    }
  }
}

effect fn inspectionSucceeds(
  input: &[u8],
  selectedRole: CertificateRole,
  limits: ProfileLimits,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let result = run decoded(input)
  return match move result {
    Result<Certificate, DecodeError>.Failure {error} => false
    Result<Certificate, DecodeError>.Success {value} => profileSuccess(
      CertificateProfile.inspect(&value, selectedRole, limits),
    )
  }
}

effect fn inspectionFails(
  input: &[u8],
  selectedRole: CertificateRole,
  limits: ProfileLimits,
  kind: ProfileClass,
  reason: ProfileReason,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let result = run decoded(input)
  return match move result {
    Result<Certificate, DecodeError>.Failure {error} => false
    Result<Certificate, DecodeError>.Success {value} => profileFailure(
      CertificateProfile.inspect(&value, selectedRole, limits),
      kind,
      reason,
    )
  }
}

effect fn decoded(input: &[u8]) -> Result<Certificate, DecodeError>
! OutOfMemoryError
? &mut Allocator {
  return run Certificate.decodeDer(input, DecodeLimits.defaults())
}

struct RefusingAllocator { calls: usize failAt: usize }

effect fn allocate(self: &mut RefusingAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  self.calls = self.calls + usize.ONE
  if self.calls == self.failAt { return run Allocator.outOfMemory() }
  let mut system = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut<Allocator>(&mut system)
}

impl Allocator for RefusingAllocator { allocate: RefusingAllocator.allocate }

effect fn cloneSucceeded(anchor: &TrustAnchor) -> bool ! OutOfMemoryError ? &mut Allocator {
  let cloned = run TrustAnchor.clone(anchor)
  return sameCertificate(TrustAnchor.certificate(&cloned), TrustAnchor.certificate(anchor))
}

effect fn anchorConstructionSucceeded(certificate: Certificate, constraints: &[u8]) -> bool
! OutOfMemoryError
? &mut Allocator {
  let built = run TrustAnchor.fromCertificateWithConstraints(
    move certificate,
    Option<usize>.none(),
    Option<&[u8]>.some(constraints),
    ProfileLimits.defaults(),
  )
  return match move built {
    Result<TrustAnchor, ProfileError>.Failure {error} => false
    Result<TrustAnchor, ProfileError>.Success {value} => true
  }
}

effect fn allocationFailed(error: OutOfMemoryError) -> bool { return false }

effect fn suite() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let leafResult = run decoded(${leaf})
  let leafCertificate = match move leafResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 1 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let rootResult = run decoded(${root})
  let rootCertificate = match move rootResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 2 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !leafGetters(
    CertificateProfile.inspect(
      &leafCertificate,
      CertificateRole.ServerLeaf,
      ProfileLimits.defaults(),
    ),
    &leafCertificate,
  ) { return 3 }
  if !rootGetters(
    CertificateProfile.inspect(
      &rootCertificate,
      CertificateRole.Anchor,
      ProfileLimits.defaults(),
    ),
    &rootCertificate,
  ) { return 4 }
  let pathLengthZeroResult = run decoded(${pathLengthZeroIntermediate})
  let pathLengthZeroCertificate = match move pathLengthZeroResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 165 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !inspectedPathLength(
    CertificateProfile.inspect(
      &pathLengthZeroCertificate,
      CertificateRole.Intermediate,
      ProfileLimits.defaults(),
    ),
    0,
  ) { return 166 }
  let inspectedLeaf = CertificateProfile.inspect(
    &leafCertificate,
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
  )
  let inspectedRoot = CertificateProfile.inspect(
    &rootCertificate,
    CertificateRole.Anchor,
    ProfileLimits.defaults(),
  )
  if !profilesLink(move inspectedLeaf, move inspectedRoot) { return 5 }
  if !profilesReject(
    CertificateProfile.inspect(&rootCertificate, CertificateRole.Anchor, ProfileLimits.defaults()),
    CertificateProfile.inspect(&leafCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileReason.IssuerName,
  ) { return 22 }

  let invalidSignatureResult = run decoded(${invalidSignature})
  let invalidSignatureCertificate = match move invalidSignatureResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 23 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profilesReject(
    CertificateProfile.inspect(&invalidSignatureCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    CertificateProfile.inspect(&rootCertificate, CertificateRole.Anchor, ProfileLimits.defaults()),
    ProfileReason.SignatureRejected,
  ) { return 24 }

  let zeroResult = run decoded(${zeroSerial})
  let zeroCertificate = match move zeroResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 6 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailureAt(
    CertificateProfile.inspect(&zeroCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Malformed,
    ProfileReason.Serial,
    Certificate.offsets(&zeroCertificate).serial,
  ) { return 7 }

  let wrongResult = run decoded(${wrongEku})
  let wrongCertificate = match move wrongResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 8 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailure(
    CertificateProfile.inspect(&wrongCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.MissingServerAuth,
  ) { return 9 }
  let unsupportedStored = TrustAnchor.fromCertificate(move wrongCertificate)
  if TrustAnchor.encodedBytes(&unsupportedStored) != ${Buffer.from(fixtures.fixtures.find((value) => value.id === 'rfc5280::eku::ee-wrong-eku/peer_certificate')?.der ?? '', 'base64').length} { return 10 }

  let wildcardResult = run decoded(${wildcardConstraint})
  let wildcardCertificate = match move wildcardResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 11 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailure(
    CertificateProfile.inspect(&wildcardCertificate, CertificateRole.Anchor, ProfileLimits.defaults()),
    ProfileClass.Malformed,
    ProfileReason.NameConstraints,
  ) { return 12 }

  let duplicateResult = run decoded(${duplicateExtension})
  let duplicateCertificate = match move duplicateResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 25 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailure(
    CertificateProfile.inspect(&duplicateCertificate, CertificateRole.Anchor, ProfileLimits.defaults()),
    ProfileClass.Malformed,
    ProfileReason.DuplicateExtension,
  ) { return 26 }

  let criticalResult = run decoded(${unknownCriticalExtension})
  let criticalCertificate = match move criticalResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 27 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailure(
    CertificateProfile.inspect(&criticalCertificate, CertificateRole.Anchor, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.UnknownCriticalExtension,
  ) { return 28 }

  let malformedBcResult = run decoded(${malformedBasicConstraints})
  let malformedBcCertificate = match move malformedBcResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 29 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailure(
    CertificateProfile.inspect(&malformedBcCertificate, CertificateRole.Anchor, ProfileLimits.defaults()),
    ProfileClass.Malformed,
    ProfileReason.BasicConstraints,
  ) { return 30 }

  let keyBitsResult = run decoded(${publicKeyUnusedBits})
  let keyBitsCertificate = match move keyBitsResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 31 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailure(
    CertificateProfile.inspect(&keyBitsCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.PublicKey,
  ) { return 32 }

  let signatureBitsResult = run decoded(${signatureUnusedBits})
  let signatureBitsCertificate = match move signatureBitsResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 33 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailure(
    CertificateProfile.inspect(&signatureBitsCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.SignatureAlgorithm,
  ) { return 34 }

  let mismatchResult = run decoded(${mismatchedSignatureAlgorithm})
  let mismatchCertificate = match move mismatchResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 35 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailureAt(
    CertificateProfile.inspect(&mismatchCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.SignatureAlgorithmMismatch,
    Certificate.offsets(&mismatchCertificate).signatureAlgorithm,
  ) { return 36 }

  let versionLimits = ProfileLimits {
    extensions: usize.ZERO,
    extensionBytes: usize.ZERO,
    sanNames: usize.ZERO,
    constraintSubtrees: usize.ZERO,
    nodes: usize.ZERO,
    depth: usize.ZERO,
  }
  let versionResult = run decoded(${versionTwo})
  let versionCertificate = match move versionResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 160 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailureAt(
    CertificateProfile.inspect(&versionCertificate, CertificateRole.ServerLeaf, versionLimits),
    ProfileClass.Unsupported,
    ProfileReason.Version,
    Certificate.offsets(&versionCertificate).version,
  ) { return 161 }
  if !(run inspectionFails(
    ${zeroSerial},
    CertificateRole.ServerLeaf,
    versionLimits,
    ProfileClass.Malformed,
    ProfileReason.Serial,
  )) { return 159 }

  let uniqueResult = run decoded(${uniqueIds})
  let uniqueCertificate = match move uniqueResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 101 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailureAt(
    CertificateProfile.inspect(&uniqueCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.UniqueIdentifier,
    Certificate.offsets(&uniqueCertificate).issuerUniqueId,
  ) { return 102 }

  let curveResult = run decoded(${wrongCurve})
  let curveCertificate = match move curveResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 103 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailureAt(
    CertificateProfile.inspect(&curveCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.PublicKey,
    Certificate.offsets(&curveCertificate).spki,
  ) { return 104 }
  if !(run inspectionFails(
    ${invalidPoint},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.PublicKey,
  )) { return 105 }

  let innerResult = run decoded(${innerUnknownSignatureAlgorithm})
  let innerCertificate = match move innerResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 106 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let innerOffsets = Certificate.offsets(&innerCertificate)
  if !profileFailureAt(
    CertificateProfile.inspect(&innerCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.SignatureAlgorithm,
    innerOffsets.tbsSignatureAlgorithm,
  ) { return 107 }

  let outerResult = run decoded(${outerUnknownSignatureAlgorithm})
  let outerCertificate = match move outerResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 108 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let outerOffsets = Certificate.offsets(&outerCertificate)
  if outerOffsets.tbsSignatureAlgorithm == outerOffsets.signatureAlgorithm { return 109 }
  if !profileFailureAt(
    CertificateProfile.inspect(&outerCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.SignatureAlgorithm,
    outerOffsets.signatureAlgorithm,
  ) { return 110 }
  let parameterResult = run decoded(${ecdsaForbiddenParameters})
  let parameterCertificate = match move parameterResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 167 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailureAt(
    CertificateProfile.inspect(&parameterCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.SignatureParameters,
    Certificate.offsets(&parameterCertificate).tbsSignatureAlgorithm,
  ) { return 168 }

  if !(run inspectionSucceeds(${rsaLeaf}, CertificateRole.ServerLeaf, ProfileLimits.defaults())) {
    return 112
  }
  if !(run inspectionSucceeds(${rsaSpkiAbsent}, CertificateRole.ServerLeaf, ProfileLimits.defaults())) {
    return 113
  }
  if !(run inspectionSucceeds(${rsaSignatureAbsent}, CertificateRole.ServerLeaf, ProfileLimits.defaults())) {
    return 114
  }
  if !(run inspectionSucceeds(${rsaPss}, CertificateRole.ServerLeaf, ProfileLimits.defaults())) {
    return 115
  }
  if !(run inspectionFails(
    ${rsaPssMissingParameters},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.SignatureParameters,
  )) { return 116 }
  if !(run inspectionFails(
    ${rsaPssBadParameters},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.SignatureParameters,
  )) { return 169 }

  if !(run inspectionSucceeds(${root}, CertificateRole.Intermediate, ProfileLimits.defaults())) {
    return 117
  }
  if !(run inspectionFails(
    ${root},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.Role,
  )) { return 118 }
  if !(run inspectionFails(
    ${missingCaKeyUsage},
    CertificateRole.Anchor,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.MissingKeyUsage,
  )) { return 119 }
  if !(run inspectionSucceeds(${v1Anchor}, CertificateRole.Anchor, ProfileLimits.defaults())) {
    return 120
  }
  if !(run inspectionSucceeds(${ignoredAnchorMetadata}, CertificateRole.Anchor, ProfileLimits.defaults())) {
    return 121
  }

  if !(run inspectionFails(
    ${unsupportedCriticalSan},
    CertificateRole.Anchor,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.UnsupportedCriticalName,
  )) { return 122 }
  if !(run inspectionFails(
    ${numericSan},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Malformed,
    ProfileReason.SubjectAltName,
  )) { return 123 }
  if !(run inspectionFails(
    ${oversizedWildcardSan},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Malformed,
    ProfileReason.SubjectAltName,
  )) { return 124 }
  if !(run inspectionFails(
    ${invalidIpSan},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Malformed,
    ProfileReason.SubjectAltName,
  )) { return 125 }
  if !(run inspectionSucceeds(${validIpSan}, CertificateRole.ServerLeaf, ProfileLimits.defaults())) {
    return 126
  }
  let emptyMissingResult = run decoded(${emptySubjectMissingSan})
  let emptyMissingCertificate = match move emptyMissingResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 170 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  if !profileFailureAt(
    CertificateProfile.inspect(&emptyMissingCertificate, CertificateRole.ServerLeaf, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.EmptySubject,
    Certificate.offsets(&emptyMissingCertificate).subject,
  ) { return 171 }
  if !(run inspectionFails(
    ${emptySubjectNoncriticalSan},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.EmptySubject,
  )) { return 172 }
  if !(run inspectionFails(
    ${emptySubjectEmptyCriticalSan},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Malformed,
    ProfileReason.EmptySubject,
  )) { return 173 }
  if !(run inspectionFails(
    ${nonemptySubjectEmptyCriticalSan},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Malformed,
    ProfileReason.SubjectAltName,
  )) { return 174 }

  if !(run inspectionFails(
    ${policyProcessing},
    CertificateRole.Anchor,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.PolicyProcessing,
  )) { return 127 }
  if !(run inspectionFails(
    ${tlsFeature},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Unsupported,
    ProfileReason.TlsFeature,
  )) { return 128 }
  if !(run inspectionFails(
    ${unpairedAkiSerial},
    CertificateRole.ServerLeaf,
    ProfileLimits.defaults(),
    ProfileClass.Malformed,
    ProfileReason.MalformedExtension,
  )) { return 129 }

  let mut extensionLimits = ProfileLimits.defaults()
  extensionLimits.extensions = 4
  if !(run inspectionSucceeds(${leaf}, CertificateRole.ServerLeaf, extensionLimits)) { return 130 }
  extensionLimits.extensions = 3
  if !(run inspectionFails(
    ${leaf},
    CertificateRole.ServerLeaf,
    extensionLimits,
    ProfileClass.ResourceLimit,
    ProfileReason.Extensions,
  )) { return 131 }
  let mut byteLimits = ProfileLimits.defaults()
  byteLimits.extensionBytes = 24
  if !(run inspectionSucceeds(${leaf}, CertificateRole.ServerLeaf, byteLimits)) { return 132 }
  byteLimits.extensionBytes = 23
  if !(run inspectionFails(
    ${leaf},
    CertificateRole.ServerLeaf,
    byteLimits,
    ProfileClass.ResourceLimit,
    ProfileReason.ExtensionBytes,
  )) { return 133 }
  let mut sanLimits = ProfileLimits.defaults()
  sanLimits.sanNames = usize.ONE
  if !(run inspectionSucceeds(${leaf}, CertificateRole.ServerLeaf, sanLimits)) { return 134 }
  sanLimits.sanNames = usize.ZERO
  if !(run inspectionFails(
    ${leaf},
    CertificateRole.ServerLeaf,
    sanLimits,
    ProfileClass.ResourceLimit,
    ProfileReason.SanNames,
  )) { return 135 }

  let configured: [u8; 19] = [
    48, 17, 160, 15, 48, 13, 130, 11, 101, 120,
    97, 109, 112, 108, 101, 46, 99, 111, 109,
  ]
  let ownedRootResult = run decoded(${root})
  let ownedRoot = match move ownedRootResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 13 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let anchorResult = run TrustAnchor.fromCertificateWithConstraints(
    move ownedRoot,
    Option<usize>.some(2),
    Option<&[u8]>.some(&configured),
    ProfileLimits.defaults(),
  )
  let anchor = match move anchorResult {
    Result<TrustAnchor, ProfileError>.Failure {error} => { return 14 }
    Result<TrustAnchor, ProfileError>.Success {value} => move value
  }
  if !pathLength(TrustAnchor.configuredPathLength(&anchor), 2) { return 15 }
  if !optionBytes(TrustAnchor.configuredNameConstraints(&anchor), &configured) { return 16 }
  if TrustAnchor.encodedBytes(&anchor) != ${Buffer.from(fixtures.fixtures.find((value) => value.id === 'rfc5280::no-keyusage/trusted_certs[0]')?.der ?? '', 'base64').length} + 19 { return 17 }
  let cloned = run TrustAnchor.clone(&anchor)
  drop anchor
  if !pathLength(TrustAnchor.configuredPathLength(&cloned), 2) { return 18 }
  if !optionBytes(TrustAnchor.configuredNameConstraints(&cloned), &configured) { return 19 }
  if !sameCertificate(TrustAnchor.certificate(&cloned), &rootCertificate) { return 37 }

  let mut cloneAudit = RefusingAllocator { calls: usize.ZERO, failAt: usize.ZERO }
  let cloneCalibration = run Effect.catchAll(
    cloneSucceeded(&cloned) |> Effect.provideMut<Allocator>(&mut cloneAudit),
    allocationFailed,
  )
  if !cloneCalibration || cloneAudit.calls == usize.ZERO { return 136 }
  let cloneAllocations = cloneAudit.calls
  cloneAudit.calls = usize.ZERO
  cloneAudit.failAt = cloneAllocations
  let cloneRefused = run Effect.catchAll(
    cloneSucceeded(&cloned) |> Effect.provideMut<Allocator>(&mut cloneAudit),
    allocationFailed,
  )
  if cloneRefused || cloneAudit.calls != cloneAllocations { return 137 }
  cloneAudit.calls = usize.ZERO
  cloneAudit.failAt = usize.ZERO
  let cloneRetried = run Effect.catchAll(
    cloneSucceeded(&cloned) |> Effect.provideMut<Allocator>(&mut cloneAudit),
    allocationFailed,
  )
  if !cloneRetried || !sameCertificate(TrustAnchor.certificate(&cloned), &rootCertificate) {
    return 138
  }

  let calibrationOwnerResult = run decoded(${root})
  let calibrationOwner = match move calibrationOwnerResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 139 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let mut constructionAudit = RefusingAllocator { calls: usize.ZERO, failAt: usize.ZERO }
  let constructionCalibration = run Effect.catchAll(
    anchorConstructionSucceeded(move calibrationOwner, &configured)
      |> Effect.provideMut<Allocator>(&mut constructionAudit),
    allocationFailed,
  )
  if !constructionCalibration || constructionAudit.calls == usize.ZERO { return 140 }
  let constructionAllocations = constructionAudit.calls
  let refusedOwnerResult = run decoded(${root})
  let refusedOwner = match move refusedOwnerResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 141 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  constructionAudit.calls = usize.ZERO
  constructionAudit.failAt = constructionAllocations
  let constructionRefused = run Effect.catchAll(
    anchorConstructionSucceeded(move refusedOwner, &configured)
      |> Effect.provideMut<Allocator>(&mut constructionAudit),
    allocationFailed,
  )
  if constructionRefused || constructionAudit.calls != constructionAllocations { return 142 }
  let retryOwnerResult = run decoded(${root})
  let retryOwner = match move retryOwnerResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 143 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  constructionAudit.calls = usize.ZERO
  constructionAudit.failAt = usize.ZERO
  let constructionRetried = run Effect.catchAll(
    anchorConstructionSucceeded(move retryOwner, &configured)
      |> Effect.provideMut<Allocator>(&mut constructionAudit),
    allocationFailed,
  )
  if !constructionRetried { return 144 }

  let malformed = CertificateProfile.validateConfiguredNameConstraints(b"\\x30\\x00", ProfileLimits.defaults())
  let malformedAccepted = match move malformed {
    Result<(), ProfileError>.Success {value} => true
    Result<(), ProfileError>.Failure {error} => error.kind != ProfileClass.Malformed
        || error.reason != ProfileReason.NameConstraints
        || error.offsetSpace != ProfileOffsetSpace.ConfiguredConstraintDer
  }
  if malformedAccepted { return 20 }
  let mut noNodes = ProfileLimits.defaults()
  noNodes.nodes = usize.ZERO
  let limited = CertificateProfile.validateConfiguredNameConstraints(&configured, noNodes)
  let limitAccepted = match move limited {
    Result<(), ProfileError>.Success {value} => true
    Result<(), ProfileError>.Failure {error} => error.kind != ProfileClass.ResourceLimit || error.reason != ProfileReason.Nodes
  }
  if limitAccepted { return 21 }

  let leadingConstraint: [u8; 20] = [
    48, 18, 160, 16, 48, 14, 130, 12, 46, 101,
    120, 97, 109, 112, 108, 101, 46, 99, 111, 109,
  ]
  let minConstraint: [u8; 22] = [
    48, 20, 160, 18, 48, 16, 130, 11, 101, 120, 97,
    109, 112, 108, 101, 46, 99, 111, 109, 128, 1, 1,
  ]
  let maxConstraint: [u8; 22] = [
    48, 20, 160, 18, 48, 16, 130, 11, 101, 120, 97,
    109, 112, 108, 101, 46, 99, 111, 109, 129, 1, 1,
  ]
  let ipConstraint: [u8; 16] = [
    48, 14, 160, 12, 48, 10, 135, 8, 192, 0, 2, 0, 255, 255, 255, 0,
  ]
  let invalidIpMask: [u8; 16] = [
    48, 14, 160, 12, 48, 10, 135, 8, 0, 0, 0, 0, 255, 0, 255, 0,
  ]
  let unsupportedSubtree: [u8; 8] = [48, 6, 160, 4, 48, 2, 164, 0]
  if !constraintFailure(
    CertificateProfile.validateConfiguredNameConstraints(&minConstraint, ProfileLimits.defaults()),
    ProfileClass.Malformed,
    ProfileReason.NameConstraints,
  ) { return 145 }
  if !constraintFailure(
    CertificateProfile.validateConfiguredNameConstraints(&maxConstraint, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.NameConstraints,
  ) { return 146 }
  if !constraintFailure(
    CertificateProfile.validateConfiguredNameConstraints(&invalidIpMask, ProfileLimits.defaults()),
    ProfileClass.Malformed,
    ProfileReason.NameConstraints,
  ) { return 147 }
  if !constraintFailure(
    CertificateProfile.validateConfiguredNameConstraints(&unsupportedSubtree, ProfileLimits.defaults()),
    ProfileClass.Unsupported,
    ProfileReason.UnsupportedNameConstraint,
  ) { return 148 }
  if !unitSuccess(
    CertificateProfile.validateConfiguredNameConstraints(&ipConstraint, ProfileLimits.defaults()),
  ) { return 149 }

  let mut subtreeLimits = ProfileLimits.defaults()
  subtreeLimits.constraintSubtrees = usize.ONE
  if !unitSuccess(CertificateProfile.validateConfiguredNameConstraints(&configured, subtreeLimits)) {
    return 150
  }
  subtreeLimits.constraintSubtrees = usize.ZERO
  if !constraintFailure(
    CertificateProfile.validateConfiguredNameConstraints(&configured, subtreeLimits),
    ProfileClass.ResourceLimit,
    ProfileReason.ConstraintSubtrees,
  ) { return 151 }
  let mut nodeLimits = ProfileLimits.defaults()
  nodeLimits.nodes = 4
  if !unitSuccess(CertificateProfile.validateConfiguredNameConstraints(&configured, nodeLimits)) {
    return 152
  }
  nodeLimits.nodes = 3
  if !constraintFailure(
    CertificateProfile.validateConfiguredNameConstraints(&configured, nodeLimits),
    ProfileClass.ResourceLimit,
    ProfileReason.Nodes,
  ) { return 153 }
  let mut depthLimits = ProfileLimits.defaults()
  depthLimits.depth = 4
  if !unitSuccess(CertificateProfile.validateConfiguredNameConstraints(&configured, depthLimits)) {
    return 154
  }
  depthLimits.depth = 3
  if !constraintFailure(
    CertificateProfile.validateConfiguredNameConstraints(&configured, depthLimits),
    ProfileClass.ResourceLimit,
    ProfileReason.Depth,
  ) { return 155 }

  let constrainedResult = run decoded(${constrainedRoot})
  let constrainedCertificate = match move constrainedResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 156 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let embeddedPresent = embeddedConstraint(
    CertificateProfile.inspect(
      &constrainedCertificate,
      CertificateRole.Anchor,
      ProfileLimits.defaults(),
    ),
    &configured,
  )
  if !embeddedPresent { return 157 }

  let ownedConstrainedResult = run decoded(${constrainedRoot})
  let ownedConstrained = match move ownedConstrainedResult {
    Result<Certificate, DecodeError>.Failure {error} => { return 158 }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let provenanceResult = run TrustAnchor.fromCertificateWithConstraints(
    move ownedConstrained,
    Option<usize>.none(),
    Option<&[u8]>.some(&leadingConstraint),
    ProfileLimits.defaults(),
  )
  let provenanceAnchor = match move provenanceResult {
    Result<TrustAnchor, ProfileError>.Failure {error} => { return 162 }
    Result<TrustAnchor, ProfileError>.Success {value} => move value
  }
  if !optionBytes(TrustAnchor.configuredNameConstraints(&provenanceAnchor), &leadingConstraint) {
    return 163
  }
  let provenanceKept = embeddedConstraint(
    CertificateProfile.inspect(
      TrustAnchor.certificate(&provenanceAnchor),
      CertificateRole.Anchor,
      ProfileLimits.defaults(),
    ),
    &configured,
  )
  if !provenanceKept { return 164 }
  return 42
}

effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run suite() |> Effect.provideMut<Allocator>(&mut allocator)
}

effect fn allocationFailure(error: OutOfMemoryError) -> i32 { return 99 }

pub fn main() -> i32 { return run Effect.catchAll(allocated(), allocationFailure) }
`

/** Compact target-portability witness: unsupported certificate bytes remain storable on Wasm. */
export const certificateProfileWasmSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.certificate { Certificate, DecodeError, DecodeLimits }
import silk.effect { Effect }
import silk.result { Result }
import silk.trust_anchor { TrustAnchor }

effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let decoded = run Certificate.decodeDer(
    ${literal('MFMwRqADAgEBAgEBMAMGASowADAeFw01MDAxMDEwMDAwMDBaFw00OTEyMzEyMzU5NTlaMAAwCzAFBgEqBQADAgOggQIHgIICAf4wBQYBKwUAAwIC/A==')},
    DecodeLimits.defaults(),
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  return match move decoded {
    Result<Certificate, DecodeError>.Failure {error} => 1
    Result<Certificate, DecodeError>.Success {value} => {
      let anchor = TrustAnchor.fromCertificate(move value)
      if TrustAnchor.encodedBytes(&anchor) == 85 { return 42 }
      return 2
    }
  }
}

effect fn allocationFailure(error: OutOfMemoryError) -> i32 { return 3 }
pub fn main() -> i32 { return run Effect.catchAll(allocated(), allocationFailure) }
`
