import fixtures from '../fixtures/certificate-profile-limbo.json' with { type: 'json' }

const literal = (bytes: Uint8Array): string =>
  `b"${Array.from(bytes, (byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`

const selected = fixtures.fixtures.find(
  (fixture) => fixture.id === 'rfc5280::no-keyusage/trusted_certs[0]',
)
if (selected === undefined) throw new Error('Missing pinned trust-source certificate fixture')

const der = Buffer.from(selected.der, 'base64')
const pemText = `-----BEGIN CERTIFICATE-----\n${selected.der.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`
const twoPem = Buffer.from(`${pemText}${pemText}`)
const malformedLaterPem = Buffer.from(
  `${pemText}-----BEGIN CERTIFICATE-----\n@@@\n-----END CERTIFICATE-----\n`,
)

const imports = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.certificate { Certificate, DecodeError, DecodeLimits, DecodeReason }
import silk.certificate_profile { ProfileError, ProfileLimits }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.memory_trust_source { MemoryTrustSource }
import silk.option { Option }
import silk.result { Result }
import silk.trust_anchor { TrustAnchor }
import silk.trust_snapshot { SnapshotLimits, TrustLimitKind, TrustLoadLimits, TrustSnapshot, TrustSourceError }
import silk.trust_source { TrustSource }
import silk.usize
import silk.vector { Vector }
`

const helpers = `
fn limits(anchors: usize, bytes: usize) -> SnapshotLimits {
  return SnapshotLimits { anchors: anchors, encodedBytes: bytes }
}

effect fn decoded() -> Certificate ! OutOfMemoryError ? &mut Allocator {
  let result = run Certificate.decodeDer(${literal(der)}, DecodeLimits.defaults())
  return match move result {
    Result<Certificate, DecodeError>.Success { value } => move value
    Result<Certificate, DecodeError>.Failure { error } => { let invalid = 1 / 0 return run decoded() }
  }
}

effect fn plainAnchor() -> TrustAnchor ! OutOfMemoryError ? &mut Allocator {
  let certificate = run decoded()
  return TrustAnchor.fromCertificate(move certificate)
}

effect fn restrictedAnchor() -> TrustAnchor ! OutOfMemoryError ? &mut Allocator {
  let certificate = run decoded()
  let constraint: [u8; 19] = [
    48, 17, 160, 15, 48, 13, 130, 11, 101, 120,
    97, 109, 112, 108, 101, 46, 99, 111, 109,
  ]
  let result = run TrustAnchor.fromCertificateWithConstraints(
    move certificate,
    Option<usize>.some(2),
    Option<&[u8]>.some(&constraint),
    ProfileLimits.defaults(),
  )
  return match move result {
    Result<TrustAnchor, ProfileError>.Success { value } => move value
    Result<TrustAnchor, ProfileError>.Failure { error } => { let invalid = 1 / 0 return run restrictedAnchor() }
  }
}

fn snapshot(result: Result<TrustSnapshot, TrustSourceError>) -> TrustSnapshot {
  return match move result {
    Result<TrustSnapshot, TrustSourceError>.Success { value } => move value
    Result<TrustSnapshot, TrustSourceError>.Failure { .. } => {
      let invalid = 1 / 0
      return snapshot(TrustSnapshot.fromAnchors(Vector<TrustAnchor>.make(), limits(0, 0)))
    }
  }
}

fn limitFailure(
  result: Result<TrustSnapshot, TrustSourceError>,
  expected: TrustLimitKind,
  limit: usize,
) -> bool {
  return match move result {
    Result<TrustSnapshot, TrustSourceError>.Success { value } => false
    Result<TrustSnapshot, TrustSourceError>.Failure { error } => match move error {
      TrustSourceError.LimitExceeded { kind, limit: actual } => kind == expected && actual == limit
      _ => false
    }
  }
}

fn pathLength(anchor: &TrustAnchor, expected: usize) -> bool {
  return match move TrustAnchor.configuredPathLength(anchor) {
    Option<usize>.Some { value } => value == expected
    Option<usize>.None => false
  }
}

fn noPathLength(anchor: &TrustAnchor) -> bool {
  return match move TrustAnchor.configuredPathLength(anchor) {
    Option<usize>.Some { value } => false
    Option<usize>.None => true
  }
}

fn snapshotShape(value: &TrustSnapshot, expected: usize) -> bool {
  let anchors = TrustSnapshot.anchors(value)
  return anchors.length == expected
}

