import type * as Backend from './Backend.js'
import type * as CompilationProfile from './CompilationProfile.js'
import * as Effect from 'effect/Effect'
import * as NativeToolchain from './NativeToolchain.js'

/** Explicit inputs for materializing one backend artifact inside a caller-owned build lifetime. */
export interface Request {
  readonly toolchain: NativeToolchain.Toolchain
  readonly scope: NativeToolchain.BuildScope
  readonly artifact: Backend.LlvmBitcodeArtifact
  readonly profile: CompilationProfile.CompilationProfile
  readonly baseName?: string
}

/** Turns backend bitcode into a native object while retaining object inventory and helper metadata. */
export const materialize = Effect.fn('ObjectEmission.materialize')(function* (
  request: Request,
): Effect.fn.Return<NativeToolchain.ObjectArtifact, NativeToolchain.ToolchainError> {
  return yield* NativeToolchain.materializeObject(
    request.toolchain,
    request.scope,
    request.artifact,
    request.profile,
    request.baseName ?? 'program',
  )
})
