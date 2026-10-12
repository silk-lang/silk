import fixtures from '../fixtures/certificate-path-limbo.json' with { type: 'json' }

interface CertificateFixture {
  readonly der: string
  readonly sha256: string
}

interface PathFixture {
  readonly id: string
  readonly expectedSilk: {
    readonly result: 'Success' | 'Failure'
    readonly reason?: string
    readonly divergence?: string
    readonly anchorIndex?: number
    readonly intermediateIndices?: ReadonlyArray<number>
  }
  readonly validationTime: string
  readonly peer: CertificateFixture
  readonly intermediates: ReadonlyArray<CertificateFixture>
  readonly anchors: ReadonlyArray<CertificateFixture>
}

interface ProjectFixture extends CertificateFixture {
  readonly id: string
}

const literal = (base64: string): string => {
  const bytes = Buffer.from(base64, 'base64')
  return `b"${Array.from(bytes, (byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`
}

const instant = (value: string): { readonly seconds: number; readonly nanoseconds: number } => {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid fixture instant ${value}`)
  return {
    seconds: Math.floor(milliseconds / 1_000),
    nanoseconds: (milliseconds % 1_000) * 1_000_000,
  }
}

const decoded = (
  name: string,
  value: CertificateFixture,
  failure: number,
): string => `  let ${name}Result = run Certificate.decodeDer(${literal(value.der)}, DecodeLimits.defaults())
  let ${name} = match move ${name}Result {
    Result<Certificate, DecodeError>.Failure {error} => { return ${failure} }
    Result<Certificate, DecodeError>.Success {value} => move value
  }`

const fixtureCase = (fixture: PathFixture, ordinal: number): string => {
  const selectedPath = fixture.expectedSilk.intermediateIndices
  const selectedAnchor = fixture.expectedSilk.anchorIndex
  if (
    fixture.expectedSilk.result === 'Success' &&
    (selectedPath === undefined || selectedAnchor === undefined)
  ) {
    throw new Error(`Missing selected-path evidence for ${fixture.id}`)
  }
  const start = ordinal * 10 + 1
  const decodedValues = [
    decoded('leaf', fixture.peer, start),
    ...fixture.intermediates.map((value, index) =>
      decoded(`intermediate${index}`, value, start + 1),
    ),
    ...fixture.anchors.map((value, index) =>
      decoded(`anchorCertificate${index}`, value, start + 2),
    ),
  ].join('\n')
  const intermediateValues = fixture.intermediates
    .map((_, index) => `move intermediate${index}`)
    .join(', ')
  const anchorValues = fixture.anchors
    .map((_, index) => `TrustAnchor.fromCertificate(move anchorCertificate${index})`)
    .join(', ')
  const at = instant(fixture.validationTime)
  const expectation =
    fixture.expectedSilk.result === 'Failure'
      ? `  if failed(move outcome, ValidationReason.${fixture.expectedSilk.reason ?? 'NoValidPath'}) { return 0 }
  return ${start + 3}`
      : `  return successCode(move outcome, ${selectedAnchor ?? 0}, &expectedPath, &at)`
  const expectedPath = selectedPath ?? []
  return `effect fn case${ordinal}() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decodedValues}
  let intermediates: [Certificate; ${fixture.intermediates.length}] = [${intermediateValues}]
  let anchors: [TrustAnchor; ${fixture.anchors.length}] = [${anchorValues}]
  let at = SystemClock.make(${at.seconds}, ${at.nanoseconds})
  let expectedPath: [usize; ${expectedPath.length}] = [${expectedPath.join(', ')}]
  let outcome = run CertificatePath.validate(
    &leaf,
    &intermediates,
    &anchors,
    &at,
    ValidationLimits.defaults(),
  )
