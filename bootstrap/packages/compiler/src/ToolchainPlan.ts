import type * as CompilationProfile from './CompilationProfile.js'
/**
 * Pure planning for the pinned native toolchain: fixed optimization profiles, the exact
 * structured commands the orchestration issues (never a shell string), and the minimal C runtime
 * runtime source. Browser-safe by construction — execution lives in `NativeToolchain`.
 */

import type * as ArtifactKind from './ArtifactKind.js'
import * as NativeLinkInput from './NativeLinkInput.js'
import type * as Target from './Target.js'

/** The fixed optimization profiles. There is no configurable pass pipeline. */
export type OptimizationProfile = 'debug' | 'release' | 'release-with-debug'

/** One planned process invocation: the pinned command and its structured arguments. */
export interface PlannedCommand {
  readonly _tag: 'PlannedCommand'
  readonly target: Target.Target
  readonly command: string
  readonly arguments: ReadonlyArray<string>
  readonly environment?: Readonly<Record<string, string>>
}

/** The codegen mode a profile's bitcode is emitted with. */
export const codegenModeFor = (profile: OptimizationProfile): 'debug' | 'release' =>
  profile === 'release' ? 'release' : 'debug'

/** Projects logical optimization/debug choices into the fixed toolchain optimization labels. */
export const optimizationFor = (
  self: Pick<CompilationProfile.Input, 'optimization' | 'debug'>,
): OptimizationProfile => {
  if (self.optimization !== 'speed') return 'debug'
  return self.debug === false ? 'release' : 'release-with-debug'
}

/** Lowers logical code-generation choices into deterministic Clang arguments. */
export const compilationArguments = (profile: CompilationProfile.Facts): ReadonlyArray<string> => [
  profile.optimization === 'none' ? '-O0' : '-O2',
  ...(profile.debug ? ['-g'] : []),
  ...(profile.target.kind === 'Native' && profile.codeModel === 'large' ? ['-mcmodel=large'] : []),
  ...(profile.target.operatingSystem === 'darwin'
    ? [`-mmacosx-version-min=${profile.deployment ?? '11.0.0'}`]
    : []),
]

/** Plans the pinned Clang `-c` invocation that turns bitcode into a target object. */
export const objectCommand = (
  clang: string,
  profile: CompilationProfile.Facts,
  bitcodePath: string,
  objectPath: string,
): PlannedCommand => ({
  _tag: 'PlannedCommand',
  target: profile.target,
  command: clang,
  arguments: [
    `--target=${profile.target.id}`,
    '-c',
    '-x',
    'ir',
    bitcodePath,
    profile.relocation === 'pic' ? '-fPIC' : '-fno-pic',
    ...compilationArguments(profile),
    '-o',
    objectPath,
  ],
})

export type NativeArtifactKind = Exclude<ArtifactKind.ArtifactKind, 'WebAssemblyModule'>

/** A target or artifact combination that cannot preserve the requested typed link semantics. */
export interface UnsupportedNativePlan {
  readonly _tag: 'UnsupportedNativePlan'
  readonly artifactKind: NativeArtifactKind
  readonly target: Target.Target
  readonly input: NativeLinkInput.NativeLinkInput
  readonly reason:
    | 'FrameworkTarget'
    | 'LinkerScriptTarget'
    | 'StaticLibraryTarget'
    | 'StaticArchiveInput'
    | 'PathNotAbsolute'
}

export type NativePlan = PlannedCommand | UnsupportedNativePlan

const unsupported = (
  artifactKind: NativeArtifactKind,
  target: Target.Target,
  input: NativeLinkInput.NativeLinkInput,
  reason: UnsupportedNativePlan['reason'],
): UnsupportedNativePlan => ({ _tag: 'UnsupportedNativePlan', artifactKind, target, input, reason })

const clangInputArguments = (
  artifactKind: 'NativeExecutable' | 'NativeSharedLibrary',
  target: Target.Target,
  input: NativeLinkInput.NativeLinkInput,
): ReadonlyArray<string> | UnsupportedNativePlan => {
  switch (input._tag) {
    case 'Object':
    case 'StaticArchive':
      return [input.path]
    case 'LinkerScript':
      return target.operatingSystem === 'linux'
        ? ['-Xlinker', '-T', '-Xlinker', input.path]
        : unsupported(artifactKind, target, input, 'LinkerScriptTarget')
    case 'SearchPath':
      return [`-L${input.path}`]
    case 'Framework':
      return target.id === 'aarch64-apple-darwin'
        ? ['-framework', input.name]
        : unsupported(artifactKind, target, input, 'FrameworkTarget')
    case 'Library':
      if (input.mode === 'Dynamic') return [`-l${input.name}`]
      return target.id === 'aarch64-apple-darwin'
        ? unsupported(artifactKind, target, input, 'StaticLibraryTarget')
        : ['-Wl,-Bstatic', `-l${input.name}`, '-Wl,-Bdynamic']
  }
}

const fileName = (path: string): string => path.split(/[/\\]/).at(-1) ?? path

