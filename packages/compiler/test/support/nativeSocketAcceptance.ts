export const nativeSocketAcceptanceSource = `
import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ByteDuplex, ByteIoError, ByteIoOperation, ReadTransfer}
import silk.effect {Effect}
import silk.execution { Execution, Wake }
import silk.fiber {Fiber}
import silk.i64
import silk.local_scheduler {LocalScheduler, StalledError}
import silk.monotonic_clock {MonotonicClock}
import silk.native_socket {AttemptFailure, ConnectOptions, ConnectOptionsError, ConnectOptionsReason, Connection, ConnectionPhase, InvalidEndpointReason, NativeSocketError, NativeSocketOperation, connectResolved, connectResolvedOwned, connectUnix, connectUnixOwned}
import silk.network_address {Endpoint, IpAddress, Ipv4Address, Port}
import silk.option {Option}
import silk.result {Result}
import silk.scheduler {Scheduler, TaskIdExhaustedError}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.usize

unsafe extern "C" fn silk_socket_stub_reset(mode: i32) -> ()
unsafe extern "C" fn silk_socket_stub_sockets() -> i32
unsafe extern "C" fn silk_socket_stub_connects() -> i32
unsafe extern "C" fn silk_socket_stub_closes() -> i32
unsafe extern "C" fn silk_socket_stub_polls() -> i32
unsafe extern "C" fn silk_socket_stub_recvs() -> i32
unsafe extern "C" fn silk_socket_stub_sends() -> i32
unsafe extern "C" fn silk_socket_stub_fcntls() -> i32
unsafe extern "C" fn silk_socket_stub_setsockopts() -> i32
unsafe extern "C" fn silk_socket_stub_getsockopts() -> i32
unsafe extern "C" fn silk_socket_stub_close_attempts() -> i32
unsafe extern "C" fn silk_socket_stub_shutdowns() -> i32
unsafe extern "C" fn silk_socket_stub_callbacks() -> i32
unsafe extern "C" fn silk_socket_stub_callback_event() -> i32
unsafe extern "C" fn silk_socket_stub_close_event() -> i32
unsafe extern "C" fn silk_socket_stub_first_close_event() -> i32
unsafe extern "C" fn silk_socket_stub_second_socket_event() -> i32
unsafe extern "C" fn silk_socket_stub_guard_drops() -> i32
unsafe extern "C" fn silk_socket_stub_guard_drop_event() -> i32
unsafe extern "C" fn silk_socket_stub_wait_registrations() -> i32
unsafe extern "C" fn silk_socket_stub_wait_registration_event() -> i32
unsafe extern "C" fn silk_socket_stub_completions() -> i32
unsafe extern "C" fn silk_socket_stub_mark_guard_drop() -> ()
unsafe extern "C" fn silk_socket_stub_mark_wait_registration() -> ()
unsafe extern "C" fn silk_socket_stub_mark_callback() -> ()
unsafe extern "C" fn silk_socket_stub_mark_completion() -> ()
unsafe extern "C" fn silk_socket_stub_nodelay() -> i32
unsafe extern "C" fn silk_socket_stub_configuration_ok() -> i32
unsafe extern "C" fn silk_socket_stub_transfer_ok() -> i32
unsafe extern "C" fn silk_socket_darwin_witness() -> i32
unsafe extern "C" fn silk_socket_gnu_witness() -> i32

struct FixtureClock {
  nowValue: Instant
  waits: usize
}

impl MonotonicClock for FixtureClock {
  effect fn now(self: &mut Self) -> Instant {
    return SystemClock.make(
      SystemClock.seconds(&self.nowValue),
      SystemClock.nanoseconds(&self.nowValue),
    )
  }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () with Intrinsic.nonParking() {
    self.nowValue = move when
    self.waits = self.waits + usize.ONE
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () with Intrinsic.nonParking() { return () }
}

struct SequencedClock {
  calls: usize
  expireAt: usize
  waits: usize
}

impl MonotonicClock for SequencedClock {
  effect fn now(self: &mut Self) -> Instant {
    self.calls = self.calls + usize.ONE
    if self.calls >= self.expireAt { return SystemClock.make(0, 1) }
    return SystemClock.make(0, 0)
  }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () with Intrinsic.nonParking() {
    drop when
    self.waits = self.waits + usize.ONE
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () with Intrinsic.nonParking() {
    drop howLong
    return ()
  }
}

struct CancellationLifetime {active: bool}
impl Drop for CancellationLifetime {
  fn drop(self: &mut CancellationLifetime) -> () {
    if self.active { unsafe { silk_socket_stub_mark_guard_drop() } }
    return ()
  }
}

struct AcquisitionParkGuard {wake: Wake}
impl Drop for AcquisitionParkGuard {
  fn drop(self: &mut AcquisitionParkGuard) -> () {
    unsafe { silk_socket_stub_mark_guard_drop() }
    return ()
  }
}

fn retainAcquisitionWake(wake: Wake) -> AcquisitionParkGuard {
  unsafe { silk_socket_stub_mark_wait_registration() }
  return AcquisitionParkGuard {wake: move wake}
}

struct AcquisitionClock {}
impl MonotonicClock for AcquisitionClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () {
    drop when
    run Execution.park(retainAcquisitionWake)
    unsafe { silk_socket_stub_mark_completion() }
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () {
    drop howLong
    run Execution.park(retainAcquisitionWake)
    unsafe { silk_socket_stub_mark_completion() }
    return ()
  }
}

fn endpoint(last: u8) -> Endpoint {
  return Endpoint.make(
    IpAddress.V4 {value: Ipv4Address.fromOctets([192, 0, 2, last])},
    Port.fromU16(443),
  )
}

effect fn exerciseConnection(connection: &mut Connection) -> i32
! ByteIoError
? &mut MonotonicClock {
  if Connection.phase(&connection.*) != ConnectionPhase.Open { return 1 }
  let mut output: [u8; 4] = [0, 0, 0, 0]
  let first = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  match move first {
    ReadTransfer.Data {count} => {
      if count != 2 || output[0] != 104 || output[1] != 105 { return 2 }
    }
    ReadTransfer.End => { return 3 }
  }
  let second = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  match move second {
    ReadTransfer.Data {count} => { return 4 }
    ReadTransfer.End => {}
  }
  let third = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  match move third {
    ReadTransfer.Data {count} => { return 5 }
    ReadTransfer.End => {}
  }
  let written = run ByteDuplex.writeSome(b"hello", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  if written != 2 { return 6 }
  run ByteDuplex.flush(Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  run ByteDuplex.shutdownWrite(Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  run ByteDuplex.shutdownWrite(Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  if Connection.phase(&connection.*) != ConnectionPhase.WriteClosed { return 7 }
  let afterShutdown = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  match move afterShutdown {
    ReadTransfer.Data {count} => { return 8 }
    ReadTransfer.End => {}
  }
  let laterWrite = run Effect.result(
    ByteDuplex.writeSome(b"later", Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  )
  match move laterWrite {
    Result<usize, ByteIoError>.Success {value} => { return 9 }
    Result<usize, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Closed {operation} => {
        if operation != ByteIoOperation.Write { return 10 }
      }
      _ => { return 11 }
    }
  }
  return 42
}

effect fn runResolved(mode: i32, two: bool, expectedWaits: usize) -> i32
! NativeSocketError | ByteIoError {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {
    nowValue: SystemClock.make(0, 0),
    waits: usize.ZERO,
  }
  let first = endpoint(1)
  let second = endpoint(2)
  let mut result = 0
  if two {
    let endpoints = [first, second]
    result = run connectResolved(
      &endpoints,
      ConnectOptions.defaults(),
      Option.none<Instant>(),
      exerciseConnection,
    ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  } else {
    let endpoints = [first]
    result = run connectResolved(
      &endpoints,
      ConnectOptions.defaults(),
      Option.none<Instant>(),
      exerciseConnection,
    ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  }
  if result != 42 { return result }
  if clock.waits != expectedWaits { return 20 }
  if unsafe silk_socket_stub_configuration_ok() != 1 { return 21 }
  if unsafe silk_socket_stub_transfer_ok() != 1 { return 22 }
  if unsafe silk_socket_stub_shutdowns() != 1 { return 23 }
  if unsafe silk_socket_stub_closes() != unsafe silk_socket_stub_sockets() { return 24 }
  return 42
}

effect fn runUnixRetry() -> i32 ! NativeSocketError | ByteIoError {
  unsafe { silk_socket_stub_reset(3) }
  let mut clock = FixtureClock {
    nowValue: SystemClock.make(0, 0),
    waits: usize.ZERO,
  }
  let result = run connectUnix(
    b"/tmp/silk-jul-146.sock",
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    exerciseConnection,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if result != 42 { return result }
  if clock.waits != usize.ONE { return 30 }
  if unsafe silk_socket_stub_sockets() != 2 || unsafe silk_socket_stub_connects() != 2 { return 31 }
  if unsafe silk_socket_stub_closes() != 2 { return 32 }
  return 42
}

effect fn noTransfer(connection: &mut Connection) -> i32 { return 42 }

effect fn markedSuccess(connection: &mut Connection) -> i32 {
  unsafe { silk_socket_stub_mark_callback() }
  return 42
}

effect fn markedFailure(connection: &mut Connection) -> i32 ! ByteIoError {
  unsafe { silk_socket_stub_mark_callback() }
  fail ByteDuplex.provider(ByteIoOperation.Flush, 777)
}

effect fn explicitClose(connection: &mut Connection) -> i32 {
  unsafe { silk_socket_stub_mark_callback() }
  let attempted = run Effect.result(Connection.close(move connection))
  return match move attempted {
    Result<(), NativeSocketError>.Success {value} => 1
    Result<(), NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.NativeFailure {operation, errno} => {
        if operation == NativeSocketOperation.Close && errno == 5 { return 42 }
        return 2
      }
      _ => 3
    }
  }
}

effect fn explicitByteClose(connection: &mut Connection) -> i32 {
  unsafe { silk_socket_stub_mark_callback() }
  let attempted = run Effect.result(
    ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  )
  return match move attempted {
    Result<(), ByteIoError>.Success {value} => 1
    Result<(), ByteIoError>.Failure {error} => match move error {
      ByteIoError.Provider {operation, code} => {
        if operation == ByteIoOperation.Close && code == 5 { return 42 }
        return 2
      }
      _ => 3
    }
  }
}

fn invalidUnixMatches(
  attempted: Result<i32, NativeSocketError>,
  expected: InvalidEndpointReason,
  expectedOffset: usize,
) -> bool {
  return match move attempted {
    Result<i32, NativeSocketError>.Success {value} => false
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidEndpoint {reason, offset, limit} => {
        return reason == expected && offset == expectedOffset
      }
      _ => false
    }
  }
}

effect fn invalidCases() -> i32 {
  match move ConnectOptions.make(false, 0, usize.ONE) {
    Result<ConnectOptions, ConnectOptionsError>.Success {value} => { return 60 }
    Result<ConnectOptions, ConnectOptionsError>.Failure {error} => {
      if error.reason != ConnectOptionsReason.PollInterval || error.value != 0 { return 61 }
    }
  }
  match move ConnectOptions.make(false, 1, 1025) {
    Result<ConnectOptions, ConnectOptionsError>.Success {value} => { return 62 }
    Result<ConnectOptions, ConnectOptionsError>.Failure {error} => {
      if error.reason != ConnectOptionsReason.MaxAttempts || error.value != 1025 { return 63 }
    }
  }
  unsafe { silk_socket_stub_reset(0) }
  let mut clock = FixtureClock {
    nowValue: SystemClock.make(0, 0),
    waits: usize.ZERO,
  }
  let attempted = run Effect.result(connectUnix(
    b"relative.sock",
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move attempted {
    Result<i32, NativeSocketError>.Success {value} => { return 64 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidEndpoint {reason, offset, limit} => {
        if reason != InvalidEndpointReason.RelativePath || offset != usize.ZERO { return 65 }
      }
      _ => { return 66 }
    }
  }
  if unsafe silk_socket_stub_sockets() != 0 || clock.waits != usize.ZERO { return 67 }
  unsafe { silk_socket_stub_reset(0) }
  let empty = run Effect.result(connectUnix(
    b"",
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  if !invalidUnixMatches(move empty, InvalidEndpointReason.EmptyPath, usize.ZERO)
    || unsafe silk_socket_stub_sockets() != 0 { return 68 }
  let nul = run Effect.result(connectUnix(
    b"/tmp/\\x00socket",
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  if !invalidUnixMatches(move nul, InvalidEndpointReason.NulPath, 5)
    || unsafe silk_socket_stub_sockets() != 0 { return 69 }
  let abstract = run Effect.result(connectUnix(
    b"\\x00silk",
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  if !invalidUnixMatches(move abstract, InvalidEndpointReason.AbstractPath, usize.ZERO)
    || unsafe silk_socket_stub_sockets() != 0 { return 70 }
  let oversized = run Effect.result(connectUnix(
    b"/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  if !invalidUnixMatches(move oversized, InvalidEndpointReason.PathTooLong, 108)
    || unsafe silk_socket_stub_sockets() != 0 { return 71 }

  unsafe { silk_socket_stub_reset(0) }
  let emptyEndpoints: [Endpoint; 0] = []
  let emptyAttempt = run Effect.result(connectResolved(
    &emptyEndpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move emptyAttempt {
    Result<i32, NativeSocketError>.Success {value} => { return 72 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidEndpoint {reason, offset, limit} => {
        if reason != InvalidEndpointReason.EmptyEndpoints || unsafe silk_socket_stub_sockets() != 0 {
          return 73
        }
      }
      _ => { return 74 }
    }
  }
  let endpoints = [endpoint(1), endpoint(2)]
  let bounded = match move ConnectOptions.make(false, 1, usize.ONE) {
    Result<ConnectOptions, ConnectOptionsError>.Failure {error} => { return 75 }
    Result<ConnectOptions, ConnectOptionsError>.Success {value} => value
  }
  let tooMany = run Effect.result(connectResolved(
    &endpoints,
    bounded,
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move tooMany {
    Result<i32, NativeSocketError>.Success {value} => { return 76 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidEndpoint {reason, offset, limit} => {
        if reason != InvalidEndpointReason.TooManyEndpoints || offset != 2 || limit != usize.ONE {
          return 77
        }
      }
      _ => { return 78 }
    }
  }
  if unsafe silk_socket_stub_sockets() != 0 { return 79 }
  return 42
}

effect fn runTimed(mode: i32, now: Instant, deadline: Option<Instant>) -> i32 {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {nowValue: move now, waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let attempted = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    move deadline,
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  return match move attempted {
    Result<i32, NativeSocketError>.Success {value} => 50
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.Timeout => {
        if clock.waits != 2 || unsafe silk_socket_stub_polls() != 2 { return 51 }
        return 42
      }
      NativeSocketError.TimeRangeError => {
        if clock.waits != usize.ZERO || unsafe silk_socket_stub_polls() != 1 { return 52 }
        return 42
      }
      _ => 53
    }
  }
}

fn noNativeWork() -> bool {
  return unsafe silk_socket_stub_sockets() == 0
    && unsafe silk_socket_stub_connects() == 0
    && unsafe silk_socket_stub_polls() == 0
    && unsafe silk_socket_stub_fcntls() == 0
    && unsafe silk_socket_stub_setsockopts() == 0
    && unsafe silk_socket_stub_getsockopts() == 0
}

effect fn reachedDeadlineCases() -> i32 {
  unsafe { silk_socket_stub_reset(0) }
  let deadline = SystemClock.make(7, 123)
  let mut clock = FixtureClock {nowValue: SystemClock.make(7, 123), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let resolved = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.some<Instant>(SystemClock.make(7, 123)),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move resolved {
    Result<i32, NativeSocketError>.Success {value} => { return 70 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.Timeout => {}
      _ => { return 71 }
    }
  }
  if !noNativeWork() || clock.waits != usize.ZERO { return 72 }
  if SystemClock.seconds(&clock.nowValue) != 7 || SystemClock.nanoseconds(&clock.nowValue) != 123 {
    return 73
  }

  unsafe { silk_socket_stub_reset(0) }
  let unix = run Effect.result(connectUnix(
    b"/tmp/silk-jul-146.sock",
    ConnectOptions.defaults(),
    Option.some<Instant>(move deadline),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move unix {
    Result<i32, NativeSocketError>.Success {value} => { return 74 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.Timeout => {}
      _ => { return 75 }
    }
  }
  if !noNativeWork() || clock.waits != usize.ZERO { return 76 }
  return 42
}

effect fn attemptPolicyCases() -> i32 {
  unsafe { silk_socket_stub_reset(1) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let exhausted = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move exhausted {
    Result<i32, NativeSocketError>.Success {value} => { return 77 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.AttemptsExhausted {attempted, last} => {
        if attempted != usize.ONE { return 78 }
        match move last {
          AttemptFailure.ConnectionRefused => {}
          _ => { return 79 }
        }
      }
      _ => { return 79 }
    }
  }
  if unsafe silk_socket_stub_sockets() != 1
    || unsafe silk_socket_stub_connects() != 1
    || unsafe silk_socket_stub_closes() != 1
    || unsafe silk_socket_stub_polls() != 0 { return 80 }

  unsafe { silk_socket_stub_reset(7) }
  let terminalEndpoints = [endpoint(1), endpoint(2)]
  let terminal = run Effect.result(connectResolved(
    &terminalEndpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move terminal {
    Result<i32, NativeSocketError>.Success {value} => { return 81 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.PermissionDenied => {}
      _ => { return 82 }
    }
  }
  if unsafe silk_socket_stub_sockets() != 1
    || unsafe silk_socket_stub_connects() != 1
    || unsafe silk_socket_stub_closes() != 1 { return 83 }
  return 42
}

effect fn emptyTransfers(connection: &mut Connection) -> i32 ! ByteIoError
? &mut MonotonicClock {
  unsafe { silk_socket_stub_mark_callback() }
  let mut output: [u8; 0] = []
  let read = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  match move read {
    ReadTransfer.Data {count} => { if count != usize.ZERO { return 1 } }
    ReadTransfer.End => { return 2 }
  }
  let input: [u8; 0] = []
  let written = run ByteDuplex.writeSome(&input, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  if written != usize.ZERO { return 3 }
  if unsafe silk_socket_stub_recvs() != 0 || unsafe silk_socket_stub_sends() != 0 { return 4 }
  return 42
}

effect fn readOne(connection: &mut Connection) -> i32 ! ByteIoError
? &mut MonotonicClock {
  unsafe { silk_socket_stub_mark_callback() }
  let mut output: [u8; 4] = [0, 0, 0, 0]
  let read = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  return match move read {
    ReadTransfer.Data {count} => {
      if count == 2 && output[0] == 104 && output[1] == 105 { return 42 }
      return 1
    }
    ReadTransfer.End => 2
  }
}

effect fn writeOne(connection: &mut Connection) -> i32 ! ByteIoError
? &mut MonotonicClock {
  unsafe { silk_socket_stub_mark_callback() }
  let written = run ByteDuplex.writeSome(b"hello", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  if written != 2 { return 1 }
  return 42
}

effect fn readForError(connection: &mut Connection) -> i32 ! ByteIoError
? &mut MonotonicClock {
  unsafe { silk_socket_stub_mark_callback() }
  let mut output: [u8; 4] = [0, 0, 0, 0]
  let transfer = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  drop move transfer
  return 1
}

effect fn writeForError(connection: &mut Connection) -> i32 ! ByteIoError
? &mut MonotonicClock {
  unsafe { silk_socket_stub_mark_callback() }
  let count = run ByteDuplex.writeSome(b"hello", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  drop count
  return 1
}

effect fn runReadRetry(mode: i32, expectedWaits: usize, expectedRecvs: i32) -> i32
! NativeSocketError | ByteIoError {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let value = run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    readOne,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if value != 42 || clock.waits != expectedWaits { return 1 }
  if unsafe silk_socket_stub_recvs() != expectedRecvs { return 2 }
  if unsafe silk_socket_stub_closes() != 1 { return 3 }
  return 42
}

effect fn runWriteRetry(mode: i32, expectedWaits: usize, expectedSends: i32) -> i32
! NativeSocketError | ByteIoError {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let value = run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    writeOne,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if value != 42 || clock.waits != expectedWaits { return 1 }
  if unsafe silk_socket_stub_sends() != expectedSends { return 2 }
  if unsafe silk_socket_stub_closes() != 1 { return 3 }
  return 42
}

effect fn expectReadError(mode: i32, operation: ByteIoOperation, code: i32, invalid: bool) -> i32 {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let attempted = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    readForError,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move attempted {
    Result<i32, NativeSocketError | ByteIoError>.Success {value} => { return 1 }
    Result<i32, NativeSocketError | ByteIoError>.Failure {error} => match move error {
      ByteIoError.Provider {operation: observed, code: observedCode} => {
        if invalid || observed != operation || observedCode != code { return 2 }
      }
      ByteIoError.InvalidTransferCount {operation: observed, count, limit} => {
        if !invalid || observed != operation || count != 5 || limit != 4 { return 3 }
      }
      _ => { return 4 }
    }
  }
  if unsafe silk_socket_stub_closes() != 1 { return 5 }
  return 42
}

effect fn expectWriteCountError(mode: i32, expectedCount: usize) -> i32 {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let attempted = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    writeForError,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move attempted {
    Result<i32, NativeSocketError | ByteIoError>.Success {value} => { return 1 }
    Result<i32, NativeSocketError | ByteIoError>.Failure {error} => match move error {
      ByteIoError.InvalidTransferCount {operation, count, limit} => {
        if operation != ByteIoOperation.Write || count != expectedCount || limit != 5 { return 2 }
      }
      _ => { return 3 }
    }
  }
  if unsafe silk_socket_stub_closes() != 1 { return 4 }
  return 42
}

effect fn expectWriteProvider(mode: i32, expectedCode: i32) -> i32 {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let attempted = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    writeForError,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move attempted {
    Result<i32, NativeSocketError | ByteIoError>.Success {value} => { return 1 }
    Result<i32, NativeSocketError | ByteIoError>.Failure {error} => match move error {
      ByteIoError.Provider {operation, code} => {
        if operation != ByteIoOperation.Write || code != expectedCode { return 2 }
      }
      _ => { return 3 }
    }
  }
  if unsafe silk_socket_stub_closes() != 1 { return 4 }
  return 42
}

effect fn ioCases() -> i32 ! NativeSocketError | ByteIoError {
  let readEintr = run runReadRetry(30, usize.ONE, 2)
  if readEintr != 42 { return 100 }
  let readAgain = run runReadRetry(31, usize.ZERO, 2)
  if readAgain != 42 || unsafe silk_socket_stub_polls() != 1 { return 101 }
  let readReadyAgain = run runReadRetry(32, usize.ONE, 3)
  if readReadyAgain != 42 || unsafe silk_socket_stub_polls() != 1 { return 102 }
  let writeEintr = run runWriteRetry(33, usize.ONE, 2)
  if writeEintr != 42 { return 103 }
  let writeAgain = run runWriteRetry(34, usize.ZERO, 2)
  if writeAgain != 42 || unsafe silk_socket_stub_polls() != 1 { return 104 }
  let writeReadyAgain = run runWriteRetry(35, usize.ONE, 3)
  if writeReadyAgain != 42 || unsafe silk_socket_stub_polls() != 1 { return 105 }
  let hupPending = run runReadRetry(36, usize.ZERO, 2)
  if hupPending != 42 || unsafe silk_socket_stub_polls() != 1 { return 106 }
  let socketError = run expectReadError(37, ByteIoOperation.Read, 104, false)
  static if Intrinsic.targetOperatingSystem() == "darwin" {
    let darwinError = run expectReadError(37, ByteIoOperation.Read, 54, false)
    if darwinError != 42 { return 107 }
  } else {
    if socketError != 42 { return 107 }
  }
  let invalidPoll = run expectReadError(38, ByteIoOperation.Read, 9, false)
  if invalidPoll != 42 { return 108 }
  let readCount = run expectReadError(39, ByteIoOperation.Read, 0, true)
  if readCount != 42 { return 109 }
  let zeroWrite = run expectWriteCountError(40, usize.ZERO)
  if zeroWrite != 42 { return 110 }
  let longWrite = run expectWriteCountError(41, 6)
  if longWrite != 42 { return 111 }
  let writeProvider = run expectWriteProvider(45, 32)
  if writeProvider != 42 { return 112 }
  return 42
}

effect fn lifecycleCases() -> i32 ! NativeSocketError | ByteIoError {
  let endpoints = [endpoint(1)]
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}

  unsafe { silk_socket_stub_reset(43) }
  let setup = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    markedSuccess,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move setup {
    Result<i32, NativeSocketError>.Success {value} => { return 120 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.NativeFailure {operation, errno} => {
        if operation != NativeSocketOperation.Configure || errno != 5 { return 121 }
      }
      _ => { return 122 }
    }
  }
  if unsafe silk_socket_stub_sockets() != 1
    || unsafe silk_socket_stub_connects() != 0
    || unsafe silk_socket_stub_callbacks() != 0
    || unsafe silk_socket_stub_closes() != 1 { return 123 }

  unsafe { silk_socket_stub_reset(0) }
  let success = run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    markedSuccess,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if success != 42 || unsafe silk_socket_stub_callbacks() != 1 { return 124 }
  if unsafe silk_socket_stub_callback_event() <= 0
    || unsafe silk_socket_stub_close_event() <= unsafe silk_socket_stub_callback_event() { return 125 }

  unsafe { silk_socket_stub_reset(42) }
  let protected = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    markedFailure,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move protected {
    Result<i32, NativeSocketError | ByteIoError>.Success {value} => { return 126 }
    Result<i32, NativeSocketError | ByteIoError>.Failure {error} => match move error {
      ByteIoError.Provider {operation, code} => {
        if operation != ByteIoOperation.Flush || code != 777 { return 127 }
      }
      _ => { return 128 }
    }
  }
  if unsafe silk_socket_stub_close_attempts() != 1
    || unsafe silk_socket_stub_close_event() <= unsafe silk_socket_stub_callback_event() { return 129 }

  unsafe { silk_socket_stub_reset(42) }
  let explicit = run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    explicitClose,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if explicit != 42 || unsafe silk_socket_stub_close_attempts() != 1 { return 130 }

  unsafe { silk_socket_stub_reset(42) }
  let byteClose = run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    explicitByteClose,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if byteClose != 42 || unsafe silk_socket_stub_close_attempts() != 1 { return 134 }

  unsafe { silk_socket_stub_reset(44) }
  let noDelay = match move ConnectOptions.make(true, 1, usize.ONE) {
    Result<ConnectOptions, ConnectOptionsError>.Failure {error} => { return 131 }
    Result<ConnectOptions, ConnectOptionsError>.Success {value} => value
  }
  let configured = run connectResolved(
    &endpoints,
    noDelay,
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if configured != 42 || unsafe silk_socket_stub_nodelay() != 1 { return 132 }

  unsafe { silk_socket_stub_reset(0) }
  let empty = run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    emptyTransfers,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if empty != 42 { return 133 }
  return 42
}

effect fn timedRead(connection: &mut Connection) -> i32 ! ByteIoError
? &mut MonotonicClock {
  let mut output: [u8; 1] = [0]
  let attempted = run Effect.result(
    ByteDuplex.readSome(&mut output, Option.some<Instant>(SystemClock.make(0, 1)))
      |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  )
  return match move attempted {
    Result<ReadTransfer, ByteIoError>.Success {value} => 1
    Result<ReadTransfer, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Timeout {operation} => {
        if operation == ByteIoOperation.Read { return 42 }
        return 2
      }
      _ => 3
    }
  }
}

effect fn timedShutdown(connection: &mut Connection) -> i32 ! ByteIoError
? &mut MonotonicClock {
  let attempted = run Effect.result(
    ByteDuplex.shutdownWrite(Option.some<Instant>(SystemClock.make(0, 1)))
      |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  )
  return match move attempted {
    Result<(), ByteIoError>.Success {value} => 1
    Result<(), ByteIoError>.Failure {error} => match move error {
      ByteIoError.Timeout {operation} => {
        if operation == ByteIoOperation.ShutdownWrite { return 42 }
        return 2
      }
      _ => 3
    }
  }
}

effect fn runSequencedNoTransfer(mode: i32, expireAt: usize) -> i32 ! NativeSocketError {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = SequencedClock {calls: usize.ZERO, expireAt: expireAt, waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  return run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.some<Instant>(SystemClock.make(0, 1)),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
}

effect fn runSequencedRead(mode: i32, expireAt: usize) -> i32
! NativeSocketError | ByteIoError {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = SequencedClock {calls: usize.ZERO, expireAt: expireAt, waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  return run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.some<Instant>(SystemClock.make(0, 1)),
    timedRead,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
}

effect fn runSequencedShutdown(mode: i32, expireAt: usize) -> i32
! NativeSocketError | ByteIoError {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = SequencedClock {calls: usize.ZERO, expireAt: expireAt, waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  return run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.some<Instant>(SystemClock.make(0, 1)),
    timedShutdown,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
}

effect fn deadlineBoundaryCases() -> i32 ! NativeSocketError | ByteIoError {
  unsafe { silk_socket_stub_reset(0) }
  let mut beforeConfigure = SequencedClock {calls: usize.ZERO, expireAt: 3, waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let first = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.some<Instant>(SystemClock.make(0, 1)),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut beforeConfigure))
  match move first {
    Result<i32, NativeSocketError>.Success {value} => { return 140 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.Timeout => {}
      _ => { return 141 }
    }
  }
  if unsafe silk_socket_stub_sockets() != 1
    || unsafe silk_socket_stub_fcntls() != 0
    || unsafe silk_socket_stub_setsockopts() != 0
    || unsafe silk_socket_stub_connects() != 0
    || unsafe silk_socket_stub_closes() != 1 { return 142 }

  let noDelay = match move ConnectOptions.make(true, 1, usize.ONE) {
    Result<ConnectOptions, ConnectOptionsError>.Failure {error} => { return 152 }
    Result<ConnectOptions, ConnectOptionsError>.Success {value} => value
  }
  unsafe { silk_socket_stub_reset(0) }
  let mut betweenConfigure = SequencedClock {calls: usize.ZERO, expireAt: 4, waits: usize.ZERO}
  let configured = run Effect.result(connectResolved(
    &endpoints,
    move noDelay,
    Option.some<Instant>(SystemClock.make(0, 1)),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut betweenConfigure))
  match move configured {
    Result<i32, NativeSocketError>.Success {value} => { return 153 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.Timeout => {}
      _ => { return 154 }
    }
  }
  static if Intrinsic.targetOperatingSystem() == "darwin" {
    if unsafe silk_socket_stub_fcntls() != 1
      || unsafe silk_socket_stub_setsockopts() != 0 { return 155 }
  } else {
    if unsafe silk_socket_stub_fcntls() != 0
      || unsafe silk_socket_stub_setsockopts() != 1 { return 155 }
  }
  if unsafe silk_socket_stub_connects() != 0
    || unsafe silk_socket_stub_closes() != 1 { return 156 }

  let mut pollExpiry: usize = 5
  static if Intrinsic.targetOperatingSystem() == "darwin" { pollExpiry = 10 }
  let beforePoll = run Effect.result(runSequencedNoTransfer(2, pollExpiry))
  match move beforePoll {
    Result<i32, NativeSocketError>.Success {value} => { return 143 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.Timeout => {}
      _ => { return 144 }
    }
  }
  if unsafe silk_socket_stub_connects() != 1
    || unsafe silk_socket_stub_polls() != 0
    || unsafe silk_socket_stub_getsockopts() != 0 { return 145 }

  let mut optionExpiry: usize = 6
  static if Intrinsic.targetOperatingSystem() == "darwin" { optionExpiry = 11 }
  let beforeOption = run Effect.result(runSequencedNoTransfer(2, optionExpiry))
  match move beforeOption {
    Result<i32, NativeSocketError>.Success {value} => { return 146 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.Timeout => {}
      _ => { return 147 }
    }
  }
  if unsafe silk_socket_stub_polls() != 1
    || unsafe silk_socket_stub_getsockopts() != 0 { return 148 }

  let mut readPollExpiry: usize = 6
  static if Intrinsic.targetOperatingSystem() == "darwin" { readPollExpiry = 11 }
  let readPoll = run runSequencedRead(31, readPollExpiry)
  if readPoll != 42 || unsafe silk_socket_stub_recvs() != 1
    || unsafe silk_socket_stub_polls() != 0 { return 149 }

  let mut readOptionExpiry: usize = 7
  static if Intrinsic.targetOperatingSystem() == "darwin" { readOptionExpiry = 12 }
  let readOption = run runSequencedRead(37, readOptionExpiry)
  if readOption != 42 || unsafe silk_socket_stub_polls() != 1
    || unsafe silk_socket_stub_getsockopts() != 0 { return 150 }

  let mut shutdownExpiry: usize = 5
  static if Intrinsic.targetOperatingSystem() == "darwin" { shutdownExpiry = 10 }
  let shutdown = run runSequencedShutdown(0, shutdownExpiry)
  if shutdown != 42 || unsafe silk_socket_stub_shutdowns() != 0 { return 151 }
  return 42
}

effect fn shutdownOnce(connection: &mut Connection) -> i32 ! ByteIoError
? &mut MonotonicClock {
  run ByteDuplex.shutdownWrite(Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  return 42
}

effect fn expectShutdown(mode: i32, expectedWaits: usize, expectedCalls: i32, expected: i32) -> i32 {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let attempted = run Effect.result(connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    shutdownOnce,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move attempted {
    Result<i32, NativeSocketError | ByteIoError>.Success {value} => {
      if expected != 0 || value != 42 { return 1 }
    }
    Result<i32, NativeSocketError | ByteIoError>.Failure {error} => match move error {
      ByteIoError.Closed {operation} => {
        if expected != 1 || operation != ByteIoOperation.ShutdownWrite { return 2 }
      }
      ByteIoError.Provider {operation, code} => {
        if expected != 2 || operation != ByteIoOperation.ShutdownWrite || code != 5 { return 3 }
      }
      _ => { return 4 }
    }
  }
  if clock.waits != expectedWaits || unsafe silk_socket_stub_shutdowns() != expectedCalls
    || unsafe silk_socket_stub_closes() != 1 { return 5 }
  return 42
}

effect fn afterExplicitClose(connection: &mut Connection) -> i32
! NativeSocketError | ByteIoError
? &mut MonotonicClock {
  run ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  let mut output: [u8; 1] = [0]
  let read = run Effect.result(
    ByteDuplex.readSome(&mut output, Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  )
  match move read {
    Result<ReadTransfer, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Closed {operation} => { if operation != ByteIoOperation.Read { return 1 } }
      _ => { return 2 }
    }
    _ => { return 3 }
  }
  let write = run Effect.result(
    ByteDuplex.writeSome(b"hello", Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  )
  match move write {
    Result<usize, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Closed {operation} => { if operation != ByteIoOperation.Write { return 4 } }
      _ => { return 5 }
    }
    _ => { return 6 }
  }
  let flush = run Effect.result(
    ByteDuplex.flush(Option.none<Instant>()) |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  )
  match move flush {
    Result<(), ByteIoError>.Failure {error} => match move error {
      ByteIoError.Closed {operation} => { if operation != ByteIoOperation.Flush { return 7 } }
      _ => { return 8 }
    }
    _ => { return 9 }
  }
  let shutdown = run Effect.result(
    ByteDuplex.shutdownWrite(Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  )
  match move shutdown {
    Result<(), ByteIoError>.Failure {error} => match move error {
      ByteIoError.Closed {operation} => { if operation != ByteIoOperation.Flush { return 10 } }
      _ => { return 11 }
    }
    _ => { return 12 }
  }
  run ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  return 42
}

effect fn expectSetupFailure(
  mode: i32,
  options: ConnectOptions,
  operation: NativeSocketOperation,
  expectedFcntls: i32,
  expectedOptions: i32,
  expectedCloses: i32,
) -> i32 {
  unsafe { silk_socket_stub_reset(mode) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let attempted = run Effect.result(connectResolved(
    &endpoints,
    move options,
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move attempted {
    Result<i32, NativeSocketError>.Success {value} => { return 1 }
    Result<i32, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.NativeFailure {operation: observed, errno} => {
        if observed != operation || errno != 5 { return 2 }
      }
      _ => { return 3 }
    }
  }
  if unsafe silk_socket_stub_fcntls() != expectedFcntls
    || unsafe silk_socket_stub_setsockopts() != expectedOptions
    || unsafe silk_socket_stub_connects() != 0
    || unsafe silk_socket_stub_callbacks() != 0
    || unsafe silk_socket_stub_close_attempts() != expectedCloses { return 4 }
  return 42
}

effect fn lifecycleEdgeCases() -> i32 ! NativeSocketError | ByteIoError {
  let pollEintr = run runReadRetry(46, usize.ONE, 2)
  if pollEintr != 42 { return 160 }
  let pollFailure = run expectReadError(47, ByteIoOperation.Read, 5, false)
  if pollFailure != 42 { return 161 }
  let socketOptionFailure = run expectReadError(48, ByteIoOperation.Read, 5, false)
  if socketOptionFailure != 42 { return 162 }
  let writeHup = run expectWriteProvider(50, 32)
  if writeHup != 42 { return 163 }
  let interrupted = run expectShutdown(51, usize.ONE, 2, 0)
  if interrupted != 42 { return 164 }
  let notConnected = run expectShutdown(52, usize.ZERO, 1, 1)
  if notConnected != 42 { return 165 }
  let provider = run expectShutdown(53, usize.ZERO, 1, 2)
  if provider != 42 { return 166 }

  unsafe { silk_socket_stub_reset(0) }
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let endpoints = [endpoint(1)]
  let closed = run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    afterExplicitClose,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if closed != 42 { return closed }
  if unsafe silk_socket_stub_close_attempts() != 1 { return 179 }
  if unsafe silk_socket_stub_recvs() != 0 { return 180 }
  if unsafe silk_socket_stub_sends() != 0 { return 181 }
  if unsafe silk_socket_stub_shutdowns() != 0 { return 182 }

  unsafe { silk_socket_stub_reset(1) }
  let orderedEndpoints = [endpoint(1), endpoint(2)]
  let ordered = run connectResolved(
    &orderedEndpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    noTransfer,
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if ordered != 42 || unsafe silk_socket_stub_first_close_event() <= 0
    || unsafe silk_socket_stub_second_socket_event() <= unsafe silk_socket_stub_first_close_event() {
    return 168
  }

  let socketFailure = run expectSetupFailure(
    54,
    ConnectOptions.defaults(),
    NativeSocketOperation.Socket,
    0,
    0,
    0,
  )
  if socketFailure != 42 { return 169 }
  static if Intrinsic.targetOperatingSystem() == "darwin" {
    let fcntl1 = run expectSetupFailure(55, ConnectOptions.defaults(), NativeSocketOperation.Configure, 1, 0, 1)
    if fcntl1 != 42 { return 171 }
    let fcntl2 = run expectSetupFailure(56, ConnectOptions.defaults(), NativeSocketOperation.Configure, 2, 0, 1)
    if fcntl2 != 42 { return 172 }
    let fcntl3 = run expectSetupFailure(57, ConnectOptions.defaults(), NativeSocketOperation.Configure, 3, 0, 1)
    if fcntl3 != 42 { return 173 }
    let fcntl4 = run expectSetupFailure(58, ConnectOptions.defaults(), NativeSocketOperation.Configure, 4, 0, 1)
    if fcntl4 != 42 { return 174 }
  }
  let mut platformFcntls = 0
  static if Intrinsic.targetOperatingSystem() == "darwin" { platformFcntls = 4 }
  static if Intrinsic.targetOperatingSystem() == "darwin" {
    let noSigpipe = run expectSetupFailure(
      60,
      ConnectOptions.defaults(),
      NativeSocketOperation.Configure,
      4,
      2,
      1,
    )
    if noSigpipe != 42 { return 176 }
  }
  let noDelay = match move ConnectOptions.make(true, 1, usize.ONE) {
    Result<ConnectOptions, ConnectOptionsError>.Failure {error} => { return 177 }
    Result<ConnectOptions, ConnectOptionsError>.Success {value} => value
  }
  let mut optionCount = 2
  static if Intrinsic.targetOperatingSystem() == "darwin" { optionCount = 3 }
  let noDelayFailure = run expectSetupFailure(
    61,
    move noDelay,
    NativeSocketOperation.Configure,
    platformFcntls,
    optionCount,
    1,
  )
  if noDelayFailure != 42 { return 178 }
  return 42
}

effect fn closeMovedNativeOwner(connection: Connection) -> i32 ! NativeSocketError {
  let mut retained = move connection
  if Connection.phase(&retained) != ConnectionPhase.Open { return 260 }
  if unsafe silk_socket_stub_close_attempts() != 0 { return 261 }
  run Connection.close(&mut retained)
  if Connection.phase(&retained) != ConnectionPhase.Closed { return 262 }
  let sockets = unsafe silk_socket_stub_sockets()
  let connects = unsafe silk_socket_stub_connects()
  let polls = unsafe silk_socket_stub_polls()
  let setsockopts = unsafe silk_socket_stub_setsockopts()
  run Connection.close(&mut retained)
  if unsafe silk_socket_stub_close_attempts() != 1
    || unsafe silk_socket_stub_sockets() != sockets
    || unsafe silk_socket_stub_connects() != connects
    || unsafe silk_socket_stub_polls() != polls
    || unsafe silk_socket_stub_setsockopts() != setsockopts { return 263 }
  return 42
}

effect fn ownedAcquisitionCases() -> i32 ! NativeSocketError {
  let endpoints = [endpoint(1)]
  let mut clock = FixtureClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}

  unsafe { silk_socket_stub_reset(0) }
  let resolved = run connectResolvedOwned(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  if unsafe silk_socket_stub_closes() != 0
    || unsafe silk_socket_stub_sockets() != 1
    || unsafe silk_socket_stub_connects() != 1 { return 264 }
  let resolvedClosed = run closeMovedNativeOwner(move resolved)
  if resolvedClosed != 42 { return resolvedClosed }

  static if Intrinsic.targetOperatingSystem() == "linux" {
    unsafe { silk_socket_stub_reset(0) }
    let unix = run connectUnixOwned(
      b"/tmp/silk-jul-146.sock",
      ConnectOptions.defaults(),
      Option.none<Instant>(),
    ) |> Effect.provideMut<MonotonicClock>(&mut clock)
    if unsafe silk_socket_stub_closes() != 0
      || unsafe silk_socket_stub_sockets() != 1
      || unsafe silk_socket_stub_connects() != 1 { return 265 }
    let unixClosed = run closeMovedNativeOwner(move unix)
    if unixClosed != 42 { return unixClosed }
  }

  unsafe { silk_socket_stub_reset(43) }
  let rejected = run Effect.result(connectResolvedOwned(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
  ) |> Effect.provideMut<MonotonicClock>(&mut clock))
  match move rejected {
    Result<Connection, NativeSocketError>.Success {value} => { return 266 }
    Result<Connection, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.NativeFailure {operation, errno} => {
        if operation != NativeSocketOperation.Configure || errno != 5 { return 267 }
      }
      _ => { return 268 }
    }
  }
  if unsafe silk_socket_stub_sockets() != 1
    || unsafe silk_socket_stub_connects() != 0
    || unsafe silk_socket_stub_closes() != 1
    || unsafe silk_socket_stub_close_attempts() != 1
    || unsafe silk_socket_stub_polls() != 0
    || unsafe silk_socket_stub_recvs() != 0
    || unsafe silk_socket_stub_sends() != 0
    || unsafe silk_socket_stub_shutdowns() != 0 { return 269 }
  return 42
}

effect fn parkedOwnedAcquisition() -> i32 ! NativeSocketError {
  let endpoints = [endpoint(1)]
  let mut clock = AcquisitionClock {}
  let connection = run connectResolvedOwned(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
  ) |> Effect.provideMut<MonotonicClock>(&mut clock)
  unsafe { silk_socket_stub_mark_callback() }
  drop connection
  unsafe { silk_socket_stub_mark_completion() }
  return 1
}

effect fn ownedAcquisitionFailed(error: NativeSocketError) -> i32 {
  drop error
  return -1
}

fn ownedAcquisitionReady(state: &()) -> () { return () }
fn ownedAcquisitionComplete(state: &mut i32, value: i32) -> () {
  state.* = value
  return ()
}
fn ownedAcquisitionParked(state: &mut i32, execution: Intrinsic.Execution<i32>) -> () {
  drop move execution
  state.* = 42
  return ()
}

effect fn ownedAcquisitionCancellation() -> i32 ! OutOfMemoryError {
  unsafe { silk_socket_stub_reset(4) }
  let mut allocator = Allocator.systemAllocatorProvider()
  let body = Effect.catchAll(parkedOwnedAcquisition(), ownedAcquisitionFailed)
  let execution = run Execution.make(move body, (), ownedAcquisitionReady)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut result = 0
  run Execution.drive(
    move execution,
    &mut result,
    ownedAcquisitionComplete,
    ownedAcquisitionParked,
  )
  if result != 42 { return 270 }
  if unsafe silk_socket_stub_wait_registrations() != 1
    || unsafe silk_socket_stub_guard_drops() != 1 { return 271 }
  if unsafe silk_socket_stub_sockets() != 1
    || unsafe silk_socket_stub_connects() != 1
    || unsafe silk_socket_stub_polls() != 1
    || unsafe silk_socket_stub_closes() != 1
    || unsafe silk_socket_stub_close_attempts() != 1 { return 272 }
  if unsafe silk_socket_stub_callback_event() != 0
    || unsafe silk_socket_stub_completions() != 0 { return 273 }
  if unsafe silk_socket_stub_wait_registration_event() <= 0
    || unsafe silk_socket_stub_guard_drop_event()
      <= unsafe silk_socket_stub_wait_registration_event()
    || unsafe silk_socket_stub_first_close_event()
      <= unsafe silk_socket_stub_guard_drop_event() { return 274 }
  return 42
}

effect fn cancellationRead(connection: &mut Connection) -> i32
! ByteIoError
? &mut MonotonicClock {
  unsafe { silk_socket_stub_mark_callback() }
  let lifetime = CancellationLifetime {active: true}
  let mut output: [u8; 2] = [0, 0]
  let transfer = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  unsafe { silk_socket_stub_mark_completion() }
  drop transfer
  drop lifetime
  return 1
}

effect fn suspendedConnection() -> i32
! NativeSocketError | ByteIoError
? &mut MonotonicClock {
  let endpoints = [endpoint(1)]
  return run connectResolved(
    &endpoints,
    ConnectOptions.defaults(),
    Option.none<Instant>(),
    cancellationRead,
  )
}

effect fn cancellationRoot() -> i32
! OutOfMemoryError | TaskIdExhaustedError
? &mut Scheduler | &mut MonotonicClock {
  let child = run Fiber.forkChild<
    i32,
    NativeSocketError | ByteIoError,
  >(suspendedConnection())
  drop child
  run Fiber.yieldNow()
  run Fiber.yieldNow()
  if unsafe silk_socket_stub_sockets() != 1 { return 2 }
  if unsafe silk_socket_stub_connects() != 1 { return 3 }
  if unsafe silk_socket_stub_callbacks() != 1 { return 4 }
  if unsafe silk_socket_stub_recvs() != 1 { return 5 }
  if unsafe silk_socket_stub_polls() != 1 { return 6 }
  unsafe { silk_socket_stub_mark_wait_registration() }
  return 42
}

effect fn cancellationFailed(
  error: OutOfMemoryError | TaskIdExhaustedError | StalledError,
) -> i32 {
  return match move error {
    OutOfMemoryError {} => 21
    TaskIdExhaustedError {} => 22
    StalledError {} => 23
  }
}

effect fn cancellationCase() -> i32 {
  unsafe { silk_socket_stub_reset(62) }
  let mut clock = FixtureClock {
    nowValue: SystemClock.make(0, 0),
    waits: usize.ZERO,
  }
  let mut scheduler = LocalScheduler.make()
  let result = run Effect.catchAll(
    LocalScheduler.execute(&mut scheduler, cancellationRoot())
      |> Effect.provideMut<MonotonicClock>(&mut clock),
    cancellationFailed,
  )
  if result != 42 { return result }
  if clock.waits != usize.ZERO { return 7 }
  if unsafe silk_socket_stub_wait_registrations() != 1 { return 8 }
  if unsafe silk_socket_stub_guard_drops() != 1 { return 9 }
  let closes = unsafe silk_socket_stub_closes()
  if closes != 1 { return 30 + closes }
  if unsafe silk_socket_stub_close_attempts() != 1 { return 11 }
  if unsafe silk_socket_stub_wait_registration_event() <= 0 { return 12 }
  if unsafe silk_socket_stub_wait_registration_event() <= unsafe silk_socket_stub_callback_event() {
    return 13
  }
  if unsafe silk_socket_stub_guard_drop_event()
    <= unsafe silk_socket_stub_wait_registration_event() { return 14 }
  if unsafe silk_socket_stub_first_close_event() <= unsafe silk_socket_stub_guard_drop_event() {
    return 15
  }
  if unsafe silk_socket_stub_callbacks() != 1 { return 16 }
  if unsafe silk_socket_stub_getsockopts() != 0 { return 17 }
  if unsafe silk_socket_stub_recvs() != 1 { return 18 }
  if unsafe silk_socket_stub_sends() != 0 { return 19 }
  if unsafe silk_socket_stub_shutdowns() != 0 { return 20 }
  if unsafe silk_socket_stub_completions() != 0 { return 24 }
  return 42
}

effect fn nativeCases() -> i32 ! NativeSocketError | ByteIoError | OutOfMemoryError {
  if unsafe silk_socket_darwin_witness() != 42 { return 40 }
  if unsafe silk_socket_gnu_witness() != 42 { return 41 }
  let invalid = run invalidCases()
  if invalid != 42 { return invalid }
  let reachedDeadline = run reachedDeadlineCases()
  if reachedDeadline != 42 { return reachedDeadline }
  let attemptPolicy = run attemptPolicyCases()
  if attemptPolicy != 42 { return attemptPolicy }
  let lifecycle = run lifecycleCases()
  if lifecycle != 42 { return lifecycle }
  let io = run ioCases()
  if io != 42 { return io }
  let deadlines = run deadlineBoundaryCases()
  if deadlines != 42 { return deadlines }
  let edges = run lifecycleEdgeCases()
  if edges != 42 { return edges }
  let owned = run ownedAcquisitionCases()
  if owned != 42 { return owned }
  let ownedCancellation = run ownedAcquisitionCancellation()
  if ownedCancellation != 42 { return ownedCancellation }
  let cancellation = run cancellationCase()
  if cancellation != 42 { return cancellation }
  let immediate = run runResolved(0, false, usize.ZERO)
  if immediate != 42 { return immediate }
  let fallback = run runResolved(1, true, usize.ZERO)
  if fallback != 42 { return fallback }
  let pending = run runResolved(2, false, usize.ZERO)
  if pending != 42 { return pending }
  let interrupted = run runResolved(5, false, usize.ONE)
  if interrupted != 42 { return interrupted }
  let timed = run runTimed(
    4,
    SystemClock.make(0, 0),
    Option.some<Instant>(SystemClock.make(0, 2000000)),
  )
  if timed != 42 { return timed }
  let overflow = run runTimed(
    4,
    SystemClock.make(i64.MAX, 999500000),
    Option.none<Instant>(),
  )
  if overflow != 42 { return overflow }
  static if Intrinsic.targetOperatingSystem() == "linux" {
    let backlog = run runUnixRetry()
    if backlog != 42 { return backlog }
  }
  return 42
}

effect fn recoverNative(error: NativeSocketError | ByteIoError | OutOfMemoryError) -> i32 {
  drop error
  return 90
}
pub fn main() -> i32 { return run nativeCases() |> Effect.catchAll(recoverNative) }
`