${expectation}
}`
}

const cases = (fixtures.cases as ReadonlyArray<PathFixture>).map(fixtureCase)
const fixture = (id: string): PathFixture => {
  const selected = (fixtures.cases as ReadonlyArray<PathFixture>).find((value) => value.id === id)
  if (selected === undefined) throw new Error(`Missing certificate-path fixture ${id}`)
  return selected
}
const projectFixture = (id: string): ProjectFixture => {
  const selected = (fixtures.projectFixtures as ReadonlyArray<ProjectFixture>).find(
    (value) => value.id === id,
  )
  if (selected === undefined) throw new Error(`Missing project certificate-path fixture ${id}`)
  return selected
}
const certificateAt = (
  values: ReadonlyArray<CertificateFixture>,
  index: number,
  context: string,
): CertificateFixture => {
  const selected = values.at(index)
  if (selected === undefined) throw new Error(`Missing ${context} certificate ${index}`)
  return selected
}

const pathLengthZero = fixture('pathlen::ee-with-intermediate-pathlen-0')
const wrongSignature = projectFixture('silk::wrong-signature-first/intermediates[0]')
const selfIssued = fixture('rfc5280::nc::permitted-self-issued')
const direct = fixture('rfc5280::eku::ee-without-eku')
const permittedDns = fixture('rfc5280::nc::permitted-dns-match')
const unknownCriticalLeaf = fixture('rfc5280::unknown-critical-extension-ee')
const noKeyUsageLeaf = projectFixture('source::rfc5280::no-keyusage/peer_certificate')
const emptySubjectMissingSan = projectFixture('silk::empty-subject-missing-san/peer_certificate')
const emptySubjectNoncriticalSan = projectFixture(
  'silk::empty-subject-noncritical-san/peer_certificate',
)
const emptySubjectEmptyCriticalSan = projectFixture(
  'silk::empty-subject-empty-critical-san/peer_certificate',
)
const ignoredAnchor = projectFixture(
  'silk::ignored-anchor-validity-self-signature/trusted_certs[0]',
)
const missingEcParametersAnchor = projectFixture('silk::missing-ec-parameters/trusted_certs[0]')
const unsupportedParameters = projectFixture(
  'silk::unsupported-signature-parameters/intermediates[0]',
)
const unsupportedAlgorithm = projectFixture(
  'silk::unsupported-signature-algorithm/intermediates[0]',
)
const mismatchingAlgorithms = projectFixture(
  'silk::mismatching-signature-algorithms/intermediates[0]',
)
const certificatePolicy = projectFixture('silk::certificate-policy/intermediates[0]')
const tlsFeature = projectFixture('silk::tls-feature/intermediates[0]')
const fixedInstant = instant(fixtures.defaultValidationTime)

const deterministicAndBoundCases = `effect fn wrongSignatureThenValid() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', pathLengthZero.peer, 221)}
${decoded('wrong', wrongSignature, 222)}
${decoded('valid', certificateAt(pathLengthZero.intermediates, 0, pathLengthZero.id), 223)}
${decoded('root', certificateAt(pathLengthZero.anchors, 0, pathLengthZero.id), 224)}
  let intermediates: [Certificate; 2] = [move wrong, move valid]
  let anchors: [TrustAnchor; 1] = [TrustAnchor.fromCertificate(move root)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let expected: [usize; 1] = [1]
  let outcome = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, ValidationLimits.defaults())
  if succeeded(move outcome, 0, &expected, &at) { return 0 }
  return 225
}

effect fn duplicateUsesLowestIndex() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', pathLengthZero.peer, 226)}
${decoded('first', certificateAt(pathLengthZero.intermediates, 0, pathLengthZero.id), 227)}
${decoded('duplicate', certificateAt(pathLengthZero.intermediates, 0, pathLengthZero.id), 228)}
${decoded('root', certificateAt(pathLengthZero.anchors, 0, pathLengthZero.id), 229)}
  let intermediates: [Certificate; 2] = [move first, move duplicate]
  let anchors: [TrustAnchor; 1] = [TrustAnchor.fromCertificate(move root)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let expected: [usize; 1] = [0]
  let outcome = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, ValidationLimits.defaults())
  if succeeded(move outcome, 0, &expected, &at) { return 0 }
  return 230
}

effect fn cycleIsRejected() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', selfIssued.peer, 231)}
${decoded('intermediate', certificateAt(selfIssued.intermediates, 0, selfIssued.id), 232)}
${decoded('unrelatedRoot', certificateAt(pathLengthZero.anchors, 0, pathLengthZero.id), 233)}
  let intermediates: [Certificate; 1] = [move intermediate]
  let anchors: [TrustAnchor; 1] = [TrustAnchor.fromCertificate(move unrelatedRoot)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let outcome = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, ValidationLimits.defaults())
  if failed(move outcome, ValidationReason.Cycle) { return 0 }
  return 234
}

effect fn exactAndExceededBounds() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', direct.peer, 235)}
${decoded('root', certificateAt(direct.anchors, 0, direct.id), 236)}
  let intermediates: [Certificate; 0] = []
  let anchors: [TrustAnchor; 1] = [TrustAnchor.fromCertificate(move root)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let expected: [usize; 0] = []
  let mut limits = ValidationLimits.defaults()
  limits.peerCertificates = 1
  limits.certificateBytes = ${Buffer.from(direct.peer.der, 'base64').length}
  limits.peerBytes = ${Buffer.from(direct.peer.der, 'base64').length}
  limits.anchors = 1
  limits.anchorBytes = ${Buffer.from(certificateAt(direct.anchors, 0, direct.id).der, 'base64').length}
  limits.pathCertificates = 1
  limits.issuerCandidates = 1
  limits.signatureVerifications = 1
  limits.completePaths = 1
  limits.nameComparisons = 0
  let exact = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !succeeded(move exact, 0, &expected, &at) { return 237 }

  limits = ValidationLimits.defaults()
  limits.peerCertificates = 0
  let peerCount = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move peerCount, ValidationLimit.PeerCertificates) { return 238 }
  limits = ValidationLimits.defaults()
  limits.certificateBytes = ${Buffer.from(direct.peer.der, 'base64').length - 1}
  let certificateBytes = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move certificateBytes, ValidationLimit.CertificateBytes) { return 239 }
  limits = ValidationLimits.defaults()
  limits.peerBytes = ${Buffer.from(direct.peer.der, 'base64').length - 1}
  let peerBytes = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move peerBytes, ValidationLimit.PeerBytes) { return 240 }
  limits = ValidationLimits.defaults()
  limits.anchors = 0
  let anchorCount = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move anchorCount, ValidationLimit.Anchors) { return 241 }
  limits = ValidationLimits.defaults()
  limits.anchorBytes = ${Buffer.from(certificateAt(direct.anchors, 0, direct.id).der, 'base64').length - 1}
  let anchorBytes = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move anchorBytes, ValidationLimit.AnchorBytes) { return 242 }
  limits = ValidationLimits.defaults()
  limits.pathCertificates = 0
  let path = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move path, ValidationLimit.PathCertificates) { return 243 }
  limits = ValidationLimits.defaults()
  limits.issuerCandidates = 0
  let issuers = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move issuers, ValidationLimit.IssuerCandidates) { return 244 }
  limits = ValidationLimits.defaults()
  limits.signatureVerifications = 0
  let signatures = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move signatures, ValidationLimit.SignatureVerifications) { return 245 }
  limits = ValidationLimits.defaults()
  limits.completePaths = 0
  let paths = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move paths, ValidationLimit.CompletePaths) { return 246 }
  return 0
}

