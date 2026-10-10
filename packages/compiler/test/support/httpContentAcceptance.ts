/** Consolidated portable acceptance program for scoped HTTP response content decoding. */
const httpContentRuntimeSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.buffered_duplex {BufferedContext, BufferedDuplex, withBufferedCapacity, withBufferedCapacityContext}
import silk.buffered_input {BufferError}
import silk.byte_duplex {ByteDuplex, ByteIoError, ByteIoOperation}
import silk.bytes {Bytes}
import silk.effect {Effect}
import silk.execution { Execution, Wake }
import silk.http {Header, LimitKind, Method, ValueComponent, ValueError, ValueReason}
import silk.http_body {
  Anomaly,
  BodyComponent,
  BodyError,
  BodyReason,
  CompletionKind as BodyCompletionKind,
  Decoder as BodyDecoder,
  Framing,
  Limits as BodyLimits,
  Selection,
  TrailerPolicy,
}
import silk.http_content {
  AcceptEncoding,
  CodingPosition,
  CodingPlan,
  ContentError,
  ContentCompletion,
  ContentLimitKind,
  ContentProgress,
  ContentReason,
  ContentProgressState,
  ContentReader,
  Decoder as ContentDecoder,
  EmptyEncodingPolicy,
  EnabledCodings,
  Limits,
  Mode,
  ResponseContext,
  ReuseDisposition,
  acceptEncoding,
  withReader,
}
import silk.http_head {Limits as HeadLimits, ResponseHead, ResponseParser, parseResponse}
import silk.http_headers {Limits as ValueLimits}
import silk.inflate {Decoder as InflateDecoder, Limits as InflateLimits}
import silk.inflate {ErrorKind as InflateErrorKind}
import silk.layout {Layout}
import silk.memory_byte_duplex {MemoryByteDuplex, MemoryReadEvent, MemoryWriteEvent}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.result {Result}
import silk.shared {Shared}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.usize
import silk.vector {Vector}
import silk.zstd {Zstd, ZstdLimits, ZstdReason}

struct FixedClock {}

struct FailingAllocator { calls: usize failAt: usize }

struct CancellationState { ownerDrops: usize auditEntries: usize closeAttempts: usize }

struct CancellationOwner { source: MemoryByteDuplex state: Shared<CancellationState> }

struct CancellationParkGuard { wake: Wake }

struct CallbackFailure { code: i32 }

impl MonotonicClock for FixedClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { drop howLong return () }
}

effect fn allocateUntilFailure(
  self: &mut FailingAllocator,
  layout: Layout,
) -> Allocation ! OutOfMemoryError {
  self.calls = self.calls + usize.ONE
  if self.failAt > usize.ZERO && self.calls == self.failAt {
    fail OutOfMemoryError {}
  }
  let mut system = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut<Allocator>(&mut system)
}

impl Allocator for FailingAllocator { allocate: FailingAllocator.allocateUntilFailure }

fn recordCancellationDrop(
  state: &mut CancellationState,
  auditEntries: usize,
  closeAttempts: usize,
) -> () {
  state.ownerDrops = state.ownerDrops + usize.ONE
  state.auditEntries = auditEntries
  state.closeAttempts = closeAttempts
  return ()
}

fn cancellationCode(state: &CancellationState) -> i32 {
  if state.ownerDrops != usize.ONE { return 321 }
  if state.auditEntries != usize.ONE { return 322 }
  if state.closeAttempts != usize.ONE { return 323 }
  return 0
}

fn retainCancellationWake(wake: Wake) -> CancellationParkGuard {
  return CancellationParkGuard {wake: move wake}
}

impl Drop for CancellationOwner {
  fn drop(self: &mut CancellationOwner) -> () {
    let auditEntries = MemoryByteDuplex.audit(&self.source).length
    let closeAttempts = MemoryByteDuplex.closeAttempts(&self.source)
    let update = fn(state: &mut CancellationState) -> () {
      return recordCancellationDrop(move state, auditEntries, closeAttempts)
    }
    Shared.withMut(&self.state, move update)
    return ()
  }
}

fn valueLimits() -> ValueLimits {
  return ValueLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 128,
    maxNameBytes: 64,
    maxValueBytes: 256,
    maxFields: 16,
    maxFieldBytes: 512,
    maxOwnedBytes: 2048,
  }
}

fn headLimits() -> HeadLimits {
  return HeadLimits {
    maxHeadBytes: 1024,
    maxStartLineBytes: 256,
    maxFieldLineBytes: 512,
    maxOwnedBytes: 4096,
    values: valueLimits(),
  }
}

fn bodyLimits() -> BodyLimits {
  return BodyLimits {
    maxWireBytes: 4096,
    maxPayloadBytes: 2048,
    maxChunkBytes: 512,
    maxChunks: 16,
    maxChunkLineBytes: 128,
    maxExtensionBytes: 256,
    maxTrailerBytes: 512,
    maxTrailerFields: 8,
    maxOwnedBytes: 8192,
    trailerValues: valueLimits(),
  }
}

fn contentLimits() -> Limits {
  return Limits {
    maxEncoded: 2048,
    maxIntermediate: 4096,
    maxDecoded: 4096,
    maxOwned: 2097152,
    maxDepth: 4,
    intermediateCapacity: 8,
    inflate: InflateLimits {
      maxInputBytes: 2048,
      maxOutputBytes: 4096,
      maxMembers: 8,
      maxHeaderBytes: 512,
      maxMemoryBytes: 65536,
    },
    zstd: ZstdLimits {
      inputBytes: 2048,
      outputBytes: 4096,
      frames: 8,
      skippableBytes: 512,
      windowBytes: 1024,
      workspaceBytes: 1048576,
    },
  }
}

effect fn provider(values: &[u8]) -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let bytes = run Bytes.copy(values)
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 0),
    bytes: move bytes,
  })
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.End {
    readyAt: SystemClock.make(0, 0),
  })
  return run MemoryByteDuplex.make(
    move reads,
    Vector.make<MemoryWriteEvent>(),
    1,
    // One-byte buffered reads may consume one audit entry per input byte.
    // Reserve the EOF read and scoped flush/close operations as well.
    values.length + 8,
    Option.none<i32>(),
  )
}

effect fn failingProvider() -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Failure {
    readyAt: SystemClock.make(0, 0),
    code: 17,
  })
  return run MemoryByteDuplex.make(
    move reads,
    Vector.make<MemoryWriteEvent>(),
    1,
    8,
    Option.none<i32>(),
  )
}

effect fn deadlineProvider() -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 10),
    bytes: run Bytes.copy(&b"x"),
  })
  return run MemoryByteDuplex.make(
    move reads,
    Vector.make<MemoryWriteEvent>(),
    1,
    8,
    Option.none<i32>(),
  )
}

effect<'call> fn rawReader<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let initial = match move ContentReader.representation(&reader.*) {
    Result.Failure {error} => { drop error return 39 }
    Result.Success {value} => move value
  }
  let applied = initial.appliedPlan()
  if initial.decodingApplied()
    || applied.mode != Mode.Raw
    || applied.codingCount != usize.ZERO
    || applied.decoderCount != usize.ZERO
    || applied.reuse != ReuseDisposition.EligibleAfterCompletion
    || !headerValueEquals(initial.originalHead(), "Content-Encoding", b"weird;bad")
    || !headerValueEquals(initial.originalHead(), "Content-Length", b"4") {
    drop initial
    return 40
  }
  match move initial.decodedLength() {
    Option.Some {value} => { drop initial return 54 }
    Option.None => {}
  }
  drop initial
  let expected = b"raw!"
  let mut index = usize.ZERO
  let mut clock = FixedClock {}
  while true {
    let mut output: [u8; 4] = [0, 0, 0, 0]
    let progress = run Effect.catchAll(
      ContentReader.readSome(&mut reader.*, &mut output, Option.none<Instant>())
        |> Effect.provideMut<MonotonicClock>(&mut clock),
      classifyFailure,
    )
    if progress.written > 4 { return 38 }
    let mut written = usize.ZERO
    while written < progress.written {
      if index >= expected.length || output[written] != expected[index] { return 31 }
      index = index + usize.ONE
      written = written + usize.ONE
    }
    if progress.state == ContentProgressState.End { break }
  }
  if index != expected.length { return 32 }
  let metadata = match move ContentReader.representation(&reader.*) {
    Result.Failure {error} => { drop error return 55 }
    Result.Success {value} => move value
  }
  match move metadata.decodedLength() {
    Option.None => { drop metadata return 56 }
    Option.Some {value} => {
      if value != 4 { drop metadata return 57 }
    }
  }
  drop metadata
  let completion = match move ContentReader.completion(&reader.*) {
    Result.Failure {error} => { return 33 }
    Result.Success {value} => move value
  }
  return match move completion {
    Option.None => 34
    Option.Some {value} => {
      if value.reuse() != ReuseDisposition.Reusable { return 35 }
      if value.decodedBytes() != 4 { return 36 }
      return 0
    }
  }
}

effect fn readExpected<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
  expected: &[u8],
  expectedReuse: ReuseDisposition,
  base: i32,
) -> i32 {
  let metadata = match move ContentReader.representation(&reader.*) {
    Result.Failure {error} => { return base + 1 }
    Result.Success {value} => move value
  }
  if !metadata.decodingApplied() { drop metadata return base + 2 }
  let plannedReuse = metadata.appliedPlan().reuse
  if (expectedReuse == ReuseDisposition.Reusable
      && plannedReuse != ReuseDisposition.EligibleAfterCompletion)
    || (expectedReuse == ReuseDisposition.NonReusable
      && plannedReuse != ReuseDisposition.NonReusable) {
    drop metadata
    return base + 15
  }
  let initial = metadata.decodedLength()
  match move initial {
    Option.Some {value} => { drop metadata return base + 10 }
    Option.None => {}
  }
  if base == 80
    && (!headerValueEquals(metadata.originalHead(), "Content-Encoding", b"deflate")
      || !headerValueEquals(metadata.originalHead(), "Content-Length", b"20")) {
    drop metadata
    return base + 11
  }
  drop metadata
  let mut index = usize.ZERO
  let mut clock = FixedClock {}
  while true {
    let mut output: [u8; 4] = [0, 0, 0, 0]
    let progress = run Effect.catchAll(
      ContentReader.readSome(&mut reader.*, &mut output, Option.none<Instant>())
        |> Effect.provideMut<MonotonicClock>(&mut clock),
      classifyFailure,
    )
    if progress.written > 4 { return base + 3 }
    let mut written = usize.ZERO
    while written < progress.written {
      if index >= expected.length || output[written] != expected[index] { return base + 4 }
      index = index + usize.ONE
      written = written + usize.ONE
    }
    if progress.state == ContentProgressState.End { break }
  }
  if index != expected.length { return base + 5 }
  let finalMetadata = match move ContentReader.representation(&reader.*) {
    Result.Failure {error} => { drop error return base + 12 }
    Result.Success {value} => move value
  }
  match move finalMetadata.decodedLength() {
    Option.None => { drop finalMetadata return base + 13 }
    Option.Some {value} => {
      if value != usize.toU64(expected.length) {
        drop finalMetadata
        return base + 14
      }
    }
  }
  drop finalMetadata
  let completion = match move ContentReader.completion(&reader.*) {
    Result.Failure {error} => { return base + 6 }
    Result.Success {value} => move value
  }
  return match move completion {
    Option.None => base + 7
    Option.Some {value} => {
      let reuse = value.reuse()
      let decoded = value.decodedBytes()
      drop value
      if reuse != expectedReuse { return base + 8 }
      if decoded != usize.toU64(expected.length) { return base + 9 }
      if base == 290 {
        let trailers = match move ContentReader.trailers(&reader.*) {
          Result.Failure {error} => { drop error return base + 16 }
          Result.Success {value: available} => match move available {
            Option.None => { return base + 17 }
            Option.Some {value: section} => move section
          }
        }
        if trailers.count() != usize.ONE { drop trailers return base + 18 }
        let mut fields = trailers.fields()
        let mut result = base + 19
        match move fields.next() {
          Option.None => {}
          Option.Some {value: trailer} => {
            if Header.name(&trailer) == "X-End"
              && bytesEqual(Header.value(&trailer), b"yes") { result = 0 }
            else { result = base + 20 }
          }
        }
        drop fields
        drop trailers
        return result
      }
      return 0
    }
  }
}

