import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import { spawnSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CleanupPlan from '../src/CleanupPlan.js'
import certificateProfileFixtures from './fixtures/certificate-profile-limbo.json' with { type: 'json' }
import certificatePathFixtures from './fixtures/certificate-path-limbo.json' with { type: 'json' }
import tlsClientFixtures from './fixtures/tls-client/manifest.json' with { type: 'json' }
import {
  tlsClientClosureControlNativeSource,
  tlsClientEmptyCookieRetry,
  tlsClientFragmentationKinds,
  tlsClientCoreNativeSource,
  tlsClientDemandRequestNativeSource,
  tlsClientHandshakePolicyNativeSource,
  tlsClientKeyUpdateNativeSource,
  tlsClientNativeFixtureSource,
  tlsClientResourcePolicyNativeSource,
  tlsClientWasmSource,
} from './support/tlsClientAcceptance.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const serverHelloExtensions = (record: Uint8Array): ReadonlyMap<number, Uint8Array> => {
  assert.strictEqual(record[0], 22)
  const recordLength = (record[3] ?? 0) * 256 + (record[4] ?? 0) + 5
  assert.isAtMost(recordLength, record.length)
  const message = record.subarray(5, recordLength)
  assert.strictEqual(message[0], 2)
  assert.strictEqual(
    (message[1] ?? 0) * 65_536 + (message[2] ?? 0) * 256 + (message[3] ?? 0) + 4,
    message.length,
  )
  const sessionIdLength = message[38] ?? 0
  const extensionsLengthOffset = 39 + sessionIdLength + 3
  const extensionsLength =
    (message[extensionsLengthOffset] ?? 0) * 256 + (message[extensionsLengthOffset + 1] ?? 0)
  const extensionsEnd = extensionsLengthOffset + 2 + extensionsLength
  assert.strictEqual(extensionsEnd, message.length)
  const extensions = new Map<number, Uint8Array>()
  let cursor = extensionsLengthOffset + 2
  while (cursor < extensionsEnd) {
    const kind = (message[cursor] ?? 0) * 256 + (message[cursor + 1] ?? 0)
    const length = (message[cursor + 2] ?? 0) * 256 + (message[cursor + 3] ?? 0)
    const value = message.subarray(cursor + 4, cursor + 4 + length)
    assert.strictEqual(value.length, length)
    assert.isFalse(extensions.has(kind))
    extensions.set(kind, value)
    cursor += 4 + length
  }
  assert.strictEqual(cursor, extensionsEnd)
  return extensions
}

it('pins authenticated TLS client replay provenance and every offline file digest', () => {
  assert.strictEqual(tlsClientFixtures.rustls.version, '0.23.35')
  assert.strictEqual(tlsClientFixtures.rustls.commit, '7768cd2b44049e040685d48318d13bfa7f7d32a8')
  assert.strictEqual(tlsClientFixtures.rustls.provider, 'ring')
  assert.deepEqual(tlsClientFixtures.rustls.protocolVersions, ['TLSv1.3'])
  assert.strictEqual(
    tlsClientFixtures.rustls.generatorCommand,
    'cd generator && cargo run --locked',
  )
  assert.match(tlsClientFixtures.rustls.regeneration, /semantic-only/)
  assert.strictEqual(
    tlsClientFixtures.comparison.zigHttpParityCommit,
    '1bc892110da738d6137b3f0b7e8e3a586ce09928',
  )
  assert.strictEqual(tlsClientFixtures.shared.privateKeys, 'TEST ONLY')
  assert.deepEqual(
    tlsClientFixtures.captures.map((capture) => capture.suite),
    [
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
    ],
  )
  assert.match(tlsClientFixtures.captures.at(-1)?.group ?? '', /HelloRetryRequest/)
  for (const capture of tlsClientFixtures.captures) {
    assert.strictEqual(capture.generator.command, tlsClientFixtures.rustls.generatorCommand)
    assert.isNotEmpty(capture.generator.captureId)
    const expectedLength = capture.peerTranscript.hash === 'SHA-384' ? 96 : 64
    for (const [checkpoint, digest] of Object.entries(capture.peerTranscript)) {
      if (checkpoint === 'hash') continue
      assert.strictEqual(digest.length, expectedLength, `${capture.id}:${checkpoint}`)
      assert.match(digest, /^[0-9a-f]+$/, `${capture.id}:${checkpoint}`)
    }
  }
  const lock = readFileSync(
    new URL('./fixtures/tls-client/generator/Cargo.lock', import.meta.url),
    'utf8',
  )
  assert.include(
    lock,
    'git+https://github.com/rustls/rustls.git?rev=7768cd2b44049e040685d48318d13bfa7f7d32a8#7768cd2b44049e040685d48318d13bfa7f7d32a8',
  )
  for (const [path, expected] of Object.entries(tlsClientFixtures.files)) {
    const bytes = readFileSync(new URL(`./fixtures/tls-client/${path}`, import.meta.url))
    assert.strictEqual(createHash('sha256').update(bytes).digest('hex'), expected, path)
  }
})