export const nativeSocketStubSource = `
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif

static int silk_mode;
static int silk_sockets;
static int silk_connects;
static int silk_closes;
static int silk_shutdowns;
static int silk_polls;
static int silk_recv_calls;
static int silk_send_calls;
static int silk_fcntl_calls;
static int silk_setsockopt_calls;
static int silk_getsockopt_calls;
static int silk_close_attempts;
static int silk_callbacks;
static int silk_event;
static int silk_callback_event;
static int silk_close_event;
static int silk_first_close_event;
static int silk_second_socket_event;
static int silk_guard_drops;
static int silk_guard_drop_event;
static int silk_wait_registrations;
static int silk_wait_registration_event;
static int silk_completions;
static int silk_nodelay;
static int silk_configuration_ok;
static int silk_transfer_ok;
static int silk_configuration_mask;

void silk_socket_stub_reset(int mode) {
  silk_mode = mode;
  silk_sockets = 0;
  silk_connects = 0;
  silk_closes = 0;
  silk_shutdowns = 0;
  silk_polls = 0;
  silk_recv_calls = 0;
  silk_send_calls = 0;
  silk_fcntl_calls = 0;
  silk_setsockopt_calls = 0;
  silk_getsockopt_calls = 0;
  silk_close_attempts = 0;
  silk_callbacks = 0;
  silk_event = 0;
  silk_callback_event = 0;
  silk_close_event = 0;
  silk_first_close_event = 0;
  silk_second_socket_event = 0;
  silk_guard_drops = 0;
  silk_guard_drop_event = 0;
  silk_wait_registrations = 0;
  silk_wait_registration_event = 0;
  silk_completions = 0;
  silk_nodelay = 0;
  silk_configuration_ok = 1;
  silk_transfer_ok = 1;
  silk_configuration_mask = 0;
}
int silk_socket_stub_sockets(void) { return silk_sockets; }
int silk_socket_stub_connects(void) { return silk_connects; }
int silk_socket_stub_closes(void) {
#if defined(__APPLE__)
  int closed = 0;
  for (int index = 1; index <= silk_sockets; index += 1) {
    errno = 0;
    if (write(100 + index, "", 0) < 0 && errno == EBADF) closed += 1;
  }
  return closed;
#else
  return silk_closes;
#endif
}
int silk_socket_stub_polls(void) { return silk_polls; }
int silk_socket_stub_recvs(void) { return silk_recv_calls; }
int silk_socket_stub_sends(void) { return silk_send_calls; }
int silk_socket_stub_fcntls(void) { return silk_fcntl_calls; }
int silk_socket_stub_setsockopts(void) { return silk_setsockopt_calls; }
int silk_socket_stub_getsockopts(void) { return silk_getsockopt_calls; }
int silk_socket_stub_close_attempts(void) { return silk_close_attempts; }
int silk_socket_stub_shutdowns(void) { return silk_shutdowns; }
int silk_socket_stub_callbacks(void) { return silk_callbacks; }
int silk_socket_stub_callback_event(void) { return silk_callback_event; }
int silk_socket_stub_close_event(void) { return silk_close_event; }
int silk_socket_stub_first_close_event(void) { return silk_first_close_event; }
int silk_socket_stub_second_socket_event(void) { return silk_second_socket_event; }
int silk_socket_stub_guard_drops(void) { return silk_guard_drops; }
int silk_socket_stub_guard_drop_event(void) { return silk_guard_drop_event; }
int silk_socket_stub_wait_registrations(void) { return silk_wait_registrations; }
int silk_socket_stub_wait_registration_event(void) { return silk_wait_registration_event; }
int silk_socket_stub_completions(void) { return silk_completions; }
void silk_socket_stub_mark_guard_drop(void) {
  silk_guard_drops += 1;
  silk_guard_drop_event = ++silk_event;
}
void silk_socket_stub_mark_wait_registration(void) {
  silk_wait_registrations += 1;
  silk_wait_registration_event = ++silk_event;
}
void silk_socket_stub_mark_callback(void) {
  silk_callbacks += 1;
  silk_callback_event = ++silk_event;
}
void silk_socket_stub_mark_completion(void) { silk_completions += 1; }
int silk_socket_stub_nodelay(void) { return silk_nodelay; }
int silk_socket_stub_configuration_ok(void) {
#if defined(__APPLE__)
  return silk_configuration_ok && (silk_configuration_mask & 15) == 15;
#else
  return silk_configuration_ok && (silk_configuration_mask & 5) == 5;
#endif
}
int silk_socket_stub_transfer_ok(void) { return silk_transfer_ok; }

int socket(int domain, int type, int protocol) {
  silk_sockets += 1;
  int socket_event = ++silk_event;
  if (silk_sockets == 2) silk_second_socket_event = socket_event;
#if defined(__linux__)
  if ((type & SOCK_NONBLOCK) == 0 || (type & SOCK_CLOEXEC) == 0) silk_configuration_ok = 0;
  silk_configuration_mask |= 1;
#else
  if (type != SOCK_STREAM) silk_configuration_ok = 0;
#endif
  if (domain != AF_INET && domain != AF_INET6 && domain != AF_UNIX) silk_configuration_ok = 0;
  if (domain == AF_UNIX && protocol != 0) silk_configuration_ok = 0;
  if (domain != AF_UNIX && protocol != IPPROTO_TCP) silk_configuration_ok = 0;
  if (silk_mode == 54) { errno = EIO; return -1; }
#if defined(__APPLE__)
  int seed = open("/dev/null", O_RDWR);
  int descriptor = 100 + silk_sockets;
  if (seed < 0 || dup2(seed, descriptor) < 0) return -1;
  close(seed);
  return descriptor;
#else
  return 100 + silk_sockets;
#endif
}

#if defined(__APPLE__)
int fcntl(int fd, int command, ...) {
  silk_fcntl_calls += 1;
  if (silk_mode >= 55 && silk_mode <= 58 && silk_fcntl_calls == silk_mode - 54) {
    errno = EIO;
    return -1;
  }
  if (fd < 100) return -1;
  if (command == F_GETFL) return 0;
  if (command == F_GETFD) return 0;
  va_list arguments;
  va_start(arguments, command);
  int value = va_arg(arguments, int);
  va_end(arguments);
  if (command == F_SETFL) {
    if ((value & O_NONBLOCK) == 0) silk_configuration_ok = 0;
    silk_configuration_mask |= 1;
    return 0;
  }
  if (command == F_SETFD) {
    if ((value & FD_CLOEXEC) == 0) silk_configuration_ok = 0;
    silk_configuration_mask |= 2;
    return 0;
  }
  silk_configuration_ok = 0;
  errno = EINVAL;
  return -1;
}
#endif

int setsockopt(int fd, int level, int option, const void *value, socklen_t length) {
  silk_setsockopt_calls += 1;
  if (fd < 100 || value == NULL || length == 0) silk_configuration_ok = 0;
  if (level == SOL_SOCKET && option == SO_LINGER) {
    const struct linger *linger = (const struct linger *)value;
    if (length != sizeof(*linger) || linger->l_onoff != 0 || linger->l_linger != 0) silk_configuration_ok = 0;
    silk_configuration_mask |= 4;
    if (silk_mode == 43) { errno = EIO; return -1; }
  }
#if defined(__APPLE__)
  if (level == SOL_SOCKET && option == SO_NOSIGPIPE) {
    if (length != sizeof(int) || *(const int *)value != 1) silk_configuration_ok = 0;
    silk_configuration_mask |= 8;
    if (silk_mode == 60) { errno = EIO; return -1; }
  }
#endif
  if (level == IPPROTO_TCP && option == TCP_NODELAY) {
    if (length != sizeof(int) || *(const int *)value != 1) silk_configuration_ok = 0;
    silk_nodelay += 1;
    if (silk_mode == 61) { errno = EIO; return -1; }
  }
  return 0;
}

int connect(int fd, const struct sockaddr *address, socklen_t length) {
  silk_connects += 1;
  if (fd < 100 || address == NULL || length < 2) silk_configuration_ok = 0;
  if (address != NULL && address->sa_family == AF_INET) {
    const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;
    unsigned char expected = silk_mode == 1 ? (unsigned char)silk_connects : 1;
    const unsigned char *bytes = (const unsigned char *)&ipv4->sin_addr;
    if (length != sizeof(*ipv4) || ntohs(ipv4->sin_port) != 443 || bytes[3] != expected) {
      silk_configuration_ok = 0;
    }
  }
  if (address != NULL && address->sa_family == AF_UNIX) {
    const struct sockaddr_un *local = (const struct sockaddr_un *)address;
    static const char expected[] = "/tmp/silk-jul-146.sock";
    if (length != offsetof(struct sockaddr_un, sun_path) + sizeof(expected)
      || memcmp(local->sun_path, expected, sizeof(expected)) != 0) {
      silk_configuration_ok = 0;
    }
  }
  if (silk_mode == 1 && silk_connects == 1) { errno = ECONNREFUSED; return -1; }
  if (silk_mode == 2 || silk_mode == 4 || silk_mode == 6) { errno = EINPROGRESS; return -1; }
  if (silk_mode == 5 && silk_connects == 1) { errno = EINTR; return -1; }
  if (silk_mode == 7) { errno = EACCES; return -1; }
#if defined(__linux__)
  if (silk_mode == 3 && silk_connects == 1) { errno = EAGAIN; return -1; }
#endif
  return 0;
}

int poll(struct pollfd *fds, nfds_t count, int timeout) {
  silk_polls += 1;
  if (count != 1 || timeout != 0 || fds == NULL) silk_configuration_ok = 0;
  if (silk_mode == 46 && silk_polls == 1) { errno = EINTR; return -1; }
  if (silk_mode == 47) { errno = EIO; return -1; }
  if (fds != NULL) {
    if (silk_mode == 4 || silk_mode == 6 || silk_mode == 62) fds[0].revents = 0;
    else if (silk_mode == 31 || silk_mode == 32) fds[0].revents = POLLIN;
    else if (silk_mode == 34 || silk_mode == 35) fds[0].revents = POLLOUT;
    else if (silk_mode == 36 || silk_mode == 50) fds[0].revents = POLLHUP;
    else if (silk_mode == 37 || silk_mode == 48) fds[0].revents = POLLERR;
    else if (silk_mode == 38) fds[0].revents = POLLNVAL;
    else fds[0].revents = POLLOUT;
  }
  if (silk_mode == 4 || silk_mode == 6 || silk_mode == 62) return 0;
  return 1;
}

int getsockopt(int fd, int level, int option, void *value, socklen_t *length) {
  silk_getsockopt_calls += 1;
  if (fd < 100 || level != SOL_SOCKET || option != SO_ERROR || value == NULL || length == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (*length < sizeof(int)) { errno = EINVAL; return -1; }
  if (silk_mode == 48) { errno = EIO; return -1; }
  *(int *)value = 0;
  if (silk_mode == 37) *(int *)value = ECONNRESET;
  *length = sizeof(int);
  return 0;
}

ssize_t recv(int fd, void *buffer, size_t length, int flags) {
  if (fd < 100 || buffer == NULL || length == 0 || flags != 0) silk_transfer_ok = 0;
  silk_recv_calls += 1;
  if (silk_mode == 62 && silk_recv_calls == 1) { errno = EAGAIN; return -1; }
  if (silk_mode == 6) { errno = EAGAIN; return -1; }
  if (silk_mode == 30 && silk_recv_calls == 1) { errno = EINTR; return -1; }
  if ((silk_mode == 31 || silk_mode == 36 || silk_mode == 37 || silk_mode == 38
      || silk_mode == 46 || silk_mode == 47 || silk_mode == 48)
    && silk_recv_calls == 1) { errno = EAGAIN; return -1; }
  if (silk_mode == 32 && silk_recv_calls <= 2) { errno = EAGAIN; return -1; }
  if (silk_mode == 39) return (ssize_t)length + 1;
  int data_call = silk_recv_calls == 1;
  if (silk_mode == 30 || silk_mode == 31 || silk_mode == 36 || silk_mode == 46) {
    data_call = silk_recv_calls == 2;
  }
  if (silk_mode == 32) data_call = silk_recv_calls == 3;
  if (silk_mode == 62) data_call = silk_recv_calls == 2;
  if (data_call) {
    if (length < 2) { errno = EINVAL; return -1; }
    ((unsigned char *)buffer)[0] = 'h';
    ((unsigned char *)buffer)[1] = 'i';
    return 2;
  }
  return 0;
}

ssize_t send(int fd, const void *buffer, size_t length, int flags) {
  silk_send_calls += 1;
  if (fd < 100 || buffer == NULL || length != 5) silk_transfer_ok = 0;
#if defined(__linux__)
  if ((flags & MSG_NOSIGNAL) == 0) silk_transfer_ok = 0;
#else
  if (flags != 0) silk_transfer_ok = 0;
#endif
  if (silk_mode == 33 && silk_send_calls == 1) { errno = EINTR; return -1; }
  if (silk_mode == 34 && silk_send_calls == 1) { errno = EAGAIN; return -1; }
  if (silk_mode == 35 && silk_send_calls <= 2) { errno = EAGAIN; return -1; }
  if (silk_mode == 40) return 0;
  if (silk_mode == 41) return (ssize_t)length + 1;
  if (silk_mode == 45) { errno = EPIPE; return -1; }
  if (silk_mode == 50 && silk_send_calls == 1) { errno = EAGAIN; return -1; }
  return 2;
}

int shutdown(int fd, int how) {
  if (fd < 100 || how != SHUT_WR) silk_transfer_ok = 0;
  silk_shutdowns += 1;
  if (silk_mode == 51 && silk_shutdowns == 1) { errno = EINTR; return -1; }
  if (silk_mode == 52) { errno = ENOTCONN; return -1; }
  if (silk_mode == 53) { errno = EIO; return -1; }
  return 0;
}

#if defined(__APPLE__)
int silk_socket_close_nocancel(int fd) __asm("_close$NOCANCEL");
int silk_socket_close_nocancel(int fd) {
  if (fd >= 100) {
    silk_close_attempts += 1;
    silk_closes += 1;
    silk_close_event = ++silk_event;
    if (silk_first_close_event == 0) silk_first_close_event = silk_close_event;
    if (silk_mode == 42) { errno = EIO; return -1; }
  }
  return close(fd);
}
#else
int close(int fd) {
  if (fd >= 100) {
    silk_close_attempts += 1;
    silk_closes += 1;
    silk_close_event = ++silk_event;
    if (silk_first_close_event == 0) silk_first_close_event = silk_close_event;
    if (silk_mode == 42) { errno = EIO; return -1; }
    return 0;
  }
  return (int)syscall(SYS_close, fd);
}
#endif
`