fn headerValueEquals<'head>(head: ResponseHead<'head>, name: string, expected: &[u8]) -> bool {
  let mut fields = head.fields()
  while true {
    match move fields.next() {
      Option.None => { return false }
      Option.Some {value: header} => {
        if Header.name(&header) == name {
          return bytesEqual(Header.value(&header), expected)
        }
      }
    }
  }
  return false
}

enum ExpectedFailure {
  RawDeflate,
  FixedZero,
  Buffer,
  BodyUnderrun,
  ChunkSyntax,
  Trailing,
  EncodedLimit,
  IntermediateLimit,
  DecodedLimit,
  ZeroEncoded,
  ZeroIntermediate,
  ZeroDecoded,
  StackedCorrupt,
}

effect<'call> fn scenarioReader<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let case = readerCase(&reader.*)
  if case == 1 { return run readExpected(move reader, b"abc", ReuseDisposition.Reusable, 50) }
  if case == 2 {
    return run readExpected(move reader, b"firstsecond", ReuseDisposition.Reusable, 70)
  }
  if case == 3 {
    return run readExpected(move reader, b"Hello, zlib!", ReuseDisposition.Reusable, 80)
  }
  if case == 4 { return run readFailure(move reader, ExpectedFailure.RawDeflate, 90) }
  if case == 5 { return run readFailure(move reader, ExpectedFailure.Trailing, 100) }
  if case == 6 { return run readFailure(move reader, ExpectedFailure.EncodedLimit, 110) }
  if case == 7 { return run readFailure(move reader, ExpectedFailure.IntermediateLimit, 120) }
  if case == 8 { return run readFailure(move reader, ExpectedFailure.DecodedLimit, 130) }
  if case == 9 {
    return run readExpected(move reader, b"close", ReuseDisposition.NonReusable, 280)
  }
  if case == 10 {
    return run readExpected(move reader, b"close", ReuseDisposition.Reusable, 290)
  }
  if case == 11 { return run emptyRead(move reader) }
  if case == 12 {
    return match move ContentReader.completion(&reader.*) {
      Result.Failure {error} => 302
      Result.Success {value} => match move value {
        Option.None => 0
        Option.Some {value: evidence} => 303
      }
    }
  }
  if case == 13 {
    return run readExpected(move reader, b"close", ReuseDisposition.Reusable, 385)
  }
  if case == 14 || case == 15 {
    return run readFailure(move reader, ExpectedFailure.ChunkSyntax, 405)
  }
  if case == 16 { return run identityRead(move reader) }
  if case == 17 { return run partialChecksumRead(move reader) }
  if case == 18 { return run deadlineRead(move reader) }
  if case == 19 { return run readFailure(move reader, ExpectedFailure.ZeroEncoded, 425) }
  if case == 20 {
    return run readFailure(move reader, ExpectedFailure.ZeroIntermediate, 435)
  }
  if case == 21 { return run readFailure(move reader, ExpectedFailure.ZeroDecoded, 445) }
  if case == 22 { return run emptyBudgetRead(move reader) }
  if case == 23 { return run readFailure(move reader, ExpectedFailure.StackedCorrupt, 455) }
  if case == 24 { return run readFailure(move reader, ExpectedFailure.FixedZero, 330) }
  return 39
}

effect fn emptyRead<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let mut clock = FixedClock {}
  let mut output: [u8; 0] = []
  let progress = run Effect.catchAll(
    ContentReader.readSome(&mut reader.*, &mut output, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock),
    classifyFailure,
  )
  if progress.written != usize.ZERO
    || progress.totalEncoded != u64.MIN
    || progress.totalIntermediate != u64.MIN
    || progress.totalDecoded != u64.MIN
    || progress.state != ContentProgressState.Data {
    return 301
  }
  return 0
}

effect fn identityRead<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let before = match move ContentReader.representation(&reader.*) {
    Result.Failure {error} => { drop error return 360 }
    Result.Success {value} => move value
  }
  if before.decodingApplied()
    || before.appliedPlan().mode != Mode.Decode
    || before.appliedPlan().codingCount != 2
    || before.appliedPlan().decoderCount != usize.ZERO
    || !headerValueEquals(before.originalHead(), "Content-Encoding", b"identity, Identity")
    || !headerValueEquals(before.originalHead(), "Content-Length", b"2") {
    drop before
    return 361
  }
  match move before.decodedLength() {
    Option.Some {value} => { drop before return 362 }
    Option.None => {}
  }
  drop before
  let mut clock = FixedClock {}
  let mut index = usize.ZERO
  while true {
    let mut output: [u8; 1] = [0]
    let progress = run Effect.catchAll(
      ContentReader.readSome(&mut reader.*, &mut output, Option.none<Instant>())
        |> Effect.provideMut<MonotonicClock>(&mut clock),
      classifyFailure,
    )
    if progress.written > usize.ONE { return 363 }
    if progress.written == usize.ONE {
      if index >= 2 || output[0] != b"id"[index] { return 364 }
      index = index + usize.ONE
    }
    if progress.state == ContentProgressState.End { break }
  }
  if index != 2 { return 365 }
  let after = match move ContentReader.representation(&reader.*) {
    Result.Failure {error} => { drop error return 366 }
    Result.Success {value} => move value
  }
  return match move after.decodedLength() {
    Option.None => { drop after return 367 }
    Option.Some {value} => {
      drop after
      if value == 2 { return 0 }
      return 368
    }
  }
}

effect fn emptyBudgetRead<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let mut clock = FixedClock {}
  let mut output: [u8; 1] = [0]
  let progress = run Effect.catchAll(
    ContentReader.readSome(&mut reader.*, &mut output, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock),
    classifyFailure,
  )
  if progress.written == usize.ZERO
    && progress.totalEncoded == u64.MIN
    && progress.totalIntermediate == u64.MIN
    && progress.totalDecoded == u64.MIN
    && progress.state == ContentProgressState.End { return 0 }
  return 369
}

effect fn deadlineRead<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let mut clock = FixedClock {}
  let mut output: [u8; 1] = [0]
  let attempted = run Effect.result(
    ContentReader.readSome(
      &mut reader.*,
      &mut output,
      Option.some<Instant>(SystemClock.make(0, 10)),
    ) |> Effect.provideMut<MonotonicClock>(&mut clock),
  )
  match move attempted {
    Result.Success {value} => { return 370 }
    Result.Failure {error} => match move error.reason {
      ContentReason.Buffer {error: cause} => match move cause {
        BufferError.ReadFailed {progress, error: nested} => match move nested {
          ByteIoError.Timeout {operation} => {
            if progress != usize.ZERO || operation != ByteIoOperation.Read { return 371 }
          }
          _ => { return 372 }
        }
        _ => { return 373 }
      }
      _ => { return 374 }
    }
  }
  return match move ContentReader.completion(&reader.*) {
    Result.Success {value} => 375
    Result.Failure {error} => match move error.reason {
      ContentReason.InvalidState => 0
      _ => 376
    }
  }
}

union ChecksumStep {
  Progress { state: ContentProgressState },
  Failure {
    totalEncoded: u64,
    totalIntermediate: u64,
    totalDecoded: u64,
    checksum: bool,
  },
}

fn checksumCompletionPending<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let completion = ContentReader.completion(reader)
  let mut result = 0
  match move completion {
    Result.Failure {error} => { drop error result = 380 }
    Result.Success {value} => match move value {
      Option.Some {value: evidence} => { drop evidence result = 381 }
      Option.None => {}
    }
  }
  return result
}

fn checksumPoisoned<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
  totalEncoded: u64,
  totalIntermediate: u64,
  totalDecoded: u64,
) -> i32 {
  let completion = ContentReader.completion(reader)
  let mut result = 386
  match move completion {
    Result.Success {value} => { drop value }
    Result.Failure {error: poisoned} => {
      if poisoned.written != usize.ZERO
        || poisoned.totalEncoded != totalEncoded
        || poisoned.totalIntermediate != totalIntermediate
        || poisoned.totalDecoded != totalDecoded {
        drop poisoned
        result = 387
      } else {
        result = match move poisoned.reason {
          ContentReason.InvalidState => 0
          _ => 388
        }
      }
    }
  }
  return result
}

effect fn partialChecksumRead<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let expected = b"first"
  let mut index = usize.ZERO
  let mut clock = FixedClock {}
  while true {
    let mut output: [u8; 1] = [0]
    let attempted = run Effect.result(
      ContentReader.readSome(&mut reader.*, &mut output, Option.none<Instant>())
        |> Effect.provideMut<MonotonicClock>(&mut clock),
    )
    let mut step = ChecksumStep.Progress {state: ContentProgressState.Data}
    match move attempted {
      Result.Success {value: progress} => {
        if progress.written > usize.ONE { return 377 }
        if progress.written == usize.ONE {
          if index >= expected.length || output[0] != expected[index] { return 378 }
          index = index + usize.ONE
        }
        let state = progress.state
        drop progress
        step = ChecksumStep.Progress {state: state}
      }
      Result.Failure {error} => {
        if error.written > usize.ONE { return 382 }
        if error.written == usize.ONE {
          if index >= expected.length || output[0] != expected[index] { return 383 }
          index = index + usize.ONE
        }
        if index != expected.length || error.totalDecoded != 5 { return 384 }
        let totalEncoded = error.totalEncoded
        let totalIntermediate = error.totalIntermediate
        let totalDecoded = error.totalDecoded
        let checksum = match move error.reason {
          ContentReason.Inflate {stage, wireIndex, error: cause} => stage == usize.ZERO
            && wireIndex == usize.ZERO
            && cause.kind == InflateErrorKind.ChecksumMismatch
          _ => false
        }
        step = ChecksumStep.Failure {
          totalEncoded: totalEncoded,
          totalIntermediate: totalIntermediate,
          totalDecoded: totalDecoded,
          checksum: checksum,
        }
      }
    }
    match move step {
      ChecksumStep.Progress {state} => {
        if state == ContentProgressState.End { return 379 }
        let pending = checksumCompletionPending(&reader.*)
        if pending != 0 { return pending }
      }
      ChecksumStep.Failure {totalEncoded, totalIntermediate, totalDecoded, checksum} => {
        if !checksum { return 385 }
        return checksumPoisoned(&reader.*, totalEncoded, totalIntermediate, totalDecoded)
      }
    }
  }
  return 389
}