it('keeps the empty-cookie HRR otherwise valid and independently distinguishable', () => {
  const extensions = serverHelloExtensions(tlsClientEmptyCookieRetry)
  assert.deepEqual(extensions.get(51), Uint8Array.from([0, 23]))
  assert.deepEqual(extensions.get(44), Uint8Array.from([0, 0]))
})

it('pins TLS client control-slot and encoded-ALPN boundary guards in ordinary Silk', () => {
  const source = readFileSync(new URL('../stdlib/silk/tls_client.silk', import.meta.url), 'utf8')
  const recordSource = readFileSync(
    new URL('../stdlib/silk/tls_record.silk', import.meta.url),
    'utf8',
  )
  assert.match(source, /if bytes\.length \+ usize\.ONE > ALPN_BYTES_LIMIT - total/)
  assert.match(source, /total = total \+ bytes\.length \+ usize\.ONE/)
  const write = source.slice(
    source.indexOf('pub fn writePlaintext'),
    source.indexOf('pub fn requestKeyUpdate'),
  )
  assert.include(write, 'scheduleControl')
  assert.include(write, 'queueRecord')
  assert.isBelow(write.indexOf('scheduleControl'), write.indexOf('queueRecord'))
  assert.notInclude(write, 'ProtocolReason.Record')
  const schedule = source.slice(
    source.indexOf('fn scheduleControl'),
    source.indexOf('fn updateTrafficSecret'),
  )
  assert.match(schedule, /recordsRemaining\(&client\.sender\) == 1/)
  assert.match(recordSource, /pub const RECORDS_PER_EPOCH: u64 = 8388608/)
  const make = source.slice(
    source.indexOf('pub effect fn make'),
    source.indexOf('fn validateLimits'),
  )
  assert.include(make, 'validateLimits(config.limits)')
  assert.include(make, 'allocateBytes')
  assert.include(make, 'Random.fillBytes')
  assert.isBelow(make.indexOf('validateLimits(config.limits)'), make.indexOf('allocateBytes'))
  assert.isBelow(make.indexOf('validateLimits(config.limits)'), make.indexOf('Random.fillBytes'))
  const hello = source.slice(
    source.indexOf('effect fn queueClientHello'),
    source.indexOf('fn putU8'),
  )
  assert.isNotEmpty(hello)
  assert.notInclude(hello, 'handshakeLength = 0')
  assert.match(source, /shiftHandshake\(&mut client\.\*, messageLength\)/)
  const compatibility = source.slice(
    source.indexOf('fn compatibilityWindow'),
    source.indexOf('fn completeHandshakeAvailable'),
  )
  assert.include(compatibility, 'ClientState.RetryClientHelloPending')
  const serverHello = source.slice(
    source.indexOf('effect fn handleServerHello'),
    source.indexOf('fn deriveSharedSecret'),
  )
  assert.match(serverHello, /messageLength != client\.handshakeLength/)
  const progress = source.slice(
    source.indexOf('pub effect fn progress'),
    source.indexOf('pub fn ackWritten'),
  )
  assert.include(progress, 'while completeHandshakeAvailable(&self.*)')
  assert.isBelow(progress.indexOf('processHandshake'), progress.indexOf('scheduleControl'))
  const readyRecord = source.slice(
    source.indexOf('effect fn handleReadyRecord'),
    source.indexOf('fn compatibilityWindow'),
  )
  assert.include(readyRecord, 'while completeHandshakeAvailable(&client.*)')
  const certificateRequest = source.slice(
    source.indexOf('fn handleCertificateRequest'),
    source.indexOf('effect fn handleCertificate'),
  )
  assert.include(certificateRequest, 'certificateRequestExtensionSeen')
  assert.include(certificateRequest, 'kind == 5 || kind == 18')
  assert.include(certificateRequest, 'if length != 0')
  assert.include(certificateRequest, 'kind == 48')
  assert.include(certificateRequest, 'validOidFilters')
  const forbiddenRequest = certificateRequest.slice(
    certificateRequest.indexOf('fn forbiddenCertificateRequestExtension'),
    certificateRequest.indexOf('fn validRequestedSignatureSchemes'),
  )
  assert.include(forbiddenRequest, 'kind == 51')
  assert.notMatch(forbiddenRequest, /kind == 5\b/)
  assert.notMatch(forbiddenRequest, /kind == 18\b/)
  const read = source.slice(
    source.indexOf('pub fn readPlaintext'),
    source.indexOf('pub fn writePlaintext'),
  )
  assert.isBelow(read.indexOf('terminalError'), read.indexOf('output.length == 0'))
  assert.match(source, /TlsRecordSender\.cancelPending\(&mut client\.sender\)/)
  for (const configuredDefault of [
    'handshakeBodyBytes: 262144',
    'handshakeBytes: 1048576',
    'handshakeMessages: 32',
    'peerCertificates: 16',
    'certificateBytes: 65536',
    'certificateTotalBytes: 262144',
    'cookieBytes: 4096',
    'extensionBytes: 65535',
    'emptyRecords: 32',
    'postHandshakeControls: 64',
    'tickets: 8',
    'ticketBytes: 262144',
  ]) {
    assert.include(source, configuredDefault)
  }
  for (const kind of [
    'HandshakeBodyBytes',
    'HandshakeBytes',
    'HandshakeMessages',
    'PeerCertificates',
    'CertificateBytes',
    'CertificateTotalBytes',
    'CookieBytes',
    'ExtensionBytes',
    'EmptyRecords',
    'PostHandshakeControls',
    'Tickets',
    'TicketBytes',
    'Arithmetic',
    'Alpn',
    'CertificateDecode',
    'CertificateSanDecode',
    'CertificateIdentity',
    'CertificatePath',
    'CertificateProfile',
  ]) {
    assert.include(source, `TlsLimitKind.${kind}`)
  }
  assert.include(tlsClientClosureControlNativeSource, 'exactPeerAlert(move failed, 40)')
  assert.include(tlsClientClosureControlNativeSource, 'TlsError.BadRecordMac')
  assert.include(tlsClientClosureControlNativeSource, 'TlsError.HandshakeTruncated')
})