effect fn comparisonBounds() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', permittedDns.peer, 247)}
${decoded('root', certificateAt(permittedDns.anchors, 0, permittedDns.id), 248)}
  let intermediates: [Certificate; 0] = []
  let anchors: [TrustAnchor; 1] = [TrustAnchor.fromCertificate(move root)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let mut limits = ValidationLimits.defaults()
  limits.nameComparisons = 0
  let exhausted = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move exhausted, ValidationLimit.NameComparisons) { return 249 }
  limits.nameComparisons = 1
  let expected: [usize; 0] = []
  let exact = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if succeeded(move exact, 0, &expected, &at) { return 0 }
  return 251
}`

const reviewRepairCases = `effect fn configuredRestrictionsAndGlobalBudgets() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', pathLengthZero.peer, 260)}
${decoded('wrong', wrongSignature, 261)}
${decoded('valid', certificateAt(pathLengthZero.intermediates, 0, pathLengthZero.id), 262)}
${decoded('restrictedRoot', certificateAt(pathLengthZero.anchors, 0, pathLengthZero.id), 263)}
${decoded('acceptedRoot', certificateAt(pathLengthZero.anchors, 0, pathLengthZero.id), 264)}
  let restrictedResult = run TrustAnchor.fromCertificateWithConstraints(
    move restrictedRoot,
    Option<usize>.some(usize.ZERO),
    Option<&[u8]>.none(),
    ProfileLimits.defaults(),
  )
  let restricted = match move restrictedResult {
    Result<TrustAnchor, ProfileError>.Failure {error} => { return 265 }
    Result<TrustAnchor, ProfileError>.Success {value} => move value
  }
  let intermediates: [Certificate; 2] = [move wrong, move valid]
  let anchors: [TrustAnchor; 2] = [move restricted, TrustAnchor.fromCertificate(move acceptedRoot)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let expected: [usize; 1] = [1]

  let mut limits = ValidationLimits.defaults()
  limits.completePaths = usize.ZERO
  let zeroPaths = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move zeroPaths, ValidationLimit.CompletePaths) { return 266 }
  limits.completePaths = 3
  let exhaustedPaths = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move exhaustedPaths, ValidationLimit.CompletePaths) { return 267 }
  limits.completePaths = 4
  let exactPaths = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !succeeded(move exactPaths, 1, &expected, &at) { return 268 }

  limits = ValidationLimits.defaults()
  limits.signatureVerifications = 5
  let exhaustedSignatures = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move exhaustedSignatures, ValidationLimit.SignatureVerifications) { return 269 }
  limits.signatureVerifications = 6
  let exactSignatures = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !succeeded(move exactSignatures, 1, &expected, &at) { return 270 }

  limits = ValidationLimits.defaults()
  limits.issuerCandidates = 9
  let exhaustedIssuers = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move exhaustedIssuers, ValidationLimit.IssuerCandidates) { return 271 }
  limits.issuerCandidates = 10
  let exactIssuers = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !succeeded(move exactIssuers, 1, &expected, &at) { return 272 }
  return 0
}

effect fn configuredConstraintIntersectionAndGlobalComparisons() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', permittedDns.peer, 273)}
${decoded('narrowRoot', certificateAt(permittedDns.anchors, 0, permittedDns.id), 274)}
${decoded('acceptedRoot', certificateAt(permittedDns.anchors, 0, permittedDns.id), 275)}
  let narrow: [u8; 23] = [
    48, 21, 160, 19, 48, 17, 130, 15,
    115, 117, 98, 46, 101, 120, 97, 109,
    112, 108, 101, 46, 99, 111, 109,
  ]
  let narrowDer = Slice.view<u8>(&narrow, usize.ZERO, 23)
  let narrowResult = run TrustAnchor.fromCertificateWithConstraints(
    move narrowRoot,
    Option<usize>.none(),
    Option<&[u8]>.some(narrowDer),
    ProfileLimits.defaults(),
  )
  let narrowAnchor = match move narrowResult {
    Result<TrustAnchor, ProfileError>.Failure {error} => { return 276 }
    Result<TrustAnchor, ProfileError>.Success {value} => move value
  }
  let intermediates: [Certificate; 0] = []
  let anchors: [TrustAnchor; 2] = [move narrowAnchor, TrustAnchor.fromCertificate(move acceptedRoot)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let expected: [usize; 0] = []
  let mut limits = ValidationLimits.defaults()
  limits.nameComparisons = 2
  let exhausted = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !limited(move exhausted, ValidationLimit.NameComparisons) { return 277 }
  limits.nameComparisons = 3
  let exact = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, limits)
  if !succeeded(move exact, 1, &expected, &at) { return 278 }
  return 0
}