fn readerCase<'reader, 'transport, 'head>(
  reader: &ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> u8 {
  let metadata = match move ContentReader.representation(reader) {
    Result.Failure {error} => { return 0 }
    Result.Success {value} => move value
  }
  let head = metadata.originalHead()
  drop metadata
  let mut fields = head.fields()
  while true {
    match move fields.next() {
      Option.None => { return 0 }
      Option.Some {value: header} => {
        if Header.name(&header) == "X-Case" {
          let value = Header.value(&header)
          if value.length == usize.ONE { return value[0] - 48 }
          if value.length == 2 { return (value[0] - 48) * 10 + value[1] - 48 }
          return 0
        }
      }
    }
  }
  return 0
}

effect fn readFailure<'call, 'reader: 'call, 'transport: 'reader, 'head: 'reader>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
  expected: ExpectedFailure,
  base: i32,
) -> i32 {
  let mut clock = FixedClock {}
  let mut output: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 0]
  while true {
    let attempted = run Effect.result(
      ContentReader.readSome(&mut reader.*, &mut output, Option.none<Instant>())
        |> Effect.provideMut<MonotonicClock>(&mut clock),
    )
    let progress = match move attempted {
      Result.Success {value} => move value
      Result.Failure {error} => run classifyFailure(move error)
    }
    if progress.written >= 100 {
      if !failureMatches(expected, &progress) { return base + 2 }
      let poisoned = ContentReader.completion(&reader.*)
      return match move poisoned {
        Result.Success {value} => base + 3
        Result.Failure {error: later} => match move later.reason {
          ContentReason.InvalidState => 0
          _ => base + 4
        }
      }
    }
    if progress.state == ContentProgressState.End { return base + 1 }
  }
  return base + 5
}

effect fn classifyFailure<'head>(error: ContentError<'head>) -> ContentProgress {
  let encoded = error.totalEncoded
  let intermediate = error.totalIntermediate
  let decoded = error.totalDecoded
  let code = match move error.reason {
    ContentReason.Inflate {stage, wireIndex, error: cause} => classifyInflate(
      stage,
      wireIndex,
      cause.kind,
    )
    ContentReason.Zstandard {stage, wireIndex, error: cause} => classifyZstd(
      stage,
      wireIndex,
      cause.reason,
    )
    ContentReason.TrailingEncodedData {stage, wireIndex} => classifyTrailing(stage, wireIndex)
    ContentReason.Buffer {error: cause} => classifyBuffer(move cause)
    ContentReason.Body {error: cause} => classifyBody(move cause)
    ContentReason.InvalidLimit {limit, allowed, attempted} => classifyLimit(
      limit,
      allowed,
      attempted,
    )
    _ => usize.MAX
  }
  return ContentProgress {
    written: code,
    totalEncoded: encoded,
    totalIntermediate: intermediate,
    totalDecoded: decoded,
    state: ContentProgressState.End,
  }
}

fn classifyBuffer(error: BufferError) -> usize {
  return match move error {
    BufferError.ReadFailed {progress, error: cause} => match move cause {
      ByteIoError.Provider {operation, code} => {
        if progress == usize.ZERO && operation == ByteIoOperation.Read && code == 17 { return 106 }
        return 199
      }
      _ => 199
    }
    _ => 199
  }
}

fn classifyBody(error: BodyError) -> usize {
  return match move error.reason {
    BodyReason.Truncated => 107
    BodyReason.ChunkSyntax => {
      if error.component == BodyComponent.ChunkLine
        && error.consumed == 3
        && error.written == usize.ZERO
        && error.totalWire == 3
        && error.totalPayload == u64.MIN { return 108 }
      return 199
    }
    _ => 199
  }
}

fn classifyInflate(stage: usize, wireIndex: usize, kind: InflateErrorKind) -> usize {
  if stage == usize.ZERO && wireIndex == usize.ZERO {
    if kind == InflateErrorKind.UnsupportedMethod { return 100 }
    if kind == InflateErrorKind.TruncatedInput { return 105 }
  }
  return 199
}

fn classifyZstd(stage: usize, wireIndex: usize, reason: ZstdReason) -> usize {
  if stage == usize.ONE && wireIndex == usize.ONE
    && reason == ZstdReason.InvalidMagic { return 111 }
  return 199
}

fn classifyTrailing(stage: usize, wireIndex: usize) -> usize {
  if stage == usize.ZERO && wireIndex == usize.ZERO { return 101 }
  return 199
}

fn classifyLimit(limit: ContentLimitKind, allowed: u64, attempted: u64) -> usize {
  if allowed == 2 && attempted == 3 {
    if limit == ContentLimitKind.EncodedBytes { return 102 }
    if limit == ContentLimitKind.IntermediateBytes { return 103 }
    if limit == ContentLimitKind.DecodedBytes { return 104 }
  }
  if allowed == u64.MIN && attempted == 1 {
    if limit == ContentLimitKind.EncodedBytes { return 112 }
    if limit == ContentLimitKind.IntermediateBytes { return 113 }
    if limit == ContentLimitKind.DecodedBytes { return 114 }
  }
  return 199
}

fn failureMatches(
  expected: ExpectedFailure,
  progress: &ContentProgress,
) -> bool {
  if expected == ExpectedFailure.RawDeflate { return progress.written == 100 }
  if expected == ExpectedFailure.FixedZero {
    return progress.written == 105
      && progress.totalEncoded == u64.MIN
      && progress.totalIntermediate == u64.MIN
      && progress.totalDecoded == u64.MIN
  }
  if expected == ExpectedFailure.Buffer {
    return progress.written == 106
      && progress.totalEncoded == u64.MIN
      && progress.totalIntermediate == u64.MIN
      && progress.totalDecoded == u64.MIN
  }
  if expected == ExpectedFailure.BodyUnderrun {
    return progress.written == 107
      && progress.totalEncoded == 2
      && progress.totalIntermediate == u64.MIN
      && progress.totalDecoded == 2
  }
  if expected == ExpectedFailure.ChunkSyntax {
    return progress.written == 108
      && progress.totalEncoded == u64.MIN
      && progress.totalIntermediate == u64.MIN
      && progress.totalDecoded == u64.MIN
  }
  if expected == ExpectedFailure.Trailing { return progress.written == 101 }
  if expected == ExpectedFailure.EncodedLimit {
    return progress.written == 102
      && progress.totalEncoded == 2
      && progress.totalDecoded == 2
  }
  if expected == ExpectedFailure.IntermediateLimit {
    return progress.written == 103 && progress.totalIntermediate == 2
  }
  if expected == ExpectedFailure.DecodedLimit {
    return progress.written == 104 && progress.totalDecoded == 2
  }
  if expected == ExpectedFailure.ZeroEncoded {
    return progress.written == 112
      && progress.totalEncoded == u64.MIN
      && progress.totalDecoded == u64.MIN
  }
  if expected == ExpectedFailure.ZeroIntermediate {
    return progress.written == 113
      && progress.totalEncoded > u64.MIN
      && progress.totalIntermediate == u64.MIN
      && progress.totalDecoded == u64.MIN
  }
  if expected == ExpectedFailure.ZeroDecoded {
    return progress.written == 114 && progress.totalDecoded == u64.MIN
  }
  return expected == ExpectedFailure.StackedCorrupt && progress.written == 111
}

effect<'borrow> fn decodeSession<
  'borrow,
  'transport: 'borrow,
  'head: 'borrow,
  'callback,
>(
  body: &'borrow mut BufferedDuplex<'transport, MemoryByteDuplex>,
  response: &'head [u8],
  limits: Limits,
  expectedCodings: usize,
  expectedDecoders: usize,
  callback: for<
    'call,
    'reader: 'call,
    'transport: 'reader,
    'viewHead: 'reader,
  > once fn<'callback>(
    &'call mut ContentReader<'reader, 'transport, 'viewHead, MemoryByteDuplex>,
  ) -> once Effect<'call; i32 ! never>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let parsed = match move (run parseResponse(response, headLimits())) {
    Result.Failure {error} => { return 60 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { return 61 }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { return 62 }
    Result.Success {value} => value
  }
  // The chunked scenario deliberately exercises an application-selected trailer name.
  let trailerNames: [string<'static>; 1] = ["X-End"]
  let trailerPolicy = match move TrailerPolicy.fromNames(&trailerNames) {
    Result.Failure {error} => { drop error return 66 }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(head, method, trailerPolicy) {
    Result.Failure {error} => { return 63 }
    Result.Success {value} => move value
  }
  let plan = match move CodingPlan.make(move context, Mode.Decode, bodyLimits(), move limits) {
    Result.Failure {error} => { return 64 }
    Result.Success {value} => move value
  }
  if plan.applied().codingCount != expectedCodings
    || plan.applied().decoderCount != expectedDecoders {
    return 65
  }
  let opened = withReader<i32, never>(move plan, &mut body.*, move callback)
  return run Effect.catchAll(move opened, failed)
}

effect<'borrow> fn scenarioSession<'borrow, 'transport: 'borrow>(
  body: &'borrow mut BufferedDuplex<'transport, MemoryByteDuplex>,
  case: u8,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let mut limits = contentLimits()
  let mut expectedCodings = usize.ZERO
  let mut expectedDecoders = usize.ZERO
  let mut header: &[u8] =
    b"HTTP/1.1 200 OK\\r\\nX-Case: 24\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzip\\r\\n\\r\\n"
  if case == 1 {
    expectedCodings = 3
    expectedDecoders = 2
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 1\\r\\nContent-Length: 32\\r\\nContent-Encoding: zstd, identity\\r\\nContent-Encoding: GZIP\\r\\n\\r\\n"
  }
  if case == 2 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 2\\r\\nContent-Length: 51\\r\\nContent-Encoding: X-GZIP\\r\\n\\r\\n"
  }
  if case == 3 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 3\\r\\nContent-Length: 20\\r\\nContent-Encoding: deflate\\r\\n\\r\\n"
  }
  if case == 4 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 4\\r\\nContent-Length: 5\\r\\nContent-Encoding: deflate\\r\\n\\r\\n"
  }
  if case == 5 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 5\\r\\nContent-Length: 22\\r\\nContent-Encoding: deflate\\r\\n\\r\\n"
  }
  if case == 6 {
    limits.maxEncoded = 2
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 6\\r\\nContent-Length: 4\\r\\n\\r\\n"
  }
  if case == 7 {
    expectedCodings = 2
    expectedDecoders = 2
    limits.maxIntermediate = 2
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 7\\r\\nContent-Length: 32\\r\\nContent-Encoding: zstd, gzip\\r\\n\\r\\n"
  }
  if case == 8 {
    expectedCodings = 1
    expectedDecoders = 1
    limits.maxDecoded = 2
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 8\\r\\nContent-Length: 20\\r\\nContent-Encoding: deflate\\r\\n\\r\\n"
  }
  if case == 9 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 9\\r\\nContent-Encoding: gzip\\r\\n\\r\\n"
  }
  if case == 10 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 10\\r\\nTransfer-Encoding: chunked\\r\\nTrailer: X-End\\r\\nContent-Encoding: gzip\\r\\n\\r\\n"
  }
  if case == 11 {
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 11\\r\\nContent-Length: 4\\r\\n\\r\\n"
  }
  if case == 12 {
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 12\\r\\nContent-Length: 4\\r\\n\\r\\n"
  }
  if case == 13 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 13\\r\\nContent-Length: 25\\r\\nContent-Encoding: gzip\\r\\n\\r\\n"
  }
  if case == 14 {
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 14\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n"
  }
  if case == 15 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 15\\r\\nTransfer-Encoding: chunked\\r\\nContent-Encoding: gzip\\r\\n\\r\\n"
  }
  if case == 16 {
    expectedCodings = 2
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 16\\r\\nContent-Length: 2\\r\\nContent-Encoding: identity, Identity\\r\\n\\r\\n"
  }
  if case == 17 {
    expectedCodings = 1
    expectedDecoders = 1
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 17\\r\\nContent-Length: 25\\r\\nContent-Encoding: gzip\\r\\n\\r\\n"
  }
  if case == 18 {
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 18\\r\\nContent-Length: 1\\r\\n\\r\\n"
  }
  if case == 19 {
    limits.maxEncoded = u64.MIN
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 19\\r\\nContent-Length: 1\\r\\n\\r\\n"
  }
  if case == 20 {
    expectedCodings = 2
    expectedDecoders = 2
    limits.maxIntermediate = u64.MIN
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 20\\r\\nContent-Length: 32\\r\\nContent-Encoding: zstd, gzip\\r\\n\\r\\n"
  }
  if case == 21 {
    limits.maxDecoded = u64.MIN
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 21\\r\\nContent-Length: 1\\r\\n\\r\\n"
  }
  if case == 22 {
    limits.maxEncoded = u64.MIN
    limits.maxIntermediate = u64.MIN
    limits.maxDecoded = u64.MIN
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 22\\r\\nContent-Length: 0\\r\\n\\r\\n"
  }
  if case == 23 {
    expectedCodings = 3
    expectedDecoders = 2
    header = b"HTTP/1.1 200 OK\\r\\nX-Case: 23\\r\\nContent-Length: 32\\r\\nContent-Encoding: identity, zstd, gzip\\r\\n\\r\\n"
  }
  if case == 24 {
    expectedCodings = 1
    expectedDecoders = 1
  }
  return run decodeSession(
    &mut body.*,
    header,
    move limits,
    expectedCodings,
    expectedDecoders,
    scenarioReader,
  )
}