it('keeps focused TLS client witnesses independent and bounded', () => {
  const nativeSources = [
    tlsClientCoreNativeSource,
    tlsClientDemandRequestNativeSource,
    tlsClientKeyUpdateNativeSource,
    tlsClientClosureControlNativeSource,
    tlsClientHandshakePolicyNativeSource,
    tlsClientResourcePolicyNativeSource,
  ]
  assert.notStrictEqual(tlsClientWasmSource, tlsClientCoreNativeSource)
  assert.include(tlsClientWasmSource, 'value.suite() == CipherSuite.ChaCha20Poly1305Sha256')
  assert.include(tlsClientWasmSource, 'client.readPlaintext(&mut plaintext)')
  assert.notInclude(tlsClientWasmSource, 'let aes128Flight =')
  assert.notInclude(tlsClientWasmSource, 'let retryFlight =')
  for (const source of nativeSources) {
    assert.include(source, 'silk_tls_fixture_copy')
    assert.lengthOf(source.match(/Client\.make\(/g) ?? [], 1)
    assert.notInclude(source, 'while id <= 62')
    assert.notMatch(source, /if run [^\n]+ !=/)
  }
  assert.lengthOf(tlsClientKeyUpdateNativeSource.match(/provideMut<Allocator>/g) ?? [], 1)
  assert.lengthOf(tlsClientKeyUpdateNativeSource.match(/provideMut<Random>/g) ?? [], 1)
  assert.lengthOf(tlsClientDemandRequestNativeSource.match(/provideMut<Allocator>/g) ?? [], 1)
  assert.lengthOf(tlsClientDemandRequestNativeSource.match(/provideMut<Random>/g) ?? [], 1)
  assert.isBelow(tlsClientDemandRequestNativeSource.length, tlsClientCoreNativeSource.length)
  assert.lengthOf(tlsClientClosureControlNativeSource.match(/provideMut<Allocator>/g) ?? [], 1)
  assert.lengthOf(tlsClientClosureControlNativeSource.match(/provideMut<Random>/g) ?? [], 1)
  assert.lengthOf(tlsClientHandshakePolicyNativeSource.match(/provideMut<Allocator>/g) ?? [], 1)
  assert.lengthOf(tlsClientHandshakePolicyNativeSource.match(/provideMut<Random>/g) ?? [], 1)
  assert.lengthOf(tlsClientResourcePolicyNativeSource.match(/provideMut<Allocator>/g) ?? [], 3)
  assert.lengthOf(tlsClientResourcePolicyNativeSource.match(/provideMut<Random>/g) ?? [], 1)
  assert.include(tlsClientKeyUpdateNativeSource, 'let oversized = run Bytes.zeroed(16385)')
  assert.include(tlsClientKeyUpdateNativeSource, 'value.consumed == 16384')
  assert.include(tlsClientKeyUpdateNativeSource, 'value.consumed == usize.ONE')
  assert.include(
    tlsClientKeyUpdateNativeSource,
    'sameBytes(client.pendingOutput(), Bytes.asSlice(&stable))',
  )
  assert.include(tlsClientDemandRequestNativeSource, 'let coalesced = run loadFixture(65)')
  assert.include(
    tlsClientDemandRequestNativeSource,
    'feedToDemand(&mut client, Bytes.asSlice(&coalesced), Demand.NeedOutput)',
  )
  assert.include(tlsClientResourcePolicyNativeSource, 'TlsLimitKind.Alpn, 1024)')
  for (const kind of [
    'HandshakeBodyBytes',
    'HandshakeBytes',
    'HandshakeMessages',
    'PeerCertificates',
    'CertificateBytes',
    'CertificateTotalBytes',
    'CookieBytes',
    'ExtensionBytes',
    'EmptyRecords',
    'PostHandshakeControls',
    'Tickets',
    'TicketBytes',
    'Alpn',
    'CertificateDecode',
    'CertificateSanDecode',
    'CertificateIdentity',
    'CertificatePath',
    'CertificateProfile',
  ]) {
    assert.include(tlsClientResourcePolicyNativeSource, `TlsLimitKind.${kind}`)
  }
  // The production-source guard above owns Arithmetic: no wire-valid configured value can reach
  // that fallback on current targets, so the native resource witness must not invent one.
  assert.notInclude(tlsClientResourcePolicyNativeSource, 'TlsLimitKind.Arithmetic')
  assert.include(
    tlsClientHandshakePolicyNativeSource,
    'let expectedCertificate = run loadFixture(46)',
  )
  assert.include(tlsClientHandshakePolicyNativeSource, 'let expectedFinished = run loadFixture(47)')
  assert.include(tlsClientHandshakePolicyNativeSource, 'random.filled != expectedEntropy')
  assert.include(tlsClientHandshakePolicyNativeSource, 'return run matchesHello(&client, 52)')
  assert.notInclude(tlsClientHandshakePolicyNativeSource, 'let expected = run loadFixture(52)')
  assert.include(
    tlsClientDemandRequestNativeSource,
    'feedToDemand(&mut client, Bytes.asSlice(&flight), Demand.NeedOutput)',
  )
  assert.include(tlsClientDemandRequestNativeSource, 'while id <= 8')
  const demandDriven = tlsClientDemandRequestNativeSource.slice(
    tlsClientDemandRequestNativeSource.indexOf('effect fn feedToDemand'),
    tlsClientDemandRequestNativeSource.indexOf('fn requestFixture'),
  )
  assert.isNotEmpty(demandDriven)
  assert.notInclude(demandDriven, 'Client.progress')
  assert.include(demandDriven, 'progress.demand == expected && expected != Demand.NeedInput')
  for (const fixtureId of [58, 59, 60, 61, 62, 63, 64, 65, 66]) {
    assert.include(tlsClientNativeFixtureSource, `case ${fixtureId}:`)
  }
  assert.deepEqual(tlsClientFragmentationKinds.initialFlight, [2, 8, 11, 15, 20])
  assert.deepEqual(tlsClientFragmentationKinds.keyUpdate, [24])
  assert.include(
    tlsClientCoreNativeSource,
    'run feedCoreFragments(&mut client, Bytes.asSlice(&flight))',
  )
  assert.include(
    tlsClientCoreNativeSource,
    'let fragment = Slice.view<u8>(input, offset, usize.ONE)',
  )
  assert.include(tlsClientCoreNativeSource, 'let mut index: usize = 5')
  assert.include(
    tlsClientKeyUpdateNativeSource,
    'let code = run feedFragments(&mut client, Bytes.asSlice(&malformed))',
  )
  assert.include(tlsClientClosureControlNativeSource, 'TlsError.HandshakeTruncated')
  assert.include(tlsClientClosureControlNativeSource, 'fn isEmptyBuffer(')
  assert.include(
    tlsClientClosureControlNativeSource,
    '&& isEmptyBuffer(client.readPlaintext(&mut empty))',
  )
  assert.include(
    tlsClientClosureControlNativeSource,
    '&& isTruncated(client.readPlaintext(&mut plaintext))',
  )
  const resourceOwnerStart = tlsClientResourcePolicyNativeSource.indexOf('effect fn limitsCase')
  const resourceHelpersStart = tlsClientResourcePolicyNativeSource.indexOf(
    'effect fn feedComplete',
    resourceOwnerStart,
  )
  const resourceOwner = tlsClientResourcePolicyNativeSource.slice(
    resourceOwnerStart,
    resourceHelpersStart,
  )
  assert.isNotEmpty(resourceOwner)
  assert.notInclude(resourceOwner, '&mut client.*')
  assert.lengthOf(resourceOwner.match(/&mut client/g) ?? [], 14)
  const resourceHelpers = tlsClientResourcePolicyNativeSource.slice(
    resourceHelpersStart,
    tlsClientResourcePolicyNativeSource.indexOf('effect fn runLimitCase', resourceHelpersStart),
  )
  assert.lengthOf(resourceHelpers.match(/&mut client\.\*/g) ?? [], 3)
  assert.include(resourceHelpers, 'Client.ackWritten(&mut client.*, length)')
  assert.include(tlsClientNativeFixtureSource, 'static const uint8_t fixture_0[]')
  assert.notInclude(tlsClientNativeFixtureSource, 'silk_tls_mark')
})

it('pins certificate-profile fixture provenance and DER digests', () => {
  assert.strictEqual(
    certificateProfileFixtures.source,
    'https://github.com/C2SP/x509-limbo/blob/3f8cba420e90322223486086054401189b7b320e/limbo.json',
  )
  assert.strictEqual(
    certificateProfileFixtures.sourceSha256,
    '563805f46937ad25ac9d4e41341c414070aced32a22294821b5c5fe526e2c52d',
  )
  assert.strictEqual(certificateProfileFixtures.license, 'Apache-2.0')
  for (const fixture of certificateProfileFixtures.fixtures) {
    assert.strictEqual(
      createHash('sha256').update(Buffer.from(fixture.der, 'base64')).digest('hex'),
      fixture.sha256,
      fixture.id,
    )
    assert.isNotEmpty(fixture.profileOutcome, fixture.id)
  }
})

it('pins certificate-path fixture provenance, ordering, and DER/key digests', () => {
  assert.strictEqual(
    certificatePathFixtures.source,
    'https://github.com/C2SP/x509-limbo/blob/3f8cba420e90322223486086054401189b7b320e/limbo.json',
  )
  assert.strictEqual(
    certificatePathFixtures.sourceSha256,
    '563805f46937ad25ac9d4e41341c414070aced32a22294821b5c5fe526e2c52d',
  )
  assert.strictEqual(
    certificatePathFixtures.zigHttpParityCommit,
    '1bc892110da738d6137b3f0b7e8e3a586ce09928',
  )
  assert.strictEqual(certificatePathFixtures.cases.length, 22)
  for (const fixture of certificatePathFixtures.cases) {
    const certificates = [fixture.peer, ...fixture.intermediates, ...fixture.anchors]
    for (const certificate of certificates) {
      assert.strictEqual(
        createHash('sha256').update(Buffer.from(certificate.der, 'base64')).digest('hex'),
        certificate.sha256,
        fixture.id,
      )
    }
    assert.strictEqual(fixture.peerKeyPemSha256.length, 64, fixture.id)
    assert.deepEqual(
      fixture.ordering.intermediates,
      fixture.intermediates.map((_, index) => index),
      fixture.id,
    )
    assert.deepEqual(
      fixture.ordering.anchors,
      fixture.anchors.map((_, index) => index),
      fixture.id,
    )
  }
  assert.deepEqual(
    certificatePathFixtures.cases.find(
      (fixture) => fixture.id === 'rfc5280::nc::nc-forbids-alternate-chain-ica',
    )?.expectedSilk,
    { result: 'Success', anchorIndex: 0, intermediateIndices: [2, 0] },
  )
  assert.deepEqual(
    certificatePathFixtures.projectFixtures.map((fixture) => fixture.id),
    [
      'source::rfc5280::no-keyusage/peer_certificate',
      'silk::empty-subject-missing-san/peer_certificate',
      'silk::empty-subject-noncritical-san/peer_certificate',
      'silk::empty-subject-empty-critical-san/peer_certificate',
      'silk::wrong-signature-first/intermediates[0]',
      'silk::ignored-anchor-validity-self-signature/trusted_certs[0]',
      'silk::missing-ec-parameters/trusted_certs[0]',
      'silk::unsupported-signature-parameters/intermediates[0]',
      'silk::unsupported-signature-algorithm/intermediates[0]',
      'silk::mismatching-signature-algorithms/intermediates[0]',
      'silk::certificate-policy/intermediates[0]',
      'silk::tls-feature/intermediates[0]',
    ],
  )
  assert.deepEqual(
    certificatePathFixtures.projectFixtures.find(
      (fixture) => fixture.id === 'silk::unsupported-signature-parameters/intermediates[0]',
    )?.expectedSilk,
    { result: 'Failure', reason: 'UnsupportedParameters' },
  )
  for (const id of [
    'silk::empty-subject-missing-san/peer_certificate',
    'silk::empty-subject-noncritical-san/peer_certificate',
    'silk::empty-subject-empty-critical-san/peer_certificate',
  ]) {
    assert.deepEqual(
      certificatePathFixtures.projectFixtures.find((fixture) => fixture.id === id)?.expectedSilk,
      { result: 'Failure', reason: 'InvalidName' },
      id,
    )
  }
  for (const fixture of certificatePathFixtures.projectFixtures) {
    assert.strictEqual(
      createHash('sha256').update(Buffer.from(fixture.der, 'base64')).digest('hex'),
      fixture.sha256,
      fixture.id,
    )
    assert.isNotEmpty(fixture.sourceCase, fixture.id)
    assert.isNotEmpty(fixture.sourceCertificateRole, fixture.id)
    assert.strictEqual(fixture.sourceCertificateSha256.length, 64, fixture.id)
    assert.isNotEmpty(fixture.mutation, fixture.id)
    assert.match(fixture.expectedSilk.result, /^(Success|Failure)$/, fixture.id)
  }
})

it('regenerates the native trust PEM from its named certificate-profile fixture', () => {
  const fixture = certificateProfileFixtures.fixtures.find(
    (candidate) => candidate.id === 'rfc5280::no-keyusage/trusted_certs[0]',
  )
  assert.isDefined(fixture)
  if (fixture === undefined) return
  const pem = readFileSync(new URL('../conformance/native-filesystem/trust.pem', import.meta.url))
  const certificate = new X509Certificate(pem)
  assert.strictEqual(pem.length, 603)
  assert.strictEqual(
    createHash('sha256').update(pem).digest('hex'),
    'e409d0b059a0e9124f42c0dbf95b2611525d605de9ef591a5f48e6e8754fe7b6',
  )
  assert.deepEqual(certificate.raw, Buffer.from(fixture.der, 'base64'))
  assert.strictEqual(
    createHash('sha256').update(certificate.raw).digest('hex'),
    '2ffcf7efc81cbd3f7f2aa126fa6de0663e011ed71e7cdf2bec63a6c2af828455',
  )
  const generated = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../conformance/native-filesystem/generate-trust-fixture.mjs', import.meta.url),
      ),
      '--check',
    ],
    { encoding: 'utf8' },
  )
  assert.strictEqual(generated.status, 0, generated.stderr)
  assert.include(generated.stdout, fixture.id)
})

