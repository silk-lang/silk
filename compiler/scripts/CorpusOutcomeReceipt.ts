import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Manifest } from './CorpusVerification.js'

export interface Expected {
  readonly manifest: unknown
  readonly selection: 'full' | 'pins'
}

export interface Previous {
  readonly expected: Expected
  readonly output: string
}

export interface Outcome {
  readonly name: string
  readonly status: 'PASS' | 'FAIL' | 'UNSUPPORTED'
  readonly detail: string
}

export interface CorpusOutcomeReceipt {
  readonly schemaVersion: 1
  readonly selection: Expected['selection']
  readonly manifest: Schema.Schema.Type<typeof Manifest>
  readonly outcomes: ReadonlyArray<Outcome>
  readonly timings: ReadonlyArray<{ readonly name: string; readonly elapsedMs: number }>
  readonly summary: {
    readonly pass: number
    readonly fail: number
    readonly unsupported: number
    readonly track: number
  }
}

export class ValidationError extends Data.TaggedError('CorpusOutcomeReceiptError')<{
  readonly kind: 'Malformed' | 'Policy'
  readonly phase:
    | 'Expected'
    | 'Manifest'
    | 'Timing'
    | 'Outcome'
    | 'Summary'
    | 'Aggregate'
    | 'Previous'
    | 'Policy'
  readonly message: string
  readonly line?: number
  /** Present only when the entire current transcript passed structural validation. */
  readonly receipt?: CorpusOutcomeReceipt
  readonly failures?: ReadonlyArray<string>
  readonly pinGaps?: ReadonlyArray<string>
  readonly lostPasses?: ReadonlyArray<string>
  readonly cause?: unknown
}> {}

const malformed = (phase: ValidationError['phase'], message: string, line?: number) =>
  new ValidationError({
    kind: 'Malformed',
    phase,
    message,
    ...(line === undefined ? {} : { line }),
  })

const freeze = <A>(value: A): A => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const Status = Schema.Literals(['PASS', 'FAIL', 'UNSUPPORTED'])
const Timing = Schema.Struct({ name: Schema.NonEmptyString, elapsedMs: Schema.Finite })
const manifestPrefix = 'SELFHOST_CORPUS_MANIFEST='
const timingPrefix = 'SELFHOST_CASE_TIMING='
const recordPrefix = /^(?:PASS|FAIL|UNSUPPORTED)(?:\s|$)|^SELFHOST_|^Selfhost /u
const summaryPattern =
  /^Selfhost corpus: pass=(0|[1-9]\d*) fail=(0|[1-9]\d*) unsupported=(0|[1-9]\d*) track=(0|[1-9]\d*)$/u
const aggregatePattern = /^Selfhost (failure|gap) (.+): ([1-9]\d*)$/u

