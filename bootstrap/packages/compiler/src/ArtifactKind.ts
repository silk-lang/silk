import type * as CompilationProfile from './CompilationProfile.js'
import type * as Target from './Target.js'

/** The closed set of durable artifacts the compiler can produce. */
export type ArtifactKind =
  | 'NativeExecutable'
  | 'NativeSharedLibrary'
  | 'NativeStaticLibrary'
  | 'NativeObject'
  | 'WebAssemblyModule'

/** Manifest spellings for artifacts selected by a project build. */
export type ManifestSpelling = 'executable' | 'shared-library' | 'static-library' | 'object'

export const nativeExecutable: ArtifactKind = 'NativeExecutable'
export const nativeSharedLibrary: ArtifactKind = 'NativeSharedLibrary'
export const nativeStaticLibrary: ArtifactKind = 'NativeStaticLibrary'
export const nativeObject: ArtifactKind = 'NativeObject'
export const webAssemblyModule: ArtifactKind = 'WebAssemblyModule'

/** Decodes one exact project-manifest artifact spelling. */
export const fromManifest = (value: string): ArtifactKind | undefined => {
  switch (value) {
    case 'executable':
      return nativeExecutable
    case 'shared-library':
      return nativeSharedLibrary
    case 'static-library':
      return nativeStaticLibrary
    case 'object':
      return nativeObject
    default:
      return undefined
  }
}

/** Encodes a project-selectable artifact kind for a manifest or diagnostic. */
export const manifestSpelling = (self: ArtifactKind): ManifestSpelling | undefined => {
  switch (self) {
    case 'NativeExecutable':
      return 'executable'
    case 'NativeSharedLibrary':
      return 'shared-library'
    case 'NativeStaticLibrary':
      return 'static-library'
    case 'NativeObject':
      return 'object'
    case 'WebAssemblyModule':
      return undefined
  }
}

/** Whether an artifact is a loadable or linkable native library rather than a process. */
export const isLibrary = (
  self: ArtifactKind,
): self is 'NativeSharedLibrary' | 'NativeStaticLibrary' =>
  self === 'NativeSharedLibrary' || self === 'NativeStaticLibrary'

/** Whether the selected target can carry this artifact kind. */
export const supports = (self: ArtifactKind, target: Target.Target): boolean =>
  self === 'WebAssemblyModule' ? target.kind === 'WebAssembly' : target.kind === 'Native'

/** The target-conventional durable filename for one package artifact. */
export const fileName = (
  self: ArtifactKind,
  packageName: string,
  target: Target.Target,
): string => {
  switch (self) {
    case 'NativeExecutable':
      return packageName
    case 'NativeSharedLibrary':
      return target.id === 'aarch64-apple-darwin'
        ? `lib${packageName}.dylib`
        : `lib${packageName}.so`
    case 'NativeStaticLibrary':
      return `lib${packageName}.a`
    case 'NativeObject':
      return `${packageName}.o`
    case 'WebAssemblyModule':
      return `${packageName}.wasm`
  }
}

/** Deterministic cache/debug encoding. */
export const encode = (self: ArtifactKind): string => self

/** Maps a durable artifact request into the corresponding logical profile fact. */
export const profileArtifact = (self: ArtifactKind): CompilationProfile.Artifact => {
  if (self === 'NativeObject') return 'object'
  if (self === 'NativeStaticLibrary') return 'static-archive'
  if (self === 'NativeExecutable' || self === 'WebAssemblyModule') return 'executable'
  return 'loadable-module'
}