effect<'session> fn rawDeflateSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 4)
}

effect<'session> fn fixedZeroSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 24)
}

effect<'session> fn trailingSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 5)
}

effect<'session> fn encodedLimitSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 6)
}

effect<'session> fn intermediateLimitSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 7)
}

effect<'session> fn decodedLimitSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 8)
}

effect<'session> fn closeDelimitedSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 9)
}

effect<'session> fn chunkedSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let result = run scenarioSession(&mut body.*, 10)
  if result != 0 { return result }
  // The suffix may still be in the provider when the read buffer holds only two bytes.
  let mut suffix: [u8; 4] = [0, 0, 0, 0]
  let mut clock = FixedClock {}
  let read = BufferedDuplex.readExact(&mut body.*, &mut suffix, Option.none<Instant>())
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  match move (run Effect.result(move read)) {
    Result.Failure {error} => { drop error return 299 }
    Result.Success {value} => {}
  }
  if !bytesEqual(&suffix, b"NEXT") { return 299 }
  return 0
}

effect<'session> fn emptyReadSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 11)
}

effect<'session> fn earlyExitSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 12)
}

effect<'session> fn chunkSyntaxDirectSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let result = run scenarioSession(&mut body.*, 14)
  if result != 0 { return result }
  if bytesEqual(BufferedDuplex.peek(&body.*), b"NEXT") { return 0 }
  return 424
}

effect<'session> fn chunkSyntaxStagedSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let result = run scenarioSession(&mut body.*, 15)
  if result != 0 { return result }
  if bytesEqual(BufferedDuplex.peek(&body.*), b"NEXT") { return 0 }
  return 425
}

effect<'session> fn reviewMatrixSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let first = run scenarioSession(&mut body.*, 1)
  if first != 0 { return first }
  static if Intrinsic.targetArchitecture() == "wasm32" {
    return run scenarioSession(&mut body.*, 3)
  }
  let second = run scenarioSession(&mut body.*, 2)
  if second != 0 { return second }
  let third = run scenarioSession(&mut body.*, 3)
  if third != 0 { return third }
  let fixed = run scenarioSession(&mut body.*, 13)
  if fixed != 0 { return fixed }
  let identity = run scenarioSession(&mut body.*, 16)
  if identity != 0 { return identity }
  return 0
}

effect<'session> fn deadlineSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run scenarioSession(&mut body.*, 18)
}

effect<'call> fn typedCallbackReader<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 ! CallbackFailure {
  let completion = ContentReader.completion(&reader.*)
  match move completion {
    Result.Failure {error} => { drop error fail CallbackFailure {code: 1} }
    Result.Success {value} => match move value {
      Option.Some {value: evidence} => { drop evidence fail CallbackFailure {code: 2} }
      Option.None => {}
    }
  }
  fail CallbackFailure {code: 17}
}

effect fn callbackOutcome<'head>(
  attempted: Result<i32, CallbackFailure | ContentError<'head> | OutOfMemoryError>,
) -> i32 ! OutOfMemoryError {
  return match move attempted {
    Result.Success {value} => {
      if value != 0 { return value }
      return 482
    }
    Result.Failure {error} => match move error {
      CallbackFailure cause => {
        if cause.code == 17 { return 0 }
        return 484
      }
      ContentError<'head> cause => { drop cause return 485 }
      OutOfMemoryError exhausted => { fail move exhausted }
    }
  }
}

effect<'borrow> fn runTypedCallback<
  'borrow,
  'transport: 'borrow,
  'head: 'borrow,
  'method: 'borrow,
  'names: 'borrow,
>(
  plan: CodingPlan<'head, 'method, 'names>,
  body: &'borrow mut BufferedDuplex<'transport, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let attempted = run Effect.result(withReader<i32, CallbackFailure>(
    move plan,
    &mut body.*,
    typedCallbackReader,
  ))
  return run callbackOutcome<'head>(move attempted)
}

effect<'session> fn typedCallbackSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let parsed = match move (run parseResponse(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 4\\r\\nContent-Encoding: gzip\\r\\n\\r\\n",
    headLimits(),
  )) {
    Result.Failure {error} => { drop error return 471 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { drop error return 472 }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { drop error return 473 }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(head, method, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { drop error return 474 }
    Result.Success {value} => move value
  }
  let plan = match move CodingPlan.make(
    move context,
    Mode.Decode,
    bodyLimits(),
    contentLimits(),
  ) {
    Result.Failure {error} => { drop error return 475 }
    Result.Success {value} => move value
  }
  let result = run runTypedCallback(move plan, &mut body.*)
  if result != 0 { return result }
  if BufferedDuplex.unread(&body.*) == usize.ZERO { return 0 }
  return 477
}

effect<'call> fn noBodyReader<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let metadata = match move ContentReader.representation(&reader.*) {
    Result.Failure {error} => { drop error return 332 }
    Result.Success {value} => move value
  }
  if metadata.decodingApplied()
    || metadata.anomaly() != Anomaly.ProhibitedFraming
    || metadata.appliedPlan().reuse != ReuseDisposition.NonReusable {
    drop metadata
    return 333
  }
  match move metadata.decodedLength() {
    Option.None => { drop metadata return 334 }
    Option.Some {value} => {
      if value != u64.MIN { drop metadata return 335 }
    }
  }
  drop metadata
  return match move ContentReader.completion(&reader.*) {
    Result.Failure {error} => { drop error return 336 }
    Result.Success {value} => match move value {
      Option.None => 337
      Option.Some {value: completion} => {
        if completion.anomaly() == Anomaly.ProhibitedFraming
          && completion.reuse() == ReuseDisposition.NonReusable
          && completion.decodedBytes() == u64.MIN { return 0 }
        return 338
      }
    }
  }
}

effect<'session> fn noBodySession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let parsed = match move (run parseResponse(
    b"HTTP/1.1 204 No Content\\r\\nContent-Length: 4\\r\\nContent-Encoding: nonsense\\r\\n\\r\\n",
    headLimits(),
  )) {
    Result.Failure {error} => { drop error return 339 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { drop error return 340 }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { drop error return 341 }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(head, method, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { drop error return 342 }
    Result.Success {value} => move value
  }
  let plan = match move CodingPlan.make(
    move context,
    Mode.Decode,
    bodyLimits(),
    contentLimits(),
  ) {
    Result.Failure {error} => { drop error return 343 }
    Result.Success {value} => move value
  }
  return run Effect.catchAll(
    withReader<i32, never>(move plan, &mut body.*, noBodyReader),
    failed,
  )
}

effect<'call> fn bufferFailureReader<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  return run readFailure(move reader, ExpectedFailure.Buffer, 345)
}

effect<'call> fn bodyFailureReader<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  return run readFailure(move reader, ExpectedFailure.BodyUnderrun, 352)
}

effect<'session> fn bufferFailureSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run decodeSession(
    &mut body.*,
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\n\\r\\n",
    contentLimits(),
    usize.ZERO,
    usize.ZERO,
    bufferFailureReader,
  )
}

effect<'session> fn bodyFailureSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  return run decodeSession(
    &mut body.*,
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 4\\r\\n\\r\\n",
    contentLimits(),
    usize.ZERO,
    usize.ZERO,
    bodyFailureReader,
  )
}

effect fn framingFailuresStayTyped() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut failedSource = run failingProvider()
  let buffered = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut failedSource,
    8,
    1,
    bufferFailureSession,
  )
  if buffered != 0 { return buffered }
  let mut shortSource = run provider(b"ab")
  return run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut shortSource,
    8,
    1,
    bodyFailureSession,
  )
}

effect fn semanticNoBodyCompletesWithoutIo() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut source = run provider(b"body")
  let result = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut source,
    8,
    1,
    noBodySession,
  )
  if result != 0 { return result }
  if MemoryByteDuplex.audit(&source).length != usize.ONE { return 344 }
  return 0
}

effect fn rawDeflateIsRejected() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut source = run provider(b"\\x4b\\x4c\\x4a\\x06\\x00")
  let rejected = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut source,
    8,
    1,
    rawDeflateSession,
  )
  if rejected != 0 { return rejected }
  let mut empty = run provider(b"")
  return run withBufferedCapacity<i32, OutOfMemoryError>(&mut empty, 8, 1, fixedZeroSession)
}