const validate = Effect.fn('CorpusOutcomeReceipt.validate')(function* (
  expected: Expected,
  output: string,
): Effect.fn.Return<CorpusOutcomeReceipt, ValidationError> {
  if (expected.selection !== 'full' && expected.selection !== 'pins')
    return yield* malformed('Expected', 'Unknown corpus selection')
  const decoded = yield* Schema.decodeUnknownEffect(Manifest)(expected.manifest, {
    onExcessProperty: 'error',
  }).pipe(Effect.mapError((cause) => malformed('Expected', cause.message)))
  // Own the decoded JSON before freezing: reading a receipt never mutates caller inputs.
  const manifest = yield* Effect.try({
    try: () => freeze(structuredClone(decoded)),
    catch: () => malformed('Expected', 'Could not copy the expected manifest'),
  })
  const names = manifest.programs.map((program) => program.name)
  const required = new Set(manifest.required)
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    required.size !== manifest.required.length ||
    manifest.required.some((name) => !names.includes(name)) ||
    names.some((name) => /[\r\n]/u.test(name)) ||
    manifest.programs.some((program) => program.profiles.length === 0 || program.runs.length === 0)
  )
    return yield* malformed('Expected', 'Incomplete or duplicate corpus authority')
  const selected =
    expected.selection === 'full' ? names : names.filter((name) => required.has(name))
  if (typeof output !== 'string' || !output.endsWith('\n'))
    return yield* malformed('Summary', 'Truncated corpus transcript')
  const lines = output
    .slice(0, -1)
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  let at = 0
  const header = lines[at]
  if (header !== undefined && header.startsWith(manifestPrefix)) {
    const observed = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
      header.slice(manifestPrefix.length),
      { onExcessProperty: 'error' },
    ).pipe(Effect.mapError((cause) => malformed('Manifest', cause.message, at + 1)))
    const codec = Schema.fromJsonString(Manifest)
    const expectedText = yield* Schema.encodeEffect(codec)(manifest).pipe(
      Effect.mapError((cause) => malformed('Expected', cause.message)),
    )
    const observedText = yield* Schema.encodeEffect(codec)(observed).pipe(
      Effect.mapError((cause) => malformed('Manifest', cause.message, at + 1)),
    )
    if (expectedText !== observedText)
      return yield* malformed(
        'Manifest',
        'Manifest differs from the current corpus authority',
        at + 1,
      )
    at++
  } else if (expected.selection === 'full') {
    return yield* malformed(
      'Manifest',
      'Full corpus receipt requires its complete manifest',
      at + 1,
    )
  }
  const timings: Array<{ name: string; elapsedMs: number }> = []
  for (const name of selected) {
    const line = lines[at]
    if (line === undefined || !line.startsWith(timingPrefix))
      return yield* malformed('Timing', `Missing ordered timing for ${name}`, at + 1)
    const timing = yield* Schema.decodeEffect(Schema.fromJsonString(Timing))(
      line.slice(timingPrefix.length),
      { onExcessProperty: 'error' },
    ).pipe(Effect.mapError((cause) => malformed('Timing', cause.message, at + 1)))
    if (timing.name !== name || !Number.isSafeInteger(timing.elapsedMs) || timing.elapsedMs < 0)
      return yield* malformed('Timing', `Invalid ordered timing for ${name}`, at + 1)
    timings.push(timing)
    at++
  }
  const outcomes: Array<Outcome> = []
  for (const name of selected) {
    const line = lines[at]
    const rawLabel = line?.match(/^(PASS|FAIL|UNSUPPORTED) /u)?.[1]
    if (line === undefined || rawLabel === undefined)
      return yield* malformed('Outcome', `Missing ordered outcome for ${name}`, at + 1)
    const label = yield* Schema.decodeUnknownEffect(Status)(rawLabel).pipe(
      Effect.mapError(() => malformed('Outcome', 'Unknown outcome status', at + 1)),
    )
    const prefix = `${label} ${name}`
    if (!line.startsWith(prefix))
      return yield* malformed('Outcome', `Unknown or reordered outcome for ${name}`, at + 1)
    let detail = line.slice(prefix.length)
    if (label === 'PASS' ? detail !== '' : !detail.startsWith(': ') || detail.length <= 2)
      return yield* malformed('Outcome', `Malformed ${label} outcome for ${name}`, at + 1)
    detail = detail.slice(label === 'PASS' ? 0 : 2)
    at++
    // Reasons are unescaped prose. Exact protocol prefixes remain records; ambiguous
    // prefix-bearing diagnostics therefore fail closed instead of hiding duplicates.
    while (at < lines.length) {
      const continuation = lines[at]
      if (continuation === undefined || recordPrefix.test(continuation)) break
      if (label === 'PASS') return yield* malformed('Outcome', 'Unexpected text after PASS', at + 1)
      detail += `\n${continuation}`
      at++
    }
    outcomes.push({ name, status: label, detail })
  }
  const summary = lines[at]?.match(summaryPattern)
  if (summary === undefined || summary === null)
    return yield* malformed('Summary', 'Missing or malformed corpus footer', at + 1)
  const counts = {
    pass: Number(summary[1]),
    fail: Number(summary[2]),
    unsupported: Number(summary[3]),
    track: Number(summary[4]),
  }
  if (
    Object.values(counts).some((count) => !Number.isSafeInteger(count)) ||
    counts.pass !== outcomes.filter((outcome) => outcome.status === 'PASS').length ||
    counts.fail !== outcomes.filter((outcome) => outcome.status === 'FAIL').length ||
    counts.unsupported !== outcomes.filter((outcome) => outcome.status === 'UNSUPPORTED').length ||
    counts.track !== required.size
  )
    return yield* malformed(
      'Summary',
      'Footer does not match complete outcomes and live pins',
      at + 1,
    )
  at++
  let lastFailure: string | undefined
  let lastGap: string | undefined
  let failureCount = 0
  let gapCount = 0
  for (; at < lines.length; at++) {
    const aggregate = lines[at]?.match(aggregatePattern)
    if (aggregate === undefined || aggregate === null)
      return yield* malformed('Aggregate', 'Unknown or duplicate record after footer', at + 1)
    const [, kind, code, text] = aggregate
    if (code === undefined || text === undefined || (kind !== 'failure' && kind !== 'gap'))
      return yield* malformed('Aggregate', 'Malformed aggregate record', at + 1)
    const count = Number(text)
    if (!Number.isSafeInteger(count))
      return yield* malformed('Aggregate', 'Invalid aggregate count', at + 1)
    if (kind === 'failure') {
      if (
        lastGap !== undefined ||
        (lastFailure !== undefined && lastFailure.localeCompare(code) >= 0)
      )
        return yield* malformed('Aggregate', 'Reordered or duplicate failure aggregate', at + 1)
      lastFailure = code
      failureCount += count
    } else {
      if (lastGap !== undefined && lastGap.localeCompare(code) >= 0)
        return yield* malformed('Aggregate', 'Reordered or duplicate gap aggregate', at + 1)
      lastGap = code
      gapCount += count
    }
  }
  if (
    failureCount !== counts.fail ||
    (counts.unsupported === 0 ? gapCount !== 0 : gapCount < counts.unsupported) ||
    !Number.isSafeInteger(failureCount) ||
    !Number.isSafeInteger(gapCount)
  )
    return yield* malformed('Aggregate', 'Incomplete or inconsistent aggregate footer')
  return freeze({
    schemaVersion: 1,
    selection: expected.selection,
    manifest,
    outcomes,
    timings,
    summary: counts,
  })
})