effect fn loadedCount() -> usize
! TrustSourceError | OutOfMemoryError
? &mut TrustSource | &mut Allocator {
  let loaded = run TrustSource.load(TrustLoadLimits.defaults())
  let anchors = TrustSnapshot.anchors(&loaded)
  return anchors.length
}

effect fn nestedCounts(inner: &mut MemoryTrustSource) -> usize
! TrustSourceError | OutOfMemoryError
? &mut TrustSource | &mut Allocator {
  let outerBefore = run loadedCount()
  let nested = run loadedCount() |> Effect.provideMut<TrustSource>(move inner)
  let outerAfter = run loadedCount()
  return outerBefore * 100 + nested * 10 + outerAfter
}

effect fn loadWithin(
  provider: &mut MemoryTrustSource,
  limits: TrustLoadLimits,
) -> usize
! TrustSourceError | OutOfMemoryError
? &mut Allocator {
  let loaded = run TrustSource.load(limits)
    |> Effect.provideMut<TrustSource>(move provider)
  let anchors = TrustSnapshot.anchors(&loaded)
  return anchors.length
}

effect fn rejectedLimit(error: TrustSourceError) -> usize {
  return match move error {
    TrustSourceError.LimitExceeded { kind, limit } => {
      if kind == TrustLimitKind.AnchorCount { return limit + 70 }
      return 1
    }
    _ => 1
  }
}

struct RefusingAllocator { calls: usize failAt: usize }

effect fn allocate(self: &mut RefusingAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  self.calls = self.calls + usize.ONE
  if self.calls == self.failAt { return run Allocator.outOfMemory() }
  let mut system = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut<Allocator>(&mut system)
}

impl Allocator for RefusingAllocator { allocate: RefusingAllocator.allocate }

effect fn pemSucceeded() -> bool ! OutOfMemoryError ? &mut Allocator {
  let imported = run TrustSnapshot.fromPem(${literal(twoPem)}, TrustLoadLimits.defaults())
  return match move imported {
    Result<TrustSnapshot, TrustSourceError>.Success { value } => snapshotShape(&value, 2)
    Result<TrustSnapshot, TrustSourceError>.Failure { error } => false
  }
}