/** Plans one native executable/shared link or deterministic static archive. */
export const nativeCommand = (
  tools: { readonly clang: string; readonly llvmAr: string },
  artifactKind: NativeArtifactKind,
  target: Target.Target,
  generatedObjects: ReadonlyArray<string>,
  inputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>,
  destination: string,
  entry: CompilationProfile.Selection = { kind: 'default' },
): NativePlan => {
  for (const input of inputs) {
    if (!NativeLinkInput.hasAbsolutePath(input))
      return unsupported(artifactKind, target, input, 'PathNotAbsolute')
  }
  if (artifactKind === 'NativeObject') {
    for (const input of inputs)
      if (input._tag !== 'Object' && input._tag !== 'StaticArchive')
        return unsupported(artifactKind, target, input, 'StaticArchiveInput')
    return {
      _tag: 'PlannedCommand',
      target,
      command: tools.clang,
      arguments: [
        `--target=${target.id}`,
        '-r',
        '-nostdlib',
        ...generatedObjects,
        ...inputs.flatMap((input) =>
          input._tag === 'Object' || input._tag === 'StaticArchive' ? [input.path] : [],
        ),
        '-o',
        destination,
      ],
    }
  }
  if (artifactKind === 'NativeStaticLibrary') {
    const members = [...generatedObjects]
    for (const input of inputs) {
      if (input._tag !== 'Object')
        return unsupported(artifactKind, target, input, 'StaticArchiveInput')
      members.push(input.path)
    }
    return {
      _tag: 'PlannedCommand',
      target,
      command: tools.llvmAr,
      arguments: ['rcsD', destination, ...members],
    }
  }
  let sharedArguments: ReadonlyArray<string> = []
  if (artifactKind === 'NativeSharedLibrary')
    sharedArguments =
      target.id === 'aarch64-apple-darwin'
        ? ['-dynamiclib', `-Wl,-install_name,@rpath/${fileName(destination)}`]
        : ['-shared']
  let entryArguments: ReadonlyArray<string> = []
  if (artifactKind === 'NativeExecutable' && entry.kind === 'named')
    entryArguments = ['-nostartfiles', '-Xlinker', '-e', '-Xlinker', entry.name]
  else if (artifactKind === 'NativeExecutable' && entry.kind === 'none')
    entryArguments = ['-nostartfiles', '-Wl,-e,0']
  const arguments_: Array<string> = [
    `--target=${target.id}`,
    ...sharedArguments,
    ...entryArguments,
    ...generatedObjects,
  ]
  for (const input of inputs) {
    const encoded = clangInputArguments(artifactKind, target, input)
    if ('_tag' in encoded) return encoded
    arguments_.push(...encoded)
  }
  arguments_.push('-o', destination)
  return {
    _tag: 'PlannedCommand',
    target,
    command: tools.clang,
    arguments: arguments_,
  }
}

/** Plans the pinned Clang invocation that compiles one runtime translation unit. */
export const cObjectCommand = (
  clang: string,
  target: Target.Target,
  sourcePath: string,
  objectPath: string,
): PlannedCommand => ({
  _tag: 'PlannedCommand',
  target,
  command: clang,
  arguments: [
    `--target=${target.id}`,
    '-c',
    '-x',
    'c',
    sourcePath,
    '-O2',
    '-fPIC',
    '-fvisibility=hidden',
    '-o',
    objectPath,
  ],
})

/** Plans standalone LLVM-bitcode to WebAssembly finalization through pinned Clang. */
export const wasmCommand = (
  clang: string,
  profile: CompilationProfile.CompilationProfile,
  objectPath: string,
  runtimeObjectPath: string,
  destination: string,
): PlannedCommand => ({
  _tag: 'PlannedCommand',
  target: profile.target,
  command: clang,
  arguments: [
    `--target=${profile.target.id}`,
    '-nostdlib',
    objectPath,
    runtimeObjectPath,
    ...compilationArguments(profile),
    '-Wl,--no-entry',
    '-Wl,--export-dynamic',
    '-o',
    destination,
  ],
})

/*
 * This is the sole owner of feature-test macros for the generated translation unit. Keep it
 * immediately after the leading comment: libc examines these macros while processing its first
 * header, so defining them in a later capability fragment is too late when fragments are mixed.
 */
const translationUnitPreamble = `#if defined(__APPLE__)
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE 1
#endif
#elif defined(__linux__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif
#endif
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
`

/** Renders text as a C string literal; octal escapes keep every byte outside printable ASCII exact. */
export const cString = (text: string): string => {
  let rendered = '"'
  for (const byte of new TextEncoder().encode(text)) {
    if (byte === 0x22 || byte === 0x5c || byte === 0x3f) {
      rendered += `\\${String.fromCharCode(byte)}`
    } else if (byte >= 0x20 && byte < 0x7f) {
      rendered += String.fromCharCode(byte)
    } else {
      rendered += `\\${byte.toString(8).padStart(3, '0')}`
    }
  }
  return `${rendered}"`
}

/** Generates the native translation-unit preamble for retained libc boundaries. */
export const runtimeSource =
  (): string => `/* silk-effect native runtime — private, compiler-versioned. */
${translationUnitPreamble}
`