effect fn trailingZlibIsRejected() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut source = run provider(
    b"\\x78\\x9c\\xf3\\x48\\xcd\\xc9\\xc9\\xd7\\x51\\xa8\\xca\\xc9\\x4c\\x52\\x04\\x00\\x1b\\x65\\x04\\x13XX",
  )
  return run withBufferedCapacity<i32, OutOfMemoryError>(&mut source, 32, 1, trailingSession)
}

effect fn contentLimitsFailExactly() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut raw = run provider(b"data")
  let encoded = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut raw,
    8,
    1,
    encodedLimitSession,
  )
  if encoded != 0 { return encoded }
  let mut stacked = run provider(
    b"\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\xd3\\xd8\\xaa\\xff\\x57\\x81\\x59\\x92\\x81\\x21\\x31\\x29\\x19\\x00\\x70\\x76\\xf9\\xb4\\x0c\\x00\\x00\\x00",
  )
  let intermediate = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut stacked,
    32,
    1,
    intermediateLimitSession,
  )
  if intermediate != 0 { return intermediate }
  let mut deflated = run provider(
    b"\\x78\\x9c\\xf3\\x48\\xcd\\xc9\\xc9\\xd7\\x51\\xa8\\xca\\xc9\\x4c\\x52\\x04\\x00\\x1b\\x65\\x04\\x13",
  )
  return run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut deflated,
    32,
    1,
    decodedLimitSession,
  )
}

effect fn framingAndScopedExit() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut closeDelimited = run provider(
    b"\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\x4b\\xce\\xc9\\x2f\\x4e\\x05\\x00\\xc4\\x81\\x01\\x13\\x05\\x00\\x00\\x00",
  )
  let closed = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut closeDelimited,
    3,
    1,
    closeDelimitedSession,
  )
  if closed != 0 { return closed }
  let mut chunked = run provider(
    b"19\\r\\n\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\x4b\\xce\\xc9\\x2f\\x4e\\x05\\x00\\xc4\\x81\\x01\\x13\\x05\\x00\\x00\\x00\\r\\n0\\r\\nX-End: yes\\r\\n\\r\\nNEXT",
  )
  let chunkedResult = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut chunked,
    2,
    1,
    chunkedSession,
  )
  if chunkedResult != 0 { return chunkedResult }
  let mut empty = run provider(b"data")
  let emptyResult = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut empty,
    8,
    1,
    emptyReadSession,
  )
  if emptyResult != 0 { return emptyResult }
  if MemoryByteDuplex.audit(&empty).length != usize.ONE { return 304 }
  let mut early = run provider(b"data")
  let earlyResult = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut early,
    8,
    1,
    earlyExitSession,
  )
  if earlyResult != 0 { return earlyResult }
  if MemoryByteDuplex.closeAttempts(&early) != usize.ONE { return 305 }
  return 0
}

effect fn committedBodyFailuresConsumePrefix() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut direct = run provider(b"g\\r\\nNEXT")
  let directResult = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut direct,
    8,
    1,
    chunkSyntaxDirectSession,
  )
  if directResult != 0 { return directResult }
  let mut staged = run provider(b"g\\r\\nNEXT")
  return run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut staged,
    8,
    1,
    chunkSyntaxStagedSession,
  )
}

// One nominal context handles every poisoned-body case in the shared runtime program.
struct ReviewFailure { case: u8 }
impl ReviewFailure {
  effect<'session> fn use<'session, 'transport: 'session>(
    context: Self,
    body: &'session mut BufferedDuplex<'transport, MemoryByteDuplex>,
  ) -> i32 ! OutOfMemoryError ? &mut Allocator {
    return run scenarioSession(move body, context.case)
  }
}
impl BufferedContext<MemoryByteDuplex, i32, OutOfMemoryError ? &mut Allocator> for ReviewFailure {
  use: ReviewFailure.use
}

effect fn reviewFailure(case: u8, input: &[u8]) -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut source = run provider(input)
  return run withBufferedCapacityContext<i32, OutOfMemoryError>(
    &mut source,
    1,
    1,
    ReviewFailure {case: case},
  )
}

effect fn reviewRuntimeMatrix() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  static if Intrinsic.targetArchitecture() == "wasm32" {
    let mut portable = run provider(
      b"\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\xd3\\xd8\\xaa\\xff\\x57\\x81\\x59\\x92\\x81\\x21\\x31\\x29\\x19\\x00\\x70\\x76\\xf9\\xb4\\x0c\\x00\\x00\\x00\\x78\\x9c\\xf3\\x48\\xcd\\xc9\\xc9\\xd7\\x51\\xa8\\xca\\xc9\\x4c\\x52\\x04\\x00\\x1b\\x65\\x04\\x13",
    )
    return run withBufferedCapacity<i32, OutOfMemoryError>(
      &mut portable,
      4,
      1,
      reviewMatrixSession,
    )
  }
  let mut source = run provider(
    b"\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\xd3\\xd8\\xaa\\xff\\x57\\x81\\x59\\x92\\x81\\x21\\x31\\x29\\x19\\x00\\x70\\x76\\xf9\\xb4\\x0c\\x00\\x00\\x00\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\x4b\\xcb\\x2c\\x2a\\x2e\\x01\\x00\\x57\\xee\\x71\\x92\\x05\\x00\\x00\\x00\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\x2b\\x4e\\x4d\\xce\\xcf\\x4b\\x01\\x00\\x69\\x11\\x1f\\xb6\\x06\\x00\\x00\\x00\\x78\\x9c\\xf3\\x48\\xcd\\xc9\\xc9\\xd7\\x51\\xa8\\xca\\xc9\\x4c\\x52\\x04\\x00\\x1b\\x65\\x04\\x13\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\x4b\\xce\\xc9\\x2f\\x4e\\x05\\x00\\xc4\\x81\\x01\\x13\\x05\\x00\\x00\\x00id",
  )
  let positive = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut source,
    1,
    1,
    reviewMatrixSession,
  )
  if positive != 0 { return positive }
  // A failed reader leaves its unconsumed wire suffix in the transport. Each negative
  // case owns fresh input so an earlier budget refusal cannot feed a later decoder.
  let checksum = run reviewFailure(17, b"\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\x4b\\xcb\\x2c\\x2a\\x2e\\x01\\x00\\x56\\xee\\x71\\x92\\x05\\x00\\x00\\x00")
  if checksum != 0 { return checksum }
  let encoded = run reviewFailure(19, b"x")
  if encoded != 0 { return encoded }
  let intermediate = run reviewFailure(20, b"\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\xd3\\xd8\\xaa\\xff\\x57\\x81\\x59\\x92\\x81\\x21\\x31\\x29\\x19\\x00\\x70\\x76\\xf9\\xb4\\x0c\\x00\\x00\\x00")
  if intermediate != 0 { return intermediate }
  let decoded = run reviewFailure(21, b"x")
  if decoded != 0 { return decoded }
  let empty = run reviewFailure(22, b"")
  if empty != 0 { return empty }
  return run reviewFailure(23, b"\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\xd3\\xdc\\xaa\\xff\\x57\\x81\\x59\\x92\\x81\\x21\\x31\\x29\\x19\\x00\\x1f\\x3a\\x5c\\x2f\\x0c\\x00\\x00\\x00")
}

effect fn deadlineIsForwarded() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut source = run deadlineProvider()
  let result = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut source,
    1,
    1,
    deadlineSession,
  )
  if result != 0 { return result }
  if MemoryByteDuplex.audit(&source).length != usize.ONE { return 478 }
  if MemoryByteDuplex.closeAttempts(&source) != usize.ONE { return 479 }
  return 0
}

effect fn typedCallbackFailureReleases() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut source = run provider(b"data")
  let result = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut source,
    4,
    1,
    typedCallbackSession,
  )
  if result != 0 { return result }
  let audit = MemoryByteDuplex.audit(&source)
  if audit.length != usize.ONE
    || audit[0].operation != ByteIoOperation.Close
    || audit[0].count != usize.ZERO { return 480 }
  if MemoryByteDuplex.closeAttempts(&source) != usize.ONE { return 481 }
  return 0
}

effect<'call> fn allocationOpened<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let completion = ContentReader.completion(&reader.*)
  return match move completion {
    Result.Failure {error} => { drop error return 311 }
    Result.Success {value} => match move value {
      Option.None => 42
      Option.Some {value: evidence} => { drop evidence return 312 }
    }
  }
}

effect<'borrow> fn allocationAttempt<
  'borrow,
  'transport: 'borrow,
  'head: 'borrow,
  'method: 'borrow,
>(
  body: &'borrow mut BufferedDuplex<'transport, MemoryByteDuplex>,
  head: ResponseHead<'head>,
  method: Method<'method>,
  audit: &mut FailingAllocator,
  invalidBody: bool,
) -> i32 {
  let context = match move ResponseContext.make(
    head,
    method,
    TrailerPolicy.defaultPolicy(),
  ) {
    Result.Failure {error} => { drop error return 314 }
    Result.Success {value} => move value
  }
  let mut limits = bodyLimits()
  if invalidBody { limits.maxTrailerFields = usize.MAX }
  let plan = match move CodingPlan.make(
    move context,
    Mode.Decode,
    limits,
    contentLimits(),
  ) {
    Result.Failure {error} => { drop error return 315 }
    Result.Success {value} => move value
  }
  let opened = withReader<i32, never>(move plan, &mut body.*, allocationOpened)
    |> Effect.provideMut<Allocator>(move audit)
  let attempted = run Effect.result(move opened)
  return match move attempted {
    Result<i32, ContentError<'head> | OutOfMemoryError>.Success {value} => value
    Result<i32, ContentError<'head> | OutOfMemoryError>.Failure {error} => match move error {
      OutOfMemoryError {} => 0
      ContentError<'head> failure => match move failure.reason {
        ContentReason.Body {error: cause} => {
          if invalidBody && cause.component == BodyComponent.Decoder {
            match move cause.reason {
              BodyReason.SizeOverflow => { return 43 }
              _ => { return 313 }
            }
          }
          return 313
        }
        _ => { return 313 }
      }
    }
  }
}