effect fn allocationFailed(error: OutOfMemoryError) -> bool { return false }
`

const suite = `
effect fn suite() -> i32 ! TrustSourceError | OutOfMemoryError ? &mut Allocator {
  let defaults = SnapshotLimits.defaults()
  if defaults.anchors != 1024 || defaults.encodedBytes != 8388608 { return 2 }
  let loadDefaults = TrustLoadLimits.defaults()
  if loadDefaults.snapshot.anchors != 1024 || loadDefaults.decode.inputBytes != 16777216 { return 3 }

  let empty = snapshot(TrustSnapshot.fromAnchors(Vector<TrustAnchor>.make(), limits(0, 0)))
  if !snapshotShape(&empty, 0) { return 4 }

  let mut tooMany = Vector<TrustAnchor>.make()
  let one = run plainAnchor()
  let appended = run Vector<TrustAnchor>.append(&mut tooMany, move one)
  if !limitFailure(TrustSnapshot.fromAnchors(move tooMany, limits(0, 100000)), TrustLimitKind.AnchorCount, 0) { return 5 }

  let mut tooLarge = Vector<TrustAnchor>.make()
  let large = run plainAnchor()
  let largeBytes = TrustAnchor.encodedBytes(&large)
  let appendedLarge = run Vector<TrustAnchor>.append(&mut tooLarge, move large)
  if !limitFailure(TrustSnapshot.fromAnchors(move tooLarge, limits(1, largeBytes - 1)), TrustLimitKind.EncodedBytes, largeBytes - 1) { return 6 }

  let mut values = Vector<TrustAnchor>.make()
  let first = run plainAnchor()
  let firstBytes = TrustAnchor.encodedBytes(&first)
  let second = run restrictedAnchor()
  let secondBytes = TrustAnchor.encodedBytes(&second)
  let appendedFirst = run Vector<TrustAnchor>.append(&mut values, move first)
  let appendedSecond = run Vector<TrustAnchor>.append(&mut values, move second)
  let primary = snapshot(TrustSnapshot.fromAnchors(move values, limits(2, firstBytes + secondBytes)))
  let primaryValues = TrustSnapshot.anchors(&primary)
  if primaryValues.length != 2 || !noPathLength(&primaryValues[0]) || !pathLength(&primaryValues[1], 2) { return 7 }

  let copyCountRejected = run TrustSnapshot.copy(&primary, limits(1, firstBytes + secondBytes))
  if !limitFailure(move copyCountRejected, TrustLimitKind.AnchorCount, 1) { return 24 }
  let copyBytesRejected = run TrustSnapshot.copy(&primary, limits(2, firstBytes + secondBytes - 1))
  if !limitFailure(move copyBytesRejected, TrustLimitKind.EncodedBytes, firstBytes + secondBytes - 1) { return 25 }

  let copiedResult = run TrustSnapshot.copy(&primary, limits(2, firstBytes + secondBytes))
  let copied = snapshot(move copiedResult)
  drop primary
  let copiedValues = TrustSnapshot.anchors(&copied)
  if copiedValues.length != 2 || !noPathLength(&copiedValues[0]) || !pathLength(&copiedValues[1], 2) { return 8 }

  let mut additionalValues = Vector<TrustAnchor>.make()
  let additionalAnchor = run plainAnchor()
  let appendedAdditional = run Vector<TrustAnchor>.append(&mut additionalValues, move additionalAnchor)
  let additional = snapshot(TrustSnapshot.fromAnchors(move additionalValues, limits(1, firstBytes)))
  let combineCountRejected = run TrustSnapshot.combine(&copied, &additional, limits(2, firstBytes + secondBytes + firstBytes))
  if !limitFailure(move combineCountRejected, TrustLimitKind.AnchorCount, 2) { return 26 }
  let combineBytesRejected = run TrustSnapshot.combine(&copied, &additional, limits(3, firstBytes + secondBytes + firstBytes - 1))
  if !limitFailure(move combineBytesRejected, TrustLimitKind.EncodedBytes, firstBytes + secondBytes + firstBytes - 1) { return 27 }
  let combinedResult = run TrustSnapshot.combine(&copied, &additional, limits(3, firstBytes + secondBytes + firstBytes))
  let combined = snapshot(move combinedResult)
  drop copied
  drop additional
  let combinedValues = TrustSnapshot.anchors(&combined)
  if combinedValues.length != 3 || !noPathLength(&combinedValues[0]) || !pathLength(&combinedValues[1], 2) || !noPathLength(&combinedValues[2]) { return 9 }

  let importedResult = run TrustSnapshot.fromPem(${literal(twoPem)}, TrustLoadLimits.defaults())
  let imported = snapshot(move importedResult)
  if !snapshotShape(&imported, 2) { return 10 }
  let importedValues = TrustSnapshot.anchors(&imported)
  if TrustAnchor.encodedBytes(&importedValues[0]) != firstBytes || TrustAnchor.encodedBytes(&importedValues[1]) != firstBytes { return 11 }

  let mut tightImport = TrustLoadLimits.defaults()
  tightImport.snapshot.anchors = 1
  let importCountRejected = run TrustSnapshot.fromPem(${literal(twoPem)}, tightImport)
  if !limitFailure(move importCountRejected, TrustLimitKind.AnchorCount, 1) { return 28 }

  let emptyPemResult = run TrustSnapshot.fromPem(${literal(Buffer.from(' \n\t'))}, TrustLoadLimits.defaults())
  let emptyRejected = match move emptyPemResult {
    Result<TrustSnapshot, TrustSourceError>.Success { value } => false
    Result<TrustSnapshot, TrustSourceError>.Failure { error } => match move error {
      TrustSourceError.Decode { error: decode } => decode.reason == DecodeReason.EmptyInput
      _ => false
    }
  }
  if !emptyRejected { return 12 }

  let laterResult = run TrustSnapshot.fromPem(${literal(malformedLaterPem)}, TrustLoadLimits.defaults())
  let laterRejected = match move laterResult {
    Result<TrustSnapshot, TrustSourceError>.Success { value } => false
    Result<TrustSnapshot, TrustSourceError>.Failure { error } => match move error {
      TrustSourceError.Decode { error: decode } => decode.certificateIndex == 1
      _ => false
    }
  }
  if !laterRejected { return 13 }

  let mut outer = MemoryTrustSource.make(move combined)
  let innerSnapshot = snapshot(TrustSnapshot.fromAnchors(Vector<TrustAnchor>.make(), limits(0, 0)))
  let mut inner = MemoryTrustSource.make(move innerSnapshot)
  let nested = run nestedCounts(&mut inner) |> Effect.provideMut<TrustSource>(&mut outer)
  if nested != 303 { return 14 }

  let held = run TrustSource.load(TrustLoadLimits.defaults())
    |> Effect.provideMut<TrustSource>(&mut outer)
  let replacement = snapshot(TrustSnapshot.fromAnchors(Vector<TrustAnchor>.make(), limits(0, 0)))
  let old = MemoryTrustSource.replace(&mut outer, move replacement)
  if !snapshotShape(&old, 3) || !snapshotShape(&held, 3) { return 15 }
  let after = run loadedCount() |> Effect.provideMut<TrustSource>(&mut outer)
  if after != 0 { return 16 }
  drop outer
  if !snapshotShape(&held, 3) { return 17 }

  let mut failingProvider = MemoryTrustSource.make(move imported)
  let mut smallLoad = TrustLoadLimits.defaults()
  smallLoad.snapshot.anchors = 1
  let failedCount = run Effect.catch<TrustSourceError>(
    loadWithin(&mut failingProvider, smallLoad),
    rejectedLimit,
  )
  if failedCount != 71 { return 18 }
  let retryCount = run loadWithin(&mut failingProvider, TrustLoadLimits.defaults())
  if retryCount != 2 { return 19 }

  let mut audit = RefusingAllocator { calls: usize.ZERO, failAt: usize.ZERO }
  let calibrated = run Effect.catchAll(
    pemSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
    allocationFailed,
  )
  if !calibrated || audit.calls < 3 { return 20 }
  let allocationCount = audit.calls
  // The first refusal owns nothing, the second follows one successful allocation and therefore
  // exercises partial-owner cleanup, and the calibrated final refusal reaches the deepest owner.
  let failureOrdinals: [usize; 3] = [usize.ONE, usize.ONE + usize.ONE, allocationCount]
  let mut failureIndex = usize.ZERO
  while failureIndex < 3 {
    let failureOrdinal = failureOrdinals[failureIndex]
    audit.calls = usize.ZERO
    audit.failAt = failureOrdinal
    let failed = run Effect.catchAll(
      pemSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
      allocationFailed,
    )
    if failed || audit.calls != failureOrdinal { return 21 }
    failureIndex = failureIndex + usize.ONE
  }
  audit.calls = usize.ZERO
  audit.failAt = usize.ZERO
  let retried = run Effect.catchAll(
    pemSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
    allocationFailed,
  )
  if !retried { return 22 }

  return 42
}

