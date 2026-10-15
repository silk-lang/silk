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