effect fn profileRejectionsContinueInOrder() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', pathLengthZero.peer, 279)}
${decoded('wrong', wrongSignature, 280)}
${decoded('parameters', unsupportedParameters, 281)}
${decoded('algorithm', unsupportedAlgorithm, 282)}
${decoded('mismatch', mismatchingAlgorithms, 283)}
${decoded('policy', certificatePolicy, 284)}
${decoded('feature', tlsFeature, 285)}
${decoded('valid', certificateAt(pathLengthZero.intermediates, 0, pathLengthZero.id), 286)}
${decoded('root', certificateAt(pathLengthZero.anchors, 0, pathLengthZero.id), 287)}
  let parametersOffset = Certificate.offsets(&parameters).tbsSignatureAlgorithm
  let candidates: [Certificate; 7] = [
    move wrong, move parameters, move algorithm, move mismatch, move policy, move feature, move valid,
  ]
  let anchors: [TrustAnchor; 1] = [TrustAnchor.fromCertificate(move root)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let parametersOnly = Slice.view<Certificate>(&candidates, 1, 1)
  let parametersOutcome = run CertificatePath.validate(&leaf, parametersOnly, &anchors, &at, ValidationLimits.defaults())
  if !exactIntermediateRejectionAt(
    move parametersOutcome, ValidationReason.UnsupportedParameters, usize.ZERO, parametersOffset,
  ) { return 288 }
  let algorithmOnly = Slice.view<Certificate>(&candidates, 2, 1)
  let algorithmOutcome = run CertificatePath.validate(&leaf, algorithmOnly, &anchors, &at, ValidationLimits.defaults())
  if !exactIntermediateRejection(
    move algorithmOutcome, ValidationReason.UnsupportedAlgorithm, usize.ZERO, Option<usize>.none(),
  ) { return 289 }
  let mismatchOnly = Slice.view<Certificate>(&candidates, 3, 1)
  let mismatchOutcome = run CertificatePath.validate(&leaf, mismatchOnly, &anchors, &at, ValidationLimits.defaults())
  if !exactIntermediateRejection(
    move mismatchOutcome, ValidationReason.UnsupportedParameters, usize.ZERO, Option<usize>.none(),
  ) { return 290 }
  let policyOnly = Slice.view<Certificate>(&candidates, 4, 1)
  let policyOutcome = run CertificatePath.validate(&leaf, policyOnly, &anchors, &at, ValidationLimits.defaults())
  if !exactIntermediateRejection(
    move policyOutcome, ValidationReason.UnsupportedPolicy, usize.ZERO, Option<usize>.some(usize.ZERO),
  ) { return 291 }
  let featureOnly = Slice.view<Certificate>(&candidates, 5, 1)
  let featureOutcome = run CertificatePath.validate(&leaf, featureOnly, &anchors, &at, ValidationLimits.defaults())
  if !exactIntermediateRejection(
    move featureOutcome, ValidationReason.UnsupportedExtension, usize.ZERO, Option<usize>.some(usize.ZERO),
  ) { return 292 }
  let rejected = Slice.view<Certificate>(&candidates, usize.ZERO, 6)
  let rejectedOutcome = run CertificatePath.validate(&leaf, rejected, &anchors, &at, ValidationLimits.defaults())
  if !exactAnchorRejection(
    move rejectedOutcome, ValidationReason.InvalidSignature, usize.ZERO, Option<usize>.none(),
  ) { return 293 }
  let expected: [usize; 1] = [6]
  let accepted = run CertificatePath.validate(&leaf, &candidates, &anchors, &at, ValidationLimits.defaults())
  if !succeeded(move accepted, usize.ZERO, &expected, &at) { return 294 }
  return 0
}

effect fn anchorExceptionsAndErrors() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', noKeyUsageLeaf, 293)}
${decoded('missing', missingEcParametersAnchor, 294)}
${decoded('ignored', ignoredAnchor, 295)}
  let intermediates: [Certificate; 0] = []
  let anchors: [TrustAnchor; 2] = [
    TrustAnchor.fromCertificate(move missing),
    TrustAnchor.fromCertificate(move ignored),
  ]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let missingOnly = Slice.view<TrustAnchor>(&anchors, usize.ZERO, usize.ONE)
  let rejected = run CertificatePath.validate(&leaf, &intermediates, missingOnly, &at, ValidationLimits.defaults())
  if !exactAnchorRejection(
    move rejected, ValidationReason.InvalidKey, usize.ZERO, Option<usize>.none(),
  ) { return 296 }
  let expected: [usize; 0] = []
  let accepted = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, ValidationLimits.defaults())
  if !succeeded(move accepted, usize.ONE, &expected, &at) { return 297 }
  let ignoredOnly = Slice.view<TrustAnchor>(&anchors, usize.ONE, usize.ONE)
  let ignoredAccepted = run CertificatePath.validate(
    &leaf, &intermediates, ignoredOnly, &at, ValidationLimits.defaults(),
  )
  if !succeeded(move ignoredAccepted, usize.ZERO, &expected, &at) { return 298 }
  return 0
}