effect<'session> fn allocationFailureSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let parsed = match move (run parseResponse(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 4\\r\\nContent-Encoding: gzip, deflate, zstd\\r\\n\\r\\n",
    headLimits(),
  )) {
    Result.Failure {error} => { drop error return 316 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { drop error return 317 }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { drop error return 318 }
    Result.Success {value} => value
  }
  // Invalid body sizing must win before the first body or content-codec allocation.
  let mut invalid = FailingAllocator {calls: usize.ZERO, failAt: usize.ONE}
  let invalidResult = run allocationAttempt(&mut body.*, head, method, &mut invalid, true)
  if invalidResult != 43 || invalid.calls != usize.ZERO { return 327 }
  let mut successful = FailingAllocator {calls: usize.ZERO, failAt: usize.ZERO}
  let opened = run allocationAttempt(&mut body.*, head, method, &mut successful, false)
  if opened != 42 || successful.calls == usize.ZERO { return 319 }
  let total = successful.calls
  if total <= usize.ONE { return 320 }
  // The allocator observes attempts, not releases: test early and partial-construction failure.
  let mut first = FailingAllocator {calls: usize.ZERO, failAt: usize.ONE}
  let firstFailure = run allocationAttempt(&mut body.*, head, method, &mut first, false)
  if firstFailure != 0 || first.calls != usize.ONE { return 321 }
  let mut late = FailingAllocator {calls: usize.ZERO, failAt: total}
  let lateFailure = run allocationAttempt(&mut body.*, head, method, &mut late, false)
  if lateFailure != 0 || late.calls != total { return 322 }
  return 0
}

effect fn allocationFailureBoundaries() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut source = run provider(b"")
  let result = run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut source,
    8,
    1,
    allocationFailureSession,
  )
  if result != 0 { return result }
  if MemoryByteDuplex.audit(&source).length != usize.ONE { return 323 }
  return 0
}

effect<'call> fn canceledReader<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  let completion = ContentReader.completion(&reader.*)
  match move completion {
    Result.Failure {error} => { drop error return 324 }
    Result.Success {value} => match move value {
      Option.Some {value: evidence} => { drop evidence return 325 }
      Option.None => {}
    }
  }
  run Execution.park(retainCancellationWake)
  return 326
}

effect<'session> fn cancellationSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let parsed = match move (run parseResponse(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 4\\r\\n\\r\\n",
    headLimits(),
  )) {
    Result.Failure {error} => { drop error return 327 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { drop error return 328 }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { drop error return 329 }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(
    head,
    method,
    TrailerPolicy.defaultPolicy(),
  ) {
    Result.Failure {error} => { drop error return 330 }
    Result.Success {value} => move value
  }
  let plan = match move CodingPlan.make(
    move context,
    Mode.Raw,
    bodyLimits(),
    contentLimits(),
  ) {
    Result.Failure {error} => { drop error return 331 }
    Result.Success {value} => move value
  }
  let opened = withReader<i32, never>(move plan, &mut body.*, canceledReader)
  return run Effect.catchAll(move opened, failed)
}

effect fn canceledContent(state: Shared<CancellationState>) -> i32
! BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let source = run provider(b"data") |> Effect.provideMut<Allocator>(&mut allocator)
  let mut owner = CancellationOwner {source: move source, state: move state}
  return run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut owner.source,
    8,
    1,
    cancellationSession,
  )
    |> Effect.provideMut<Allocator>(&mut allocator)
}

fn cancellationReady(state: &()) -> () { return () }

fn cancellationComplete(state: &mut i32, value: i32) -> () {
  state.* = value
  return ()
}

fn cancellationParked(state: &mut i32, execution: Intrinsic.Execution<i32>) -> () {
  drop move execution
  state.* = 42
  return ()
}

effect fn structuredCancellation() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let state = run Shared.make<CancellationState>(CancellationState {
    ownerDrops: usize.ZERO,
    auditEntries: usize.ZERO,
    closeAttempts: usize.ZERO,
  }) |> Effect.provideMut<Allocator>(&mut allocator)
  let body = Effect.catchAll(canceledContent(Shared.clone(&state)), failed)
  let execution = run Execution.make(move body, (), cancellationReady)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut result = 0
  run Execution.drive(move execution, &mut result, cancellationComplete, cancellationParked)
  if result != 42 { drop state return result }
  return Shared.with(&state, cancellationCode)
}

effect<'session> fn rawSession<'session>(
  body: &'session mut BufferedDuplex<'session, MemoryByteDuplex>,
) -> i32
! OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let parsed = match move (run parseResponse(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 4\\r\\nContent-Encoding: weird;bad\\r\\n\\r\\n",
    headLimits(),
  )) {
    Result.Failure {error} => { return 10 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { return 11 }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { return 12 }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(head, method, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { return 13 }
    Result.Success {value} => move value
  }
  let plan = match move CodingPlan.make(move context, Mode.Raw, bodyLimits(), contentLimits()) {
    Result.Failure {error} => { return 14 }
    Result.Success {value} => move value
  }
  if plan.applied().codingCount != usize.ZERO { return 15 }
  let opened = withReader<i32, never>(move plan, &mut body.*, rawReader)
  let result = run Effect.catchAll(move opened, failed)
  if result != 0 { return result }
  if BufferedDuplex.unread(&body.*) != 4 { return 37 }
  return 0
}

effect fn rawBypassesCoding() -> i32
! BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut source = run provider(b"raw!NEXT")
  return run withBufferedCapacity<i32, OutOfMemoryError>(
    &mut source,
    16,
    1,
    rawSession,
  )
}

fn negotiation() -> i32 {
  if !automaticEquals(false, false, false, b"") { return 41 }
  if !generatedEquals(
    acceptEncoding<'static>(
      Mode.Decode,
      AcceptEncoding<'static>.Automatic {
        enabled: EnabledCodings {gzip: false, deflate: false, zstd: false},
        empty: EmptyEncodingPolicy.Identity,
      },
      valueLimits(),
    ),
    b"identity",
  ) { return 54 }
  if !generatedOmitted(acceptEncoding<'static>(
    Mode.Decode,
    AcceptEncoding<'static>.Omit,
    valueLimits(),
  )) { return 60 }
  if !automaticEquals(true, false, false, b"gzip") { return 42 }
  if !automaticEquals(false, true, false, b"deflate") { return 43 }
  if !automaticEquals(false, false, true, b"zstd") { return 44 }
  if !automaticEquals(true, true, false, b"gzip, deflate") { return 45 }
  if !automaticEquals(true, false, true, b"gzip, zstd") { return 46 }
  if !automaticEquals(false, true, true, b"deflate, zstd") { return 47 }
  if !automaticEquals(true, true, true, b"gzip, deflate, zstd") { return 48 }
  if !generatedOmitted(acceptEncoding<'static>(
    Mode.Raw,
    AcceptEncoding<'static>.Automatic {
      enabled: EnabledCodings {gzip: true, deflate: true, zstd: true},
      empty: EmptyEncodingPolicy.Identity,
    },
    valueLimits(),
  )) { return 49 }
  if !generatedEquals(
    acceptEncoding<'static>(
      Mode.Decode,
      AcceptEncoding<'static>.Override {value: b"br;q=0.4"},
      valueLimits(),
    ),
    b"br;q=0.4",
  ) { return 50 }
  let invalidByte = acceptEncoding<'static>(
    Mode.Decode,
    AcceptEncoding<'static>.Override {value: b"a\\nb"},
    valueLimits(),
  )
  match move invalidByte {
    Result.Success {value} => { return 51 }
    Result.Failure {error} => match move error.reason {
      ValueReason.InvalidValueByte => {
        if error.component != ValueComponent.HeaderValue || error.offset != usize.ONE { return 52 }
      }
      _ => { return 53 }
    }
  }
  if !invalidOverrideByte(b" gzip", usize.ZERO) { return 55 }
  if !invalidOverrideByte(b"gzip ", 4) { return 56 }
  let mut short = valueLimits()
  short.maxValueBytes = 3
  let oversized = acceptEncoding<'static>(
    Mode.Decode,
    AcceptEncoding<'static>.Override {value: b"gzip"},
    move short,
  )
  return match move oversized {
    Result.Success {value} => 57
    Result.Failure {error} => match move error.reason {
      ValueReason.LimitExceeded {limit, allowed, attempted} => {
        if error.component == ValueComponent.HeaderValue
          && error.offset == 4
          && limit == LimitKind.ValueBytes
          && allowed == 3
          && attempted == 4 { return 0 }
        return 58
      }
      _ => 59
    }
  }
}

fn invalidOverrideByte(value: &[u8], expectedOffset: usize) -> bool {
  let invalid = acceptEncoding(
    Mode.Decode,
    AcceptEncoding.Override {value: value},
    valueLimits(),
  )
  return match move invalid {
    Result.Success {value: generated} => false
    Result.Failure {error} => match move error.reason {
      ValueReason.InvalidValueByte => error.component == ValueComponent.HeaderValue
        && error.offset == expectedOffset
      _ => false
    }
  }
}

fn automaticEquals(gzip: bool, deflate: bool, zstd: bool, expected: &[u8]) -> bool {
  let generated = acceptEncoding<'static>(
    Mode.Decode,
    AcceptEncoding<'static>.Automatic {
      enabled: EnabledCodings {gzip: gzip, deflate: deflate, zstd: zstd},
      empty: EmptyEncodingPolicy.Omit,
    },
    valueLimits(),
  )
  if expected.length == usize.ZERO { return generatedOmitted(move generated) }
  return generatedEquals(move generated, expected)
}

fn generatedOmitted<'value>(
  generated: Result<Option<Header<'value>>, ValueError>,
) -> bool {
  return match move generated {
    Result.Failure {error} => false
    Result.Success {value} => match move value {
      Option.None => true
      Option.Some {value: header} => false
    }
  }
}

fn generatedEquals<'value>(
  generated: Result<Option<Header<'value>>, ValueError>,
  expected: &[u8],
) -> bool {
  return match move generated {
    Result.Failure {error} => false
    Result.Success {value} => match move value {
      Option.None => false
      Option.Some {value: header} => bytesEqual(Header.value(&header), expected)
    }
  }
}

fn bytesEqual(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

effect fn responseContextSelectionFailure() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseResponse(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    headLimits(),
  )) {
    Result.Failure {error} => { drop error return 61 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { drop error return 62 }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { drop error return 63 }
    Result.Success {value} => value
  }
  return match move ResponseContext.make(head, method, TrailerPolicy.defaultPolicy()) {
    Result.Success {value} => { drop value return 64 }
    Result.Failure {error} => match move error.reason {
      BodyReason.ConflictingFraming => {
        if error.component == BodyComponent.Selection
          && error.wireOffset == u64.MIN
          && error.consumed == usize.ZERO
          && error.written == usize.ZERO { return 0 }
        return 65
      }
      _ => 66
    }
  }
}

effect fn program() -> i32 ! BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let planned = run planning() |> Effect.provideMut<Allocator>(&mut allocator)
  if planned != 0 { return planned }
  let mut clock = FixedClock {}
  let raw = run rawBypassesCoding()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if raw != 0 { return raw }
  let reviewMatrix = run reviewRuntimeMatrix()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if reviewMatrix != 0 { return reviewMatrix }
  let rawDeflate = run rawDeflateIsRejected()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if rawDeflate != 0 { return rawDeflate }
  let trailing = run trailingZlibIsRejected()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if trailing != 0 { return trailing }
  let limited = run contentLimitsFailExactly()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if limited != 0 { return limited }
  let framing = run framingAndScopedExit()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if framing != 0 { return framing }
  let committedBodyFailure = run committedBodyFailuresConsumePrefix()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if committedBodyFailure != 0 { return committedBodyFailure }
  let deadline = run deadlineIsForwarded()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if deadline != 0 { return deadline }
  let callbackFailure = run typedCallbackFailureReleases()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if callbackFailure != 0 { return callbackFailure }
  let noBodyCompletion = run semanticNoBodyCompletesWithoutIo()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if noBodyCompletion != 0 { return noBodyCompletion }
  let framingFailures = run framingFailuresStayTyped()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if framingFailures != 0 { return framingFailures }
  let allocations = run allocationFailureBoundaries()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if allocations != 0 { return allocations }
  let cancellation = run structuredCancellation()
  if cancellation != 0 { return cancellation }
  let contextFailure = run responseContextSelectionFailure()
    |> Effect.provideMut<Allocator>(&mut allocator)
  if contextFailure != 0 { return contextFailure }
  return negotiation()
}