export const nativeSocketDarwinWitnessSource = `
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#if defined(__APPLE__)
_Static_assert(sizeof(struct sockaddr_in) == 16, "Darwin sockaddr_in size");
_Static_assert(sizeof(struct sockaddr_in6) == 28, "Darwin sockaddr_in6 size");
_Static_assert(_Alignof(struct sockaddr_in) == 4, "Darwin sockaddr_in alignment");
_Static_assert(_Alignof(struct sockaddr_in6) == 4, "Darwin sockaddr_in6 alignment");
_Static_assert(sizeof(struct sockaddr_un) == 106 && _Alignof(struct sockaddr_un) == 1, "Darwin sockaddr_un layout");
_Static_assert(sizeof(struct pollfd) == 8 && _Alignof(struct pollfd) == 4, "Darwin pollfd layout");
_Static_assert(offsetof(struct pollfd, events) == 4 && offsetof(struct pollfd, revents) == 6, "Darwin pollfd offsets");
_Static_assert(sizeof(struct linger) == 8 && _Alignof(struct linger) == 4, "Darwin linger layout");
_Static_assert(offsetof(struct sockaddr_in, sin_port) == 2 && offsetof(struct sockaddr_in, sin_addr) == 4, "Darwin IPv4 offsets");
_Static_assert(offsetof(struct sockaddr_in6, sin6_port) == 2 && offsetof(struct sockaddr_in6, sin6_addr) == 8, "Darwin IPv6 offsets");
_Static_assert(offsetof(struct sockaddr_un, sun_path) == 2, "Darwin sockaddr_un header");
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) == 104, "Darwin sun_path capacity");
_Static_assert(AF_INET == 2 && AF_INET6 == 30 && AF_UNIX == 1, "Darwin families");
_Static_assert(SO_ERROR == 0x1007 && SO_LINGER == 0x80 && SO_NOSIGPIPE == 0x1022, "Darwin socket options");
_Static_assert(IPPROTO_TCP == 6 && TCP_NODELAY == 1 && SHUT_WR == 1, "Darwin TCP and shutdown constants");
_Static_assert(O_NONBLOCK == 4 && FD_CLOEXEC == 1 && F_GETFL == 3 && F_SETFL == 4 && F_GETFD == 1 && F_SETFD == 2, "Darwin setup flags");
_Static_assert(EINTR == 4 && EINPROGRESS == 36 && EAGAIN == 35 && EWOULDBLOCK == EAGAIN, "Darwin retry errno");
_Static_assert(EPERM == 1 && EIO == 5 && EBADF == 9 && ENOMEM == 12 && EACCES == 13, "Darwin core errno");
_Static_assert(ENFILE == 23 && EMFILE == 24, "Darwin resource errno");
_Static_assert(ECONNREFUSED == 61 && ENETUNREACH == 51 && EADDRNOTAVAIL == 49 && ENOBUFS == 55, "Darwin mapped errno");
_Static_assert(EAFNOSUPPORT == 47 && ENOTCONN == 57 && ECONNRESET == 54 && EPIPE == 32, "Darwin socket errno");
_Static_assert(POLLIN == 1 && POLLOUT == 4 && POLLERR == 8 && POLLHUP == 16 && POLLNVAL == 32, "Darwin poll bits");
_Static_assert(SOCK_STREAM == 1, "Darwin stream socket type");
_Static_assert(sizeof(int) == 4 && sizeof(socklen_t) == 4 && sizeof(nfds_t) == 4, "Darwin ABI argument widths");
_Static_assert(sizeof(size_t) == sizeof(void *) && sizeof(ssize_t) == sizeof(void *), "Darwin transfer widths");
_Static_assert(SSIZE_MAX == INTPTR_MAX, "Darwin transfer maximum");
extern int silk_close_nocancel(int) __asm("_close$NOCANCEL");
static int (*silk_socket_signature)(int, int, int) = socket;
static int (*silk_connect_signature)(int, const struct sockaddr *, socklen_t) = connect;
static int (*silk_getsockopt_signature)(int, int, int, void *, socklen_t *) = getsockopt;
static int (*silk_setsockopt_signature)(int, int, int, const void *, socklen_t) = setsockopt;
static ssize_t (*silk_recv_signature)(int, void *, size_t, int) = recv;
static ssize_t (*silk_send_signature)(int, const void *, size_t, int) = send;
static int (*silk_shutdown_signature)(int, int) = shutdown;
static int (*silk_poll_signature)(struct pollfd *, nfds_t, int) = poll;
static int (*silk_fcntl_signature)(int, int, ...) = fcntl;
static int *(*silk_error_signature)(void) = __error;
static int (*silk_close_signature)(int) = silk_close_nocancel;
#endif
int silk_socket_darwin_witness(void) { return 42; }
`