effect fn leafErrorContract() -> i32 ! OutOfMemoryError ? &mut Allocator {
${decoded('leaf', unknownCriticalLeaf.peer, 299)}
${decoded('root', certificateAt(unknownCriticalLeaf.anchors, 0, unknownCriticalLeaf.id), 300)}
${decoded('emptyMissing', emptySubjectMissingSan, 302)}
${decoded('emptyNoncritical', emptySubjectNoncriticalSan, 303)}
${decoded('emptyCritical', emptySubjectEmptyCriticalSan, 304)}
  let intermediates: [Certificate; 0] = []
  let anchors: [TrustAnchor; 1] = [TrustAnchor.fromCertificate(move root)]
  let at = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let criticalOffset = match move extensionOffset(&leaf, 5, false) {
    Option<usize>.None => { return 305 }
    Option<usize>.Some {value} => value
  }
  let outcome = run CertificatePath.validate(&leaf, &intermediates, &anchors, &at, ValidationLimits.defaults())
  if !exactLeafFailure(
    move outcome,
    ValidationReason.UnsupportedExtension,
    Option<usize>.some(5),
    criticalOffset,
  ) { return 301 }
  let missingOutcome = run CertificatePath.validate(
    &emptyMissing, &intermediates, &anchors, &at, ValidationLimits.defaults(),
  )
  if !exactLeafFailure(
    move missingOutcome,
    ValidationReason.InvalidName,
    Option<usize>.none(),
    Certificate.offsets(&emptyMissing).subject,
  ) { return 306 }
  let noncriticalOffset = match move extensionOffset(&emptyNoncritical, 3, false) {
    Option<usize>.None => { return 307 }
    Option<usize>.Some {value} => value
  }
  let noncriticalOutcome = run CertificatePath.validate(
    &emptyNoncritical, &intermediates, &anchors, &at, ValidationLimits.defaults(),
  )
  if !exactLeafFailure(
    move noncriticalOutcome,
    ValidationReason.InvalidName,
    Option<usize>.some(3),
    noncriticalOffset,
  ) { return 308 }
  let emptySanOffset = match move extensionOffset(&emptyCritical, 3, true) {
    Option<usize>.None => { return 309 }
    Option<usize>.Some {value} => value
  }
  let emptyCriticalOutcome = run CertificatePath.validate(
    &emptyCritical, &intermediates, &anchors, &at, ValidationLimits.defaults(),
  )
  if !exactLeafFailure(
    move emptyCriticalOutcome,
    ValidationReason.InvalidName,
    Option<usize>.some(3),
    emptySanOffset,
  ) { return 310 }
  return 0
}`

/**
 * One native corpus program checks the pinned path, constraint, date, alternate-path and error
 * matrix without compiling one binary per vector.
 */
const sourcePrelude = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.certificate { Certificate, DecodeError, DecodeLimits, ExtensionView }
import silk.certificate_path { CertificatePath, RevocationStatus, ValidatedPath, ValidationClass, ValidationError, ValidationLimit, ValidationLimits, ValidationLocation, ValidationReason }
import silk.certificate_profile { ProfileError, ProfileLimits }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.option { Option }
import silk.result { Result }
import silk.slice { Slice }
import silk.system_clock { Instant, SystemClock }
import silk.trust_anchor { TrustAnchor }
import silk.usize

fn detailIs(detail: Option<ValidationReason>, expected: ValidationReason) -> bool {
  return match move detail {
    Option<ValidationReason>.None => false
    Option<ValidationReason>.Some {value} => value == expected
  }
}

fn noDetail(detail: Option<ValidationReason>) -> bool {
  return match move detail {
    Option<ValidationReason>.None => true
    Option<ValidationReason>.Some {value} => false
  }
}

fn extensionIs(extension: Option<usize>, expected: usize) -> bool {
  return match move extension {
    Option<usize>.None => false
    Option<usize>.Some {value} => value == expected
  }
}

fn noExtension(extension: Option<usize>) -> bool {
  return match move extension {
    Option<usize>.None => true
    Option<usize>.Some {value} => false
  }
}

fn noLimit(limit: Option<ValidationLimit>) -> bool {
  return match move limit {
    Option<ValidationLimit>.None => true
    Option<ValidationLimit>.Some {value} => false
  }
}

fn extensionOffset<'a>(certificate: &'a Certificate, index: usize, value: bool) -> Option<usize> {
  return match move Certificate.extension(certificate, index) {
    Option<ExtensionView<'a>>.None => Option<usize>.none()
    Option<ExtensionView<'a>>.Some {value: extension} => {
      if value { return Option<usize>.some(extension.valueOffset) }
      return Option<usize>.some(extension.offset)
    }
  }
}

fn exactLeafFailure<'a>(
  outcome: Result<ValidatedPath<'a>, ValidationError>,
  reason: ValidationReason,
  extension: Option<usize>,
  offset: usize,
) -> bool {
  return match move outcome {
    Result<ValidatedPath<'a>, ValidationError>.Success {value} => false
    Result<ValidatedPath<'a>, ValidationError>.Failure {error} => {
      return error.kind == ValidationClass.Rejected
        && error.reason == reason
        && noDetail(move error.detailReason)
        && match move error.location {
          ValidationLocation.Leaf => true
          _ => false
        }
        && match move extension {
          Option<usize>.None => noExtension(move error.extensionIndex)
          Option<usize>.Some {value} => extensionIs(move error.extensionIndex, value)
        }
        && noLimit(move error.limit)
        && error.offset == offset
    }
  }
}

fn exactIntermediateRejectionAt<'a>(
  outcome: Result<ValidatedPath<'a>, ValidationError>,
  detail: ValidationReason,
  index: usize,
  offset: usize,
) -> bool {
  return match move outcome {
    Result<ValidatedPath<'a>, ValidationError>.Success {value} => false
    Result<ValidatedPath<'a>, ValidationError>.Failure {error} => {
      return error.kind == ValidationClass.Rejected
        && error.reason == ValidationReason.NoValidPath
        && detailIs(move error.detailReason, detail)
        && match move error.location {
          ValidationLocation.Intermediate {index: found} => found == index
          _ => false
        }
        && noExtension(move error.extensionIndex)
        && noLimit(move error.limit)
        && error.offset == offset
    }
  }
}

fn exactIntermediateRejection<'a>(
  outcome: Result<ValidatedPath<'a>, ValidationError>,
  detail: ValidationReason,
  index: usize,
  extension: Option<usize>,
) -> bool {
  return match move outcome {
    Result<ValidatedPath<'a>, ValidationError>.Success {value} => false
    Result<ValidatedPath<'a>, ValidationError>.Failure {error} => {
      if error.kind != ValidationClass.Rejected
        || error.reason != ValidationReason.NoValidPath
        || !detailIs(move error.detailReason, detail)
        || !noLimit(move error.limit) { return false }
      let located = match move error.location {
        ValidationLocation.Intermediate {index: found} => found == index
        _ => false
      }
      if !located { return false }
      return match move extension {
        Option<usize>.None => noExtension(move error.extensionIndex)
        Option<usize>.Some {value} => extensionIs(move error.extensionIndex, value)
      }
    }
  }
}

fn exactAnchorRejection<'a>(
  outcome: Result<ValidatedPath<'a>, ValidationError>,
  detail: ValidationReason,
  index: usize,
  extension: Option<usize>,
) -> bool {
  return match move outcome {
    Result<ValidatedPath<'a>, ValidationError>.Success {value} => false
    Result<ValidatedPath<'a>, ValidationError>.Failure {error} => {
      if error.kind != ValidationClass.Rejected
        || error.reason != ValidationReason.NoValidPath
        || !detailIs(move error.detailReason, detail)
        || !noLimit(move error.limit) { return false }
      let located = match move error.location {
        ValidationLocation.Anchor {index: found} => found == index
        _ => false
      }
      if !located { return false }
      return match move extension {
        Option<usize>.None => noExtension(move error.extensionIndex)
        Option<usize>.Some {value} => extensionIs(move error.extensionIndex, value)
      }
    }
  }
}

fn failed<'a>(outcome: Result<ValidatedPath<'a>, ValidationError>, expected: ValidationReason) -> bool {
  return match move outcome {
    Result<ValidatedPath<'a>, ValidationError>.Success {value} => false
    Result<ValidatedPath<'a>, ValidationError>.Failure {error} => {
      return error.reason == expected
        || (error.reason == ValidationReason.NoValidPath && detailIs(move error.detailReason, expected))
    }
  }
}

fn limited<'a>(outcome: Result<ValidatedPath<'a>, ValidationError>, expected: ValidationLimit) -> bool {
  return match move outcome {
    Result<ValidatedPath<'a>, ValidationError>.Success {value} => false
    Result<ValidatedPath<'a>, ValidationError>.Failure {error} => {
      if error.kind != ValidationClass.ResourceLimit
        || error.reason != ValidationReason.SizeOverflow
        || !noDetail(move error.detailReason)
        || !noExtension(move error.extensionIndex)
        || error.offset != 0 { return false }
      let callScoped = match move error.location {
        ValidationLocation.Call => true
        _ => false
      }
      if !callScoped { return false }
      return match move error.limit {
        Option<ValidationLimit>.None => false
        Option<ValidationLimit>.Some {value} => value == expected
      }
    }
  }
}

fn succeeded<'a>(
  outcome: Result<ValidatedPath<'a>, ValidationError>,
  anchor: usize,
  intermediates: &[usize],
  at: &Instant,
) -> bool {
  return match move outcome {
    Result<ValidatedPath<'a>, ValidationError>.Failure {error} => false
    Result<ValidatedPath<'a>, ValidationError>.Success {value} => {
      if value.anchorIndex() != anchor || value.intermediateCount() != intermediates.length {
        return false
      }
      let mut index = usize.ZERO
      while index < intermediates.length {
        let selected = value.intermediateIndex(index)
        match move selected {
          Option<usize>.None => { return false }
          Option<usize>.Some {value: found} => {
            if found != intermediates[index] { return false }
          }
        }
        index = index + usize.ONE
      }
      let checkedAt = value.validationTime()
      return value.revocationStatus() == RevocationStatus.NotChecked
        && SystemClock.seconds(&checkedAt) == SystemClock.seconds(at)
        && SystemClock.nanoseconds(&checkedAt) == SystemClock.nanoseconds(at)
    }
  }
}

fn successCode<'a>(
  outcome: Result<ValidatedPath<'a>, ValidationError>,
  anchor: usize,
  intermediates: &[usize],
  at: &Instant,
) -> i32 {
  return match move outcome {
    Result<ValidatedPath<'a>, ValidationError>.Failure {error} => {
      if error.reason == ValidationReason.NoIssuer { return 50 }
      if error.reason == ValidationReason.NoValidPath {
        return match move error.detailReason {
          Option<ValidationReason>.None => 51
          Option<ValidationReason>.Some {value} => {
            if value == ValidationReason.InvalidSignature { return 60 }
            if value == ValidationReason.InvalidTime { return 61 }
            if value == ValidationReason.InvalidBasicConstraints { return 62 }
            if value == ValidationReason.InvalidUsage { return 63 }
            if value == ValidationReason.PathLengthExceeded { return 64 }
            if value == ValidationReason.NameConstraintViolation { return 65 }
            if value == ValidationReason.UnsupportedConstraint { return 66 }
            if value == ValidationReason.UnsupportedVersion { return 68 }
            if value == ValidationReason.UnsupportedAlgorithm { return 69 }
            if value == ValidationReason.UnsupportedParameters { return 70 }
            if value == ValidationReason.UnsupportedExtension {
              return match move error.location {
                ValidationLocation.Leaf => 83
                ValidationLocation.Intermediate {index} => {
                  return match move error.extensionIndex {
                    Option<usize>.None => 84
                    Option<usize>.Some {value: extension} => 90 + usize.toI32(extension)
                  }
                }
                ValidationLocation.Anchor {index} => {
                  return match move error.extensionIndex {
                    Option<usize>.None => 85
                    Option<usize>.Some {value: extension} => 100 + usize.toI32(extension)
                  }
                }
                ValidationLocation.Call => 86
              }
            }
            if value == ValidationReason.UnsupportedPolicy { return 72 }
            if value == ValidationReason.InvalidKey { return 73 }
            if value == ValidationReason.InvalidSerial { return 74 }
            if value == ValidationReason.InvalidName { return 75 }
            if value == ValidationReason.DuplicateExtension { return 76 }
            if value == ValidationReason.IssuerMismatch { return 77 }
            if value == ValidationReason.Cycle { return 78 }
            if value == ValidationReason.NoIssuer { return 79 }
            if value == ValidationReason.NoValidPath { return 80 }
            if value == ValidationReason.SizeOverflow { return 81 }
            return 82
          }
        }
      }
      if error.reason == ValidationReason.InvalidTime { return 52 }
      return 53
    }
    Result<ValidatedPath<'a>, ValidationError>.Success {value} => {
      if value.anchorIndex() != anchor { return 1 }
      if value.intermediateCount() != intermediates.length {
        return 10
          + usize.toI32(value.intermediateCount()) * 10
          + usize.toI32(intermediates.length)
      }
      let mut index = usize.ZERO
      while index < intermediates.length {
        let selected = value.intermediateIndex(index)
        match move selected {
          Option<usize>.None => { return 3 }
          Option<usize>.Some {value: found} => {
            if found != intermediates[index] { return 4 }
          }
        }
        index = index + usize.ONE
      }
      let checkedAt = value.validationTime()
      if value.revocationStatus() != RevocationStatus.NotChecked { return 5 }
      if SystemClock.seconds(&checkedAt) != SystemClock.seconds(at) { return 6 }
      if SystemClock.nanoseconds(&checkedAt) != SystemClock.nanoseconds(at) { return 7 }
      return 0
    }
  }
}
`

