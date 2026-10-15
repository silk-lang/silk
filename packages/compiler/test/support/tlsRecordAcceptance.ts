const dependencies = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.option { Option }
import silk.result { Result }
import silk.slice { Slice }`

const publicImports = `import silk.tls_record {
  CipherSuite,
  ContentType,
  InputDemand,
  InputProgress,
  OutputDemand,
  OutputProgress,
  RecordError,
  RecordView,
  TlsRecordReceiver,
  TlsRecordSender,
}`

export const tlsRecordWasmSource = `${publicImports}
${dependencies}
fn ok(result: Result<OutputProgress, RecordError>) -> bool {
  return match move result {
    Result<OutputProgress, RecordError>.Success {value} => value.accepted == 0 && value.demand == OutputDemand.RecordQueued
    Result<OutputProgress, RecordError>.Failure {error} => false
  }
}
effect fn witness() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut sender = run (TlsRecordSender.makePlaintext() |> Effect.provideMut(&mut allocator))
  let empty: [u8; 0] = []
  if !ok(TlsRecordSender.queueRecord(&mut sender, ContentType.ApplicationData, &empty)) { return 1 }
  let expected: [u8; 5] = [23, 3, 3, 0, 0]
  let output = TlsRecordSender.pendingOutput(&sender)
  if output.length != 5 { return 2 }
  let mut index: usize = 0
  while index < 5 { if output[index] != expected[index] { return 3 } index = index + 1 }
  return 0
}
effect fn failed(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(witness(), failed) }`