it.effect(
  'keeps Bytes move-only and rejects exclusive field projection through shared access',
  () =>
    Effect.gen(function* () {
      const moved = yield* AnalysisFixture.retainingMain(
        'bytes-acceptance/moved',
        ascii(`import silk.usize
import silk.bytes { Bytes }
pub fn main() -> i32 {
  let first = Bytes.make()
  let second = move first
  return usize.toI32(Bytes.length(&first))
}`),
      )
      assert.include(
        Analysis.diagnostics(moved).map((diagnostic) => diagnostic.code),
        'OWN0001',
      )

      const shared = yield* AnalysisFixture.retainingMain(
        'bytes-acceptance/shared-field',
        ascii(`struct Wrapper { values: [u8; 1] }
fn consume(values: &mut [u8]) -> () { return () }
fn invalid(self: &Wrapper) -> () { return consume(&mut self.values) }
pub fn main() -> i32 { return 0 }`),
      )
      // `self` is a shared view, so its field cannot be reborrowed exclusively (BORROW-005).
      assert.include(
        Analysis.diagnostics(shared).map((diagnostic) => diagnostic.code),
        'SEM0058',
      )
    }),
)

it.effect('keeps decoded certificate owners move-only and their returned views borrowed', () =>
  Effect.gen(function* () {
    const source = `import silk.certificate { Certificate }
import silk.certificate_bundle { CertificateBundle }
import silk.certificate_profile { CertificateProfile, CertificateRole, ProfileLimits, ProfileError }
import silk.certificate_path { CertificatePath }
import silk.result { Result }
import silk.trust_anchor { TrustAnchor }
import silk.usize
fn moved(value: Certificate) -> usize {
  let next = move value
  return Certificate.extensionCount(&value)
}
fn bundleMoved(value: CertificateBundle) -> usize {
  let next = move value
  return CertificateBundle.length(&value)
}
fn viewed(value: Certificate) -> usize {
  let bytes = Certificate.der(&value)
  drop value
  return bytes.length
}
fn profile<'a>(certificate: &'a Certificate) -> Result<CertificateProfile<'a>, ProfileError> {
  return CertificateProfile.inspect(certificate, CertificateRole.Anchor, ProfileLimits.defaults())
}
fn anchor(certificate: Certificate) -> usize {
  let value = TrustAnchor.fromCertificate(move certificate)
  return TrustAnchor.encodedBytes(&value)
}
fn anchorMoved(value: TrustAnchor) -> usize {
  let next = move value
  return TrustAnchor.encodedBytes(&value)
}
pub fn main() -> i32 { return 0 }`
    const ownership = yield* AnalysisFixture.retainingMain(
      'certificate-acceptance/owner-and-view',
      ascii(source),
    )
    // The same snapshot includes decoder ownership facts: partial DER traversal/index storage,
    // decoded PEM bytes, and a partially accumulated bundle must have reclaiming failure exits.
    const partialStates = [
      { module: 'silk/certificate', operation: 'openValue', bindings: ['frames'] },
      { module: 'silk/certificate', operation: 'Certificate.decodeDer', bindings: ['extensions'] },
      { module: 'silk/certificate', operation: 'Certificate.decodePem', bindings: ['value'] },
      {
        module: 'silk/certificate_bundle',
        operation: 'CertificateBundle.decodePem',
        bindings: ['certificates', 'block', 'certificate'],
      },
      {
        module: 'silk/certificate',
        operation: 'Certificate.copy',
        bindings: ['bytes', 'extensions'],
      },
      {
        module: 'silk/trust_anchor',
        operation: 'TrustAnchor.fromCertificateWithConstraints',
        bindings: ['certificate'],
      },
      { module: 'silk/trust_anchor', operation: 'TrustAnchor.clone', bindings: ['certificate'] },
      {
        module: 'silk/certificate_path',
        operation: 'CertificatePath.validate',
        bindings: ['path', 'frames'],
      },
    ]
    for (const state of partialStates) {
      const operation = Analysis.ownershipOf(ownership, state.module)?.functions.find(
        (candidate) =>
          candidate.declaration.canonical._tag === 'Canonical' &&
          candidate.declaration.canonical.id.name === state.operation,
      )
      const releases =
        operation?.exits
          .filter((exit) => exit.kind === 'Propagation')
          .flatMap((exit) => exit.releases) ?? []
      for (const binding of state.bindings) {
        const partial = releases.filter((release) => release.binding.name === binding)
        assert.isNotEmpty(partial, `${state.operation}: ${binding}`)
        assert.isTrue(
          partial.every((release) => CleanupPlan.reclaims(release.cleanup)),
          `${state.operation}: ${binding}`,
        )
      }
    }
    const diagnostics = Analysis.diagnostics(ownership)
    assert.deepEqual(
      diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        text: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0001', text: '&value' },
        { code: 'OWN0001', text: '&value' },
        { code: 'OWN0011', text: 'value' },
        { code: 'OWN0019', text: 'bytes' },
        { code: 'OWN0001', text: '&value' },
      ],
    )
  }),
)