const allocationRefusalCase = `struct RefusingAllocator { calls: usize failAt: usize }

effect fn allocate(self: &mut RefusingAllocator, layout: Layout) -> Intrinsic.Allocation ! OutOfMemoryError {
  self.calls = self.calls + usize.ONE
  if self.calls == self.failAt { return run Allocator.outOfMemory() }
  let mut system = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut<Allocator>(&mut system)
}

impl Allocator for RefusingAllocator { allocate: RefusingAllocator.allocate }

effect fn validationSucceeded(
  leaf: &Certificate,
  anchors: &[TrustAnchor],
  at: &Instant,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let intermediates: [Certificate; 0] = []
  let expected: [usize; 0] = []
  let outcome = run CertificatePath.validate(
    leaf,
    &intermediates,
    anchors,
    at,
    ValidationLimits.defaults(),
  )
  return succeeded(move outcome, 0, &expected, at)
}

effect fn validationAllocationFailed(error: OutOfMemoryError) -> bool { return false }

effect fn allocationBoundaries() -> bool ! OutOfMemoryError ? &mut Allocator {
  let allocationLeafResult = run Certificate.decodeDer(${literal(direct.peer.der)}, DecodeLimits.defaults())
  let allocationLeaf = match move allocationLeafResult {
    Result<Certificate, DecodeError>.Failure {error} => { return false }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let allocationRootResult = run Certificate.decodeDer(${literal(certificateAt(direct.anchors, 0, direct.id).der)}, DecodeLimits.defaults())
  let allocationRoot = match move allocationRootResult {
    Result<Certificate, DecodeError>.Failure {error} => { return false }
    Result<Certificate, DecodeError>.Success {value} => move value
  }
  let allocationAnchors: [TrustAnchor; 1] = [TrustAnchor.fromCertificate(move allocationRoot)]
  let allocationAt = SystemClock.make(${fixedInstant.seconds}, ${fixedInstant.nanoseconds})
  let mut audit = RefusingAllocator { calls: usize.ZERO, failAt: usize.ZERO }
  let complete = run Effect.catchAll(
    validationSucceeded(&allocationLeaf, &allocationAnchors, &allocationAt)
      |> Effect.provideMut<Allocator>(&mut audit),
    validationAllocationFailed,
  )
  if !complete { return false }
  let total = audit.calls
  let ordinals: [usize; 2] = [usize.ONE, total]
  let mut index = usize.ZERO
  while index < 2 {
    audit.calls = usize.ZERO
    audit.failAt = ordinals[index]
    let refused = run Effect.catchAll(
      validationSucceeded(&allocationLeaf, &allocationAnchors, &allocationAt)
        |> Effect.provideMut<Allocator>(&mut audit),
      validationAllocationFailed,
    )
    if refused || audit.calls != ordinals[index] { return false }
    audit.calls = usize.ZERO
    audit.failAt = usize.ZERO
    let retried = run Effect.catchAll(
      validationSucceeded(&allocationLeaf, &allocationAnchors, &allocationAt)
        |> Effect.provideMut<Allocator>(&mut audit),
      validationAllocationFailed,
    )
    if !retried { return false }
    index = index + usize.ONE
  }
  return true
}`