effect fn trustExit(error: TrustSourceError) -> i32 { return 98 }

effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run suite()
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.catch<TrustSourceError>(trustExit)
}

effect fn allocationExit(error: OutOfMemoryError) -> i32 { return 99 }

pub fn main() -> i32 { return run Effect.catchAll(allocated(), allocationExit) }
`

/**
 * One consolidated target-neutral trust-snapshot and replaceable-source witness. Certificate DER
 * comes from the SHA-256-pinned Apache-2.0 x509-limbo selection already committed for JUL-185.
 */
export const trustSourceAcceptanceSource = `${imports}${helpers}${suite}`

/** Compact Wasm witness for empty explicit trust and one independent copied owner. */
export const trustSourceWasmSource = `${imports}
effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let empty = TrustSnapshot.fromAnchors(
    Vector<TrustAnchor>.make(),
    SnapshotLimits { anchors: usize.ZERO, encodedBytes: usize.ZERO },
  )
  let original = match move empty {
    Result<TrustSnapshot, TrustSourceError>.Failure { error } => { return 1 }
    Result<TrustSnapshot, TrustSourceError>.Success { value } => move value
  }
  let copied = run TrustSnapshot.copy(
    &original,
    SnapshotLimits { anchors: usize.ZERO, encodedBytes: usize.ZERO },
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  return match move copied {
    Result<TrustSnapshot, TrustSourceError>.Failure { error } => 2
    Result<TrustSnapshot, TrustSourceError>.Success { value } => {
      let anchors = TrustSnapshot.anchors(&value)
      if anchors.length == usize.ZERO { return 42 }
      return 3
    }
  }
}

effect fn allocationExit(error: OutOfMemoryError) -> i32 { return 4 }
pub fn main() -> i32 { return run Effect.catchAll(allocated(), allocationExit) }
`