it.effect('keeps trust snapshots opaque, move-only, borrowed, and lexically service-loaded', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.filesystem { Path }
import silk.memory_trust_source { MemoryTrustSource }
import silk.native_file_trust_source { NativeFileTrustSource }
import silk.result { Result }
import silk.trust_anchor { TrustAnchor }
import silk.trust_snapshot { TrustLoadLimits, TrustSnapshot, TrustSourceError }
import silk.trust_source { TrustSource }
import silk.usize
import silk.vector { Vector }
fn moved(value: TrustSnapshot) -> usize {
  let next = move value
  return TrustSnapshot.anchors(&value).length
}
fn viewed(value: TrustSnapshot) -> usize {
  let anchors = TrustSnapshot.anchors(&value)
  drop value
  return anchors.length
}
fn provider(snapshot: TrustSnapshot) -> MemoryTrustSource {
  return MemoryTrustSource.make(move snapshot)
}
effect fn nativeProvider(root: Bytes, path: Path) -> NativeFileTrustSource
! TrustSourceError | OutOfMemoryError
? &mut Allocator {
  let source = run NativeFileTrustSource.make(Bytes.asSlice(&root), &path)
  drop root
  drop path
  return move source
}
fn replace(source: &mut MemoryTrustSource, next: TrustSnapshot) -> TrustSnapshot {
  return MemoryTrustSource.replace(move source, move next)
}
fn forged() -> TrustSnapshot {
  return TrustSnapshot { anchorsValue: Vector<TrustAnchor>.make() }
}
fn limitFailure(result: Result<TrustSnapshot, TrustSourceError>) -> bool {
  return match move result {
    Result<TrustSnapshot, TrustSourceError>.Failure {
      error: TrustSourceError.LimitExceeded { kind, limit }
    } => true
    _ => false
  }
}
effect fn load(limits: TrustLoadLimits) -> TrustSnapshot
! TrustSourceError | OutOfMemoryError
? &mut TrustSource | &mut Allocator {
  return run TrustSource.load(limits)
}
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'trust-source/ownership-and-requirements',
      ascii(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        text: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0001', text: '&value' },
        { code: 'OWN0011', text: 'value' },
        { code: 'OWN0019', text: 'anchors' },
        {
          code: 'SEM0021',
          text: 'TrustSnapshot { anchorsValue: Vector<TrustAnchor>.make() }',
        },
      ],
    )

    const partialStates = [
      {
        module: 'silk/trust_snapshot',
        operation: 'TrustSnapshot.fromPem',
        bindings: ['certificates', 'anchors'],
      },
      { module: 'silk/trust_snapshot', operation: 'TrustSnapshot.copy', bindings: ['copied'] },
      {
        module: 'silk/trust_snapshot',
        operation: 'TrustSnapshot.combine',
        bindings: ['combined'],
      },
    ]
    for (const state of partialStates) {
      const operation = Analysis.ownershipOf(snapshot, state.module)?.functions.find(
        (candidate) =>
          candidate.declaration.canonical._tag === 'Canonical' &&
          candidate.declaration.canonical.id.name === state.operation,
      )
      const releases =
        operation?.exits
          .filter((exit) => exit.kind === 'Propagation')
          .flatMap((exit) => exit.releases) ?? []
      for (const binding of state.bindings) {
        const partial = releases.filter((release) => release.binding.name === binding)
        assert.isNotEmpty(partial, `${state.operation}: ${binding}`)
        assert.isTrue(
          partial.every((release) => CleanupPlan.reclaims(release.cleanup)),
          `${state.operation}: ${binding}`,
        )
      }
    }
  }),
)

