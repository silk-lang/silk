export const recoveredWriterModule = `import silk.native_descriptor { NativeDescriptor }
import silk.effect { Effect }
import silk.result { Result }
import silk.writer { Writer, WriterError }

effect fn writeNative(bytes: &[u8]) -> () ! WriterError {
  let mut error = 0
  let complete = run NativeDescriptor.writeAll(1, bytes, &mut error)
  if complete == false { fail Writer.failure() }
  return ()
}

pub struct RecoveredWriterError {}

pub service RecoveredWriter {
  effect fn writeAll(bytes: &[u8]) -> () ! RecoveredWriterError ? &mut RecoveredWriter
}

pub struct StdoutWriter {}

effect fn translate<A, E, ?R>(self: once Effect<A ! E ? R>) -> A ! RecoveredWriterError ? R {
  let completed = run Effect.result(move self)
  if let Result<A, E>.Success { value } = move completed {
    return move value
  }
  fail RecoveredWriterError {}
}

impl RecoveredWriter for StdoutWriter {
  effect fn writeAll(
    self: &mut StdoutWriter,
    bytes: &[u8]
  ) -> () ! RecoveredWriterError ? &mut RecoveredWriter {
    return run writeNative(bytes) |> translate
  }
}

pub effect fn program() -> () ! RecoveredWriterError ? &mut RecoveredWriter {
  return run RecoveredWriter.writeAll(b"Hello")
}`

export const recoveredProvidedWrite = `import silk.effect { Effect }
import recovered_writer { RecoveredWriterError, StdoutWriter, program }

pub effect fn main() -> () ! RecoveredWriterError {
  let mut writer = StdoutWriter {}
  return run program() |> Effect.provideMut(&mut writer)
}`

export const recoveredDirectWrite = `import silk.native_descriptor { NativeDescriptor }
import silk.effect { Effect }
import silk.result { Result }
import silk.writer { Writer, WriterError }

effect fn writeNative(bytes: &[u8]) -> () ! WriterError {
  let mut error = 0
  let complete = run NativeDescriptor.writeAll(1, bytes, &mut error)
  if complete == false { fail Writer.failure() }
  return ()
}

pub struct RecoveredWriterError {}

effect fn translate<A, E, ?R>(self: once Effect<A ! E ? R>) -> A ! RecoveredWriterError ? R {
  let completed = run Effect.result(move self)
  if let Result<A, E>.Success { value } = move completed {
    return move value
  }
  fail RecoveredWriterError {}
}

pub effect fn main() -> () ! RecoveredWriterError {
  return run writeNative(b"Hello") |> translate
}`