export const nativeSocketGnuWitnessSource = `
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#if defined(__linux__) && defined(__GLIBC__)
_Static_assert(sizeof(struct sockaddr_in) == 16, "GNU sockaddr_in size");
_Static_assert(sizeof(struct sockaddr_in6) == 28, "GNU sockaddr_in6 size");
_Static_assert(_Alignof(struct sockaddr_in) == 4, "GNU sockaddr_in alignment");
_Static_assert(_Alignof(struct sockaddr_in6) == 4, "GNU sockaddr_in6 alignment");
_Static_assert(sizeof(struct sockaddr_un) == 110 && _Alignof(struct sockaddr_un) == 2, "GNU sockaddr_un layout");
_Static_assert(sizeof(struct pollfd) == 8 && _Alignof(struct pollfd) == 4, "GNU pollfd layout");
_Static_assert(offsetof(struct pollfd, events) == 4 && offsetof(struct pollfd, revents) == 6, "GNU pollfd offsets");
_Static_assert(sizeof(struct linger) == 8 && _Alignof(struct linger) == 4, "GNU linger layout");
_Static_assert(offsetof(struct sockaddr_in, sin_port) == 2 && offsetof(struct sockaddr_in, sin_addr) == 4, "GNU IPv4 offsets");
_Static_assert(offsetof(struct sockaddr_in6, sin6_port) == 2 && offsetof(struct sockaddr_in6, sin6_addr) == 8, "GNU IPv6 offsets");
_Static_assert(offsetof(struct sockaddr_un, sun_path) == 2, "GNU sockaddr_un header");
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) == 108, "GNU sun_path capacity");
_Static_assert(AF_INET == 2 && AF_INET6 == 10 && AF_UNIX == 1, "GNU families");
_Static_assert(SO_ERROR == 4 && SO_LINGER == 13, "GNU socket options");
_Static_assert(IPPROTO_TCP == 6 && TCP_NODELAY == 1 && SHUT_WR == 1, "GNU TCP and shutdown constants");
_Static_assert(SOCK_NONBLOCK == 2048 && SOCK_CLOEXEC == 524288 && MSG_NOSIGNAL == 16384, "GNU setup and send flags");
_Static_assert(EINTR == 4 && EINPROGRESS == 115 && EAGAIN == 11 && EWOULDBLOCK == EAGAIN, "GNU retry errno");
_Static_assert(EPERM == 1 && EIO == 5 && EBADF == 9 && ENOMEM == 12 && EACCES == 13, "GNU core errno");
_Static_assert(ENFILE == 23 && EMFILE == 24, "GNU resource errno");
_Static_assert(ECONNREFUSED == 111 && ENETUNREACH == 101 && EADDRNOTAVAIL == 99 && ENOBUFS == 105, "GNU mapped errno");
_Static_assert(EAFNOSUPPORT == 97 && ENOTCONN == 107 && ECONNRESET == 104 && EPIPE == 32, "GNU socket errno");
_Static_assert(POLLIN == 1 && POLLOUT == 4 && POLLERR == 8 && POLLHUP == 16 && POLLNVAL == 32, "GNU poll bits");
_Static_assert(SOCK_STREAM == 1, "GNU stream socket type");
_Static_assert(sizeof(int) == 4 && sizeof(socklen_t) == 4 && sizeof(nfds_t) == 8, "GNU ABI argument widths");
_Static_assert(sizeof(size_t) == sizeof(void *) && sizeof(ssize_t) == sizeof(void *), "GNU transfer widths");
_Static_assert(SSIZE_MAX == INTPTR_MAX, "GNU transfer maximum");
static int (*silk_socket_signature)(int, int, int) = socket;
static int (*silk_connect_signature)(int, const struct sockaddr *, socklen_t) = connect;
static int (*silk_getsockopt_signature)(int, int, int, void *, socklen_t *) = getsockopt;
static int (*silk_setsockopt_signature)(int, int, int, const void *, socklen_t) = setsockopt;
static ssize_t (*silk_recv_signature)(int, void *, size_t, int) = recv;
static ssize_t (*silk_send_signature)(int, const void *, size_t, int) = send;
static int (*silk_shutdown_signature)(int, int) = shutdown;
static int (*silk_poll_signature)(struct pollfd *, nfds_t, int) = poll;
static int *(*silk_errno_signature)(void) = __errno_location;
static int (*silk_close_signature)(int) = close;
#endif
int silk_socket_gnu_witness(void) { return 42; }
`

/** Profile-agnostic JUL-146 corpus entry; the shared harness owns debug/optimized profile selection. */
export const nativeSocketCorpusProgram = Object.freeze({
  name: 'native-socket-connections',
  source: 'pub fn main() -> i32 { return 42 }',
  nativeSource: nativeSocketAcceptanceSource,
  nativeCSources: Object.freeze({
    native_socket_stub: nativeSocketStubSource,
    native_socket_darwin_witness: nativeSocketDarwinWitnessSource,
    native_socket_gnu_witness: nativeSocketGnuWitnessSource,
  }),
  expected: Object.freeze({ _tag: 'Completes' as const, result: 42 }),
})