it.effect('keeps HTTPS reference and SAN payload borrows within caller storage', () =>
  Effect.gen(function* () {
    const source = `import silk.https_identity { HttpsIdentity, OriginHost, ReferenceIdentity, CertificateIdentities, PresentedIdentity, IdentityLimits, IdentityMatch, IdentityError }
import silk.result { Result }
import silk.certificate { Certificate }
import silk.certificate_identities { CertificateSan, SanDecodeLimits, SanDecodeSummary, SanDecodeError }
import silk.usize
fn decodeBorrowed<'a>(certificate: &'a Certificate, storage: &mut [PresentedIdentity<'a>]) -> Result<SanDecodeSummary, SanDecodeError> {
  return CertificateSan.decode(certificate, &mut storage, SanDecodeLimits.standard())
}
fn decodeEscapes<'a>(certificate: Certificate, storage: &mut [PresentedIdentity<'a>]) -> Result<SanDecodeSummary, SanDecodeError> {
  return CertificateSan.decode(&certificate, &mut storage, SanDecodeLimits.standard())
}
fn forwarded<'a>(bytes: &'a [u8]) -> Result<ReferenceIdentity<'a>, IdentityError> {
  return HttpsIdentity.reference(OriginHost.Dns { bytes: bytes })
}
fn escaped<'a>(input: &'a [u8]) -> Result<ReferenceIdentity<'a>, IdentityError> {
  let bytes: [u8; 1] = [97]
  return HttpsIdentity.reference(OriginHost.Dns { bytes: &bytes })
}
fn certificateView<'a>(entries: &'a [PresentedIdentity<'a>]) -> CertificateIdentities<'a> {
  return CertificateIdentities<'a>.Decoded { entries: entries }
}
fn conflict() -> Result<IdentityMatch, IdentityError> {
  let mut bytes: [u8; 1] = [97]
  let reference = ReferenceIdentity.Dns { bytes: &bytes }
  let entries = [PresentedIdentity.Dns { bytes: b"a" }]
  let certificate = certificateView(&entries)
  bytes[0] = 98
  return HttpsIdentity.verify(&reference, &certificate, IdentityLimits.standard())
}
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* AnalysisFixture.retainingMain('https-identity/ownership', ascii(source))
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'SEM0212', span: '&certificate' },
        { code: 'OWN0019', span: 'HttpsIdentity.reference(OriginHost.Dns { bytes: &bytes })' },
        { code: 'OWN0019', span: 'HttpsIdentity.reference(OriginHost.Dns { bytes: &bytes })' },
        { code: 'SEM0212', span: '&bytes' },
        { code: 'OWN0011', span: 'bytes[0]' },
        { code: 'OWN0019', span: '&reference' },
      ],
    )
  }),
)

it.effect('binds validated certificate paths to every borrowed certificate input', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.certificate { Certificate }
import silk.certificate_path { CertificatePath, ValidatedPath, ValidationError, ValidationLimits }
import silk.result { Result }
import silk.system_clock { Instant }
import silk.trust_anchor { TrustAnchor }
effect fn forwarded<'a>(
  leaf: &'a Certificate,
  intermediates: &'a [Certificate],
  anchors: &'a [TrustAnchor],
  at: &Instant,
) -> Result<ValidatedPath<'a>, ValidationError> ! OutOfMemoryError ? &mut Allocator {
  return run CertificatePath.validate(leaf, intermediates, anchors, at, ValidationLimits.defaults())
}
effect fn leafEscapes<'a>(
  leaf: Certificate,
  intermediates: &'a [Certificate],
  anchors: &'a [TrustAnchor],
  at: &Instant,
) -> Result<ValidatedPath<'a>, ValidationError> ! OutOfMemoryError ? &mut Allocator {
  return run CertificatePath.validate(&leaf, intermediates, anchors, at, ValidationLimits.defaults())
}
effect fn intermediatesEscape<'a>(
  leaf: &'a Certificate,
  intermediates: [Certificate; 1],
  anchors: &'a [TrustAnchor],
  at: &Instant,
) -> Result<ValidatedPath<'a>, ValidationError> ! OutOfMemoryError ? &mut Allocator {
  return run CertificatePath.validate(leaf, &intermediates, anchors, at, ValidationLimits.defaults())
}
effect fn anchorsEscape<'a>(
  leaf: &'a Certificate,
  intermediates: &'a [Certificate],
  anchors: [TrustAnchor; 1],
  at: &Instant,
) -> Result<ValidatedPath<'a>, ValidationError> ! OutOfMemoryError ? &mut Allocator {
  return run CertificatePath.validate(leaf, intermediates, &anchors, at, ValidationLimits.defaults())
}
fn moved<'a>(value: ValidatedPath<'a>) -> usize {
  let next = move value
  return value.anchorIndex()
}
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* Analysis.ofSourceRealized(
      'certificate-path/borrowed-result',
      ascii(source),
    )
    const diagnostics = Analysis.diagnostics(snapshot).map((diagnostic) => ({
      code: diagnostic.code,
      span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
    }))
    const distinct = diagnostics.filter(
      (diagnostic, index) =>
        diagnostics.findIndex(
          (candidate) => candidate.code === diagnostic.code && candidate.span === diagnostic.span,
        ) === index,
    )
    assert.deepEqual(distinct, [
      {
        code: 'OWN0019',
        span: 'run CertificatePath.validate(&leaf, intermediates, anchors, at, ValidationLimits.defaults())',
      },
      { code: 'SEM0212', span: '&leaf' },
      {
        code: 'OWN0019',
        span: 'run CertificatePath.validate(leaf, &intermediates, anchors, at, ValidationLimits.defaults())',
      },
      { code: 'SEM0212', span: '&intermediates' },
      {
        code: 'OWN0019',
        span: 'run CertificatePath.validate(leaf, intermediates, &anchors, at, ValidationLimits.defaults())',
      },
      { code: 'SEM0212', span: '&anchors' },
      { code: 'OWN0001', span: 'value' },
    ])
  }),
)