effect fn portableProgram() -> i32 ! BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let matrix = run reviewRuntimeMatrix()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if matrix != 0 { return matrix }
  return run rawDeflateIsRejected()
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
}

effect<'env> fn failed<E: 'env, 'env>(error: E) -> i32 { drop error return 99 }

effect fn ownedIncrementalCore() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move run parseResponse(b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\n\\r\\n", headLimits()) {
    Result.Failure {error} => { drop error return 401 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { drop error return 402 }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(head, Method.get(), TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { drop error return 403 }
    Result.Success {value} => move value
  }
  let plan = match move CodingPlan.make(move context, Mode.Raw, bodyLimits(), contentLimits()) {
    Result.Failure {error} => { drop error return 404 }
    Result.Success {value} => move value
  }
  let mut decoder = match move run Effect.result(ContentDecoder.make(move plan)) {
    Result.Failure {error} => { drop error return 405 }
    Result.Success {value} => move value
  }
  let mut empty: [u8; 0] = []
  let untouched = match move ContentDecoder.step(&mut decoder, b"aNEXT", &mut empty, true) {
    Result.Failure {error} => { drop error return 406 }
    Result.Success {value} => move value
  }
  if untouched.consumed != usize.ZERO || untouched.progress.written != usize.ZERO || untouched.needsInput { return 407 }
  let mut output: [u8; 1] = [0]
  let read = match move ContentDecoder.step(&mut decoder, b"aNEXT", &mut output, true) {
    Result.Failure {error} => { drop error return 408 }
    Result.Success {value} => move value
  }
  if read.consumed != usize.ONE || read.progress.written != usize.ONE || output[0] != 97 { return 409 }
  let completed = match move ContentDecoder.completion(&decoder) {
    Result.Failure {error} => { drop error return 410 }
    Result.Success {value} => move value
  }
  return match move completed { Option.None => 411 Option.Some {value} => 0 }
}


pub fn main() -> i32 {
  let mut coreAllocator = Allocator.systemAllocatorProvider()
  let core = run Effect.catchAll(ownedIncrementalCore(), failed)
    |> Effect.provideMut<Allocator>(&mut coreAllocator)
  if core != 0 { return core }
  static if Intrinsic.targetArchitecture() == "wasm32" {
    return run Effect.catchAll(portableProgram(), failed)
  }
  return run Effect.catchAll(program(), failed)
}
`

/** Compact shared imports and helpers for ticket-local structured analyses. */
export const httpContentAnalysisPrelude = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.buffered_duplex {BufferedDuplex}
import silk.effect {Effect}
import silk.http {Method}
import silk.http_body {
  Anomaly,
  CompletionKind as BodyCompletionKind,
  Decoder as BodyDecoder,
  Framing,
  Limits as BodyLimits,
  Selection,
  TrailerPolicy,
}
import silk.http_content {
  CodingPosition,
  CodingPlan,
  ContentCompletion,
  ContentError,
  ContentLimitKind,
  ContentReason,
  ContentReader,
  Limits,
  Mode,
  ResponseContext,
  ReuseDisposition,
  withReader,
}
import silk.http_head {Limits as HeadLimits, ResponseHead, ResponseParser, parseResponse}
import silk.http_headers {Limits as ValueLimits}
import silk.inflate {Decoder as InflateDecoder, ErrorKind as InflateErrorKind, Limits as InflateLimits}
import silk.layout {Layout}
import silk.memory_byte_duplex {MemoryByteDuplex}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.usize
import silk.zstd {Zstd, ZstdLimits, ZstdReason}

struct FixedClock {}

impl MonotonicClock for FixedClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { drop howLong return () }
}

fn valueLimits() -> ValueLimits {
  return ValueLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 128,
    maxNameBytes: 64,
    maxValueBytes: 256,
    maxFields: 16,
    maxFieldBytes: 512,
    maxOwnedBytes: 2048,
  }
}

fn headLimits() -> HeadLimits {
  return HeadLimits {
    maxHeadBytes: 1024,
    maxStartLineBytes: 256,
    maxFieldLineBytes: 512,
    maxOwnedBytes: 4096,
    values: valueLimits(),
  }
}

fn bodyLimits() -> BodyLimits {
  return BodyLimits {
    maxWireBytes: 4096,
    maxPayloadBytes: 2048,
    maxChunkBytes: 512,
    maxChunks: 16,
    maxChunkLineBytes: 128,
    maxExtensionBytes: 256,
    maxTrailerBytes: 512,
    maxTrailerFields: 8,
    maxOwnedBytes: 8192,
    trailerValues: valueLimits(),
  }
}

fn contentLimits() -> Limits {
  return Limits {
    maxEncoded: 2048,
    maxIntermediate: 4096,
    maxDecoded: 4096,
    maxOwned: 2097152,
    maxDepth: 4,
    intermediateCapacity: 8,
    inflate: InflateLimits {
      maxInputBytes: 2048,
      maxOutputBytes: 4096,
      maxMembers: 8,
      maxHeaderBytes: 512,
      maxMemoryBytes: 65536,
    },
    zstd: ZstdLimits {
      inputBytes: 2048,
      outputBytes: 4096,
      frames: 8,
      skippableBytes: 512,
      windowBytes: 1024,
      workspaceBytes: 1048576,
    },
  }
}

effect<'call> fn analysisReader<
  'call,
  'reader: 'call,
  'transport: 'reader,
  'head: 'reader,
>(
  reader: &'call mut ContentReader<'reader, 'transport, 'head, MemoryByteDuplex>,
) -> i32 {
  drop reader
  return 0
}`

/** Planning cases shared by structured analysis and the native acceptance program. */
const httpContentPlanningDeclarations = `enum PlanningExpectation {
  ValidStack,
  SemanticNoBody,
  SemanticHttp10NoBody,
  SemanticCleanNoBody,
  EmptySyntax,
  ParameterSyntax,
  InvalidTokenSyntax,
  Unsupported,
  Depth,
  Partial,
  Tunnel,
  InvalidDepth,
  ExcessDepthLimit,
  ExcessCodingDepth,
  InvalidCapacity,
  ExcessCapacity,
  InflateMemory,
  InflateMembers,
  ZstdWorkspace,
  ZstdWindow,
  Owned,
  Arithmetic,
}

effect fn planningCase<'head>(
  response: &'head [u8],
  methodName: string,
  limits: Limits,
  expected: PlanningExpectation,
  base: i32,
) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseResponse(response, headLimits())) {
    Result.Failure {error} => { return base + 1 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { return base + 2 }
    Result.Success {value} => value
  }
  let method = match move Method.parse(methodName, 16) {
    Result.Failure {error} => { return base + 3 }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(head, method, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { return base + 4 }
    Result.Success {value} => move value
  }
  let planned = CodingPlan.make(move context, Mode.Decode, bodyLimits(), move limits)
  return match move planned {
    Result.Success {value} => {
      let applied = value.applied()
      if expected == PlanningExpectation.ValidStack {
        if applied.mode == Mode.Decode
          && applied.codingCount == 4
          && applied.decoderCount == 3 { return 0 }
        return base + 6
      }
      if applied.codingCount != usize.ZERO || applied.decoderCount != usize.ZERO {
        return base + 6
      }
      let correct = (expected == PlanningExpectation.SemanticNoBody
          && value.selectionAnomaly() == Anomaly.ProhibitedFraming
          && applied.reuse == ReuseDisposition.NonReusable)
        || (expected == PlanningExpectation.SemanticHttp10NoBody
          && value.selectionAnomaly() == Anomaly.Http10TransferEncoding
          && applied.reuse == ReuseDisposition.NonReusable)
        || (expected == PlanningExpectation.SemanticCleanNoBody
          && value.selectionAnomaly() == Anomaly.None
          && applied.reuse == ReuseDisposition.EligibleAfterCompletion)
      if !correct { return base + 7 }
      return 0
    }
    Result.Failure {error} => {
      let correct = match move error.reason {
        ContentReason.CodingSyntax {position} => matchesSyntax(expected, position)
        ContentReason.UnsupportedCoding {position, token} => matchesUnsupported(
          expected,
          position,
          token,
        )
        ContentReason.InvalidLimit {limit, allowed, attempted} => matchesPlanningLimit(
          expected,
          limit,
          allowed,
          attempted,
        )
        ContentReason.PartialResponse {position} => expected == PlanningExpectation.Partial
          && position.wireIndex == usize.ZERO
          && position.fieldIndex == usize.ONE
        ContentReason.Tunnel => expected == PlanningExpectation.Tunnel
        ContentReason.Inflate {stage, wireIndex, error: cause} => stage == usize.ZERO
          && wireIndex == usize.ZERO
          && ((expected == PlanningExpectation.InflateMemory
              && cause.kind == InflateErrorKind.MemoryLimit)
            || (expected == PlanningExpectation.InflateMembers
              && cause.kind == InflateErrorKind.MemberLimit))
        ContentReason.Zstandard {stage, wireIndex, error: cause} => stage == usize.ZERO
          && wireIndex == usize.ZERO
          && ((expected == PlanningExpectation.ZstdWorkspace
              && cause.reason == ZstdReason.WorkspaceLimit)
            || (expected == PlanningExpectation.ZstdWindow
              && cause.reason == ZstdReason.InvalidConfiguration))
        ContentReason.ArithmeticOverflow => expected == PlanningExpectation.Arithmetic
        _ => false
      }
      if correct { return 0 }
      return base + 8
    }
  }
}

fn matchesSyntax(expected: PlanningExpectation, position: CodingPosition) -> bool {
  if expected == PlanningExpectation.EmptySyntax {
    return position.wireIndex == usize.ONE
      && position.fieldIndex == usize.ONE
      && position.elementIndex == usize.ONE
      && position.offset == 5
  }
  if expected == PlanningExpectation.ParameterSyntax {
    return position.wireIndex == usize.ZERO
      && position.fieldIndex == usize.ONE
      && position.elementIndex == usize.ZERO
      && position.offset == 4
  }
  return expected == PlanningExpectation.InvalidTokenSyntax
    && position.wireIndex == usize.ZERO
    && position.fieldIndex == usize.ONE
    && position.elementIndex == usize.ZERO
    && position.offset == 3
}

fn matchesUnsupported(
  expected: PlanningExpectation,
  position: CodingPosition,
  token: &[u8],
) -> bool {
  return expected == PlanningExpectation.Unsupported
    && position.wireIndex == usize.ZERO
    && position.fieldIndex == usize.ONE
    && position.elementIndex == usize.ZERO
    && position.offset == usize.ZERO
    && token.length == 7
}

fn matchesPlanningLimit(
  expected: PlanningExpectation,
  limit: ContentLimitKind,
  allowed: u64,
  attempted: u64,
) -> bool {
  if expected == PlanningExpectation.Depth {
    return limit == ContentLimitKind.CodingDepth && allowed == 2 && attempted == 3
  }
  if expected == PlanningExpectation.InvalidDepth {
    return limit == ContentLimitKind.CodingDepth && allowed == 4 && attempted == 0
  }
  if expected == PlanningExpectation.ExcessDepthLimit
    || expected == PlanningExpectation.ExcessCodingDepth {
    return limit == ContentLimitKind.CodingDepth && allowed == 4 && attempted == 5
  }
  if expected == PlanningExpectation.InvalidCapacity {
    return limit == ContentLimitKind.IntermediateCapacity && allowed == 65536 && attempted == 0
  }
  if expected == PlanningExpectation.ExcessCapacity {
    return limit == ContentLimitKind.IntermediateCapacity
      && allowed == 65536
      && attempted == 65537
  }
  return expected == PlanningExpectation.Owned
    && limit == ContentLimitKind.OwnedBytes
    && allowed == u64.MIN
    && attempted > u64.MIN
}

effect fn plannedOwned<'head>(response: &'head [u8], limits: Limits) -> usize
! OutOfMemoryError
? &mut Allocator {
  let parsed = match move (run parseResponse(response, headLimits())) {
    Result.Failure {error} => { drop error return usize.ZERO }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { drop error return usize.ZERO }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { drop error return usize.ZERO }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(head, method, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { drop error return usize.ZERO }
    Result.Success {value} => move value
  }
  return match move CodingPlan.make(move context, Mode.Decode, bodyLimits(), move limits) {
    Result.Failure {error} => { drop error return usize.ZERO }
    Result.Success {value} => value.ownedBytes()
  }
}

effect fn ownedBoundary<'head>(
  response: &'head [u8],
  expected: usize,
) -> i32
! OutOfMemoryError
? &mut Allocator {
  let mut limits = contentLimits()
  limits.intermediateCapacity = usize.ONE
  limits.maxOwned = expected - usize.ONE
  let parsed = match move (run parseResponse(response, headLimits())) {
    Result.Failure {error} => { drop error return 296 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { drop error return 297 }
    Result.Success {value} => value
  }
  let method = match move Method.parse("GET", 16) {
    Result.Failure {error} => { drop error return 298 }
    Result.Success {value} => value
  }
  let context = match move ResponseContext.make(head, method, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { drop error return 299 }
    Result.Success {value} => move value
  }
  return match move CodingPlan.make(move context, Mode.Decode, bodyLimits(), move limits) {
    Result.Success {value} => { drop value return 294 }
    Result.Failure {error} => match move error.reason {
      ContentReason.InvalidLimit {limit, allowed, attempted} => {
        if limit == ContentLimitKind.OwnedBytes
          && allowed == usize.toU64(expected - usize.ONE)
          && attempted == usize.toU64(expected) { return 0 }
        return 295
      }
      _ => 293
    }
  }
}

effect fn reservationAccounting() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut small = contentLimits()
  small.intermediateCapacity = usize.ONE
  let base = run plannedOwned(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n",
    move small,
  )
  let mut identityLimits = contentLimits()
  identityLimits.intermediateCapacity = usize.ONE
  let identity = run plannedOwned(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: identity\\r\\n\\r\\n",
    move identityLimits,
  )
  let mut gzipLimits = contentLimits()
  gzipLimits.intermediateCapacity = usize.ONE
  let gzip = run plannedOwned(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzip\\r\\n\\r\\n",
    move gzipLimits,
  )
  let mut largeGzipLimits = contentLimits()
  largeGzipLimits.intermediateCapacity = 9
  let largeGzip = run plannedOwned(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzip\\r\\n\\r\\n",
    move largeGzipLimits,
  )
  let mut zstdLimits = contentLimits()
  zstdLimits.intermediateCapacity = usize.ONE
  let zstd = run plannedOwned(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: zstd\\r\\n\\r\\n",
    move zstdLimits,
  )
  let mut stackedLimits = contentLimits()
  stackedLimits.intermediateCapacity = usize.ONE
  let stacked = run plannedOwned(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzip, zstd\\r\\n\\r\\n",
    move stackedLimits,
  )
  if base < Layout.of<ContentReader<'static, 'static, 'static, MemoryByteDuplex>>().bytes
      - Layout.of<BodyDecoder>().bytes
    || identity != base
    || gzip <= base
    || largeGzip < gzip
    || zstd <= base { return 291 }
  if gzip - base != 65537 - Layout.of<InflateDecoder>().bytes
    || largeGzip - gzip != 8 { return 292 }
  if zstd - base != 1049601 - Layout.of<Zstd>().bytes
    || stacked != gzip + zstd - base { return 293 }
  return run ownedBoundary(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzip, zstd\\r\\n\\r\\n",
    stacked,
  )
}

effect fn planning() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let valid = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nContent-Encoding: zstd, identity\\r\\nContent-Encoding: X-GZIP, DeFlAtE\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.ValidStack,
    130,
  )
  if valid != 0 { return valid }
  let noBody = run planningCase(
    b"HTTP/1.1 204 No Content\\r\\nContent-Length: 4\\r\\nContent-Encoding: nonsense\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.SemanticNoBody,
    140,
  )
  if noBody != 0 { return noBody }
  let http10NoBody = run planningCase(
    b"HTTP/1.0 204 No Content\\r\\nTransfer-Encoding: chunked\\r\\nContent-Encoding: bad;value\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.SemanticHttp10NoBody,
    280,
  )
  if http10NoBody != 0 { return http10NoBody }
  let cleanNoBody = run planningCase(
    b"HTTP/1.1 304 Not Modified\\r\\nContent-Encoding: bad;value\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.SemanticCleanNoBody,
    290,
  )
  if cleanNoBody != 0 { return cleanNoBody }
  let syntax = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzip,,zstd\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.EmptySyntax,
    150,
  )
  if syntax != 0 { return syntax }
  let parameter = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzip;q=1\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.ParameterSyntax,
    300,
  )
  if parameter != 0 { return parameter }
  let invalidToken = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzi(p\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.InvalidTokenSyntax,
    310,
  )
  if invalidToken != 0 { return invalidToken }
  let unsupported = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: strange\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.Unsupported,
    160,
  )
  if unsupported != 0 { return unsupported }
  let mut shallow = contentLimits()
  shallow.maxDepth = 2
  let depth = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nContent-Encoding: gzip, identity, zstd\\r\\n\\r\\n",
    "GET",
    move shallow,
    PlanningExpectation.Depth,
    170,
  )
  if depth != 0 { return depth }
  let partial = run planningCase(
    b"HTTP/1.1 206 Partial Content\\r\\nContent-Length: 1\\r\\nContent-Encoding: gzip\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.Partial,
    180,
  )
  if partial != 0 { return partial }
  let tunnel = run planningCase(
    b"HTTP/1.1 200 OK\\r\\n\\r\\n",
    "CONNECT",
    contentLimits(),
    PlanningExpectation.Tunnel,
    190,
  )
  if tunnel != 0 { return tunnel }
  let mut invalidDepth = contentLimits()
  invalidDepth.maxDepth = usize.ZERO
  let depthLimit = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n",
    "GET",
    move invalidDepth,
    PlanningExpectation.InvalidDepth,
    200,
  )
  if depthLimit != 0 { return depthLimit }
  let mut excessDepth = contentLimits()
  excessDepth.maxDepth = 5
  let excessDepthLimit = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n",
    "GET",
    move excessDepth,
    PlanningExpectation.ExcessDepthLimit,
    201,
  )
  if excessDepthLimit != 0 { return excessDepthLimit }
  let codingDepth = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nContent-Encoding: gzip, identity, deflate, zstd, identity\\r\\n\\r\\n",
    "GET",
    contentLimits(),
    PlanningExpectation.ExcessCodingDepth,
    202,
  )
  if codingDepth != 0 { return codingDepth }
  let mut invalidCapacity = contentLimits()
  invalidCapacity.intermediateCapacity = usize.ZERO
  let capacity = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n",
    "GET",
    move invalidCapacity,
    PlanningExpectation.InvalidCapacity,
    210,
  )
  if capacity != 0 { return capacity }
  let mut excessCapacity = contentLimits()
  excessCapacity.intermediateCapacity = 65537
  let capacityLimit = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n",
    "GET",
    move excessCapacity,
    PlanningExpectation.ExcessCapacity,
    211,
  )
  if capacityLimit != 0 { return capacityLimit }
  let mut inflateMemory = contentLimits()
  inflateMemory.inflate.maxMemoryBytes = 65535
  let memory = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nContent-Encoding: gzip\\r\\n\\r\\n",
    "GET",
    move inflateMemory,
    PlanningExpectation.InflateMemory,
    220,
  )
  if memory != 0 { return memory }
  let mut inflateMembers = contentLimits()
  inflateMembers.inflate.maxMembers = u64.MIN
  let members = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nContent-Encoding: gzip\\r\\n\\r\\n",
    "GET",
    move inflateMembers,
    PlanningExpectation.InflateMembers,
    230,
  )
  if members != 0 { return members }
  let mut zstdWorkspace = contentLimits()
  zstdWorkspace.zstd.workspaceBytes = usize.ZERO
  let workspace = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nContent-Encoding: zstd\\r\\n\\r\\n",
    "GET",
    move zstdWorkspace,
    PlanningExpectation.ZstdWorkspace,
    240,
  )
  if workspace != 0 { return workspace }
  let mut zstdWindow = contentLimits()
  zstdWindow.zstd.windowBytes = usize.ZERO
  let window = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nContent-Encoding: zstd\\r\\n\\r\\n",
    "GET",
    move zstdWindow,
    PlanningExpectation.ZstdWindow,
    250,
  )
  if window != 0 { return window }
  let mut ownedLimits = contentLimits()
  ownedLimits.maxOwned = usize.ZERO
  let owned = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nContent-Encoding: gzip\\r\\n\\r\\n",
    "GET",
    move ownedLimits,
    PlanningExpectation.Owned,
    260,
  )
  if owned != 0 { return owned }
  let reservation = run reservationAccounting()
  if reservation != 0 { return reservation }
  let mut overflowing = contentLimits()
  overflowing.maxOwned = usize.MAX
  overflowing.zstd.windowBytes = usize.MAX - 1048576
  let overflow = run planningCase(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 1\\r\\nContent-Encoding: zstd\\r\\n\\r\\n",
    "GET",
    move overflowing,
    PlanningExpectation.Arithmetic,
    270,
  )
  return overflow
}`

/** One corpus source keeps planning on the native path and portable decoding on both targets. */
export const httpContentAcceptanceSource = `${httpContentRuntimeSource}
${httpContentPlanningDeclarations}`
