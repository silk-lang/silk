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