const violations = (receipt: CorpusOutcomeReceipt) =>
  freeze({
    failures: receipt.outcomes
      .filter((outcome) => outcome.status === 'FAIL')
      .map((outcome) => outcome.name),
    pinGaps: receipt.outcomes
      .filter(
        (outcome) => receipt.manifest.required.includes(outcome.name) && outcome.status !== 'PASS',
      )
      .map((outcome) => outcome.name),
  })

/** Read complete observations independently of child exit, then enforce strict corpus policy. */
export const read = Effect.fn('CorpusOutcomeReceipt.read')(function* (
  expected: Expected,
  output: string,
  previous?: Previous,
): Effect.fn.Return<CorpusOutcomeReceipt, ValidationError> {
  const receipt = yield* validate(expected, output)
  const current = violations(receipt)
  let lostPasses: ReadonlyArray<string> = []
  if (previous !== undefined) {
    const baseline = yield* validate(previous.expected, previous.output).pipe(
      Effect.mapError(
        (cause) =>
          new ValidationError({
            kind: 'Malformed',
            phase: 'Previous',
            message: 'Previous receipt is structurally invalid',
            receipt,
            ...current,
            cause,
          }),
      ),
    )
    const prior = violations(baseline)
    if (prior.failures.length > 0 || prior.pinGaps.length > 0)
      return yield* new ValidationError({
        kind: 'Policy',
        phase: 'Previous',
        message: 'Previous receipt did not satisfy strict policy',
        receipt,
        ...current,
        cause: freeze(prior),
      })
    const passes = new Set(
      receipt.outcomes
        .filter((outcome) => outcome.status === 'PASS')
        .map((outcome) => outcome.name),
    )
    lostPasses = baseline.outcomes
      .filter((outcome) => outcome.status === 'PASS' && !passes.has(outcome.name))
      .map((outcome) => outcome.name)
  }
  if (current.failures.length > 0 || current.pinGaps.length > 0 || lostPasses.length > 0)
    return yield* new ValidationError({
      kind: 'Policy',
      phase: 'Policy',
      message: 'Complete corpus receipt violates strict acceptance',
      receipt,
      ...freeze(current),
      lostPasses: freeze(lostPasses),
    })
  return receipt
})