export const certificatePathAcceptanceSource = `${sourcePrelude}
${cases.join('\n\n')}

${deterministicAndBoundCases}

${reviewRepairCases}

${allocationRefusalCase}

effect fn suite() -> i32 ! OutOfMemoryError ? &mut Allocator {
${fixtures.cases.map((_, index) => `  let result${index} = run case${index}()\n  if result${index} != 0 { return result${index} }`).join('\n')}
  let wrongSignature = run wrongSignatureThenValid()
  if wrongSignature != 0 { return wrongSignature }
  let duplicate = run duplicateUsesLowestIndex()
  if duplicate != 0 { return duplicate }
  let cycle = run cycleIsRejected()
  if cycle != 0 { return cycle }
  let bounds = run exactAndExceededBounds()
  if bounds != 0 { return bounds }
  let comparisons = run comparisonBounds()
  if comparisons != 0 { return comparisons }
  let configured = run configuredRestrictionsAndGlobalBudgets()
  if configured != 0 { return configured }
  let intersection = run configuredConstraintIntersectionAndGlobalComparisons()
  if intersection != 0 { return intersection }
  let profiles = run profileRejectionsContinueInOrder()
  if profiles != 0 { return profiles }
  let anchors = run anchorExceptionsAndErrors()
  if anchors != 0 { return anchors }
  let leafError = run leafErrorContract()
  if leafError != 0 { return leafError }
  let allocations = run allocationBoundaries()
  if !allocations { return 254 }
  return 42
}

effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run suite() |> Effect.provideMut<Allocator>(&mut allocator)
}

effect fn allocationFailure(error: OutOfMemoryError) -> i32 { return 250 }
pub fn main() -> i32 { return run Effect.catchAll(allocated(), allocationFailure) }
`

const wasmFixture = (fixtures.cases as ReadonlyArray<PathFixture>).find(
  (fixture) => fixture.id === 'rfc5280::eku::ee-without-eku',
)
if (wasmFixture === undefined) throw new Error('Missing direct-path Wasm fixture')

/** One direct-path success is the compact wasm32 portability witness. */
export const certificatePathWasmSource = `${sourcePrelude}
${fixtureCase(wasmFixture, 12)}

effect fn suite() -> i32 ! OutOfMemoryError ? &mut Allocator {
  return run case12()
}

effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run suite() |> Effect.provideMut<Allocator>(&mut allocator)
}

effect fn allocationFailure(error: OutOfMemoryError) -> i32 { return 250 }
pub fn main() -> i32 { return run Effect.catchAll(allocated(), allocationFailure) }
`
