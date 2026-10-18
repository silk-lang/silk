import type * as HelperCapability from './HelperCapability.js'
import * as Schema from 'effect/Schema'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as NativeLinkInput from './NativeLinkInput.js'
import type * as NativeLinkPlan from './NativeLinkPlan.js'
import * as PlatformSupply from './PlatformSupply.js'
import * as PlatformSupplyResolver from './PlatformSupplyResolver.js'
import * as ToolchainPlan from './ToolchainPlan.js'
import type * as CompilationProfile from './CompilationProfile.js'
import * as LinkerScript from './internal/LinkerScript.js'
import * as NativeInputFormat from './internal/NativeInputFormat.js'
import * as NativeStub from './internal/NativeStub.js'

/** Parses Clang's quoted dry-run argv without executing a shell or accepting command expansion. */
export const argumentsOf = (line: string): Result.Result<ReadonlyArray<string>, string> => {
  const values: Array<string> = []
  let value = '',
    quoted = false,
    active = false,
    escaped = false
  for (const character of line.trim()) {
    if (escaped) {
      value += character
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') {
      quoted = !quoted
      active = true
      continue
    }
    if (/\s/.test(character) && !quoted) {
      if (active) {
        values.push(value)
        value = ''
        active = false
      }
    } else {
      value += character
      active = true
    }
  }
  if (quoted || escaped) return Result.fail('unterminated driver argument')
  if (active) values.push(value)
  return Result.succeed(values)
}

interface Closure {
  readonly supply: PlatformSupply.PlatformSupply
  readonly roots: Array<string>
  readonly inputs: Array<PlatformSupply.File>
  readonly scripts: Array<NativeLinkPlan.Script>
  readonly paths: Map<string, string>
  readonly scriptModes: Map<string, 'Static' | 'Dynamic'>
  readonly active: Set<string>
  readonly userPaths: ReadonlySet<string>
  readonly scope: string
  readonly directory: string
  mode: 'Static' | 'Dynamic'
  glibcVersion: string | undefined
}
const fail = (subject: string, origin: string, detail: string): PlatformSupply.SupplyError =>
  PlatformSupply.failure('UnsupportedInput', subject, origin, detail)

const locate = Effect.fnUntraced(function* (
  closure: Closure,
  name: string,
  origin: string,
  mode: 'Static' | 'Dynamic' = closure.mode,
): Effect.fn.Return<string, PlatformSupply.SupplyError, PlatformSupplyResolver.Services> {
  let names: ReadonlyArray<string> = [name]
  if (name.startsWith('-l:')) names = [name.slice(3)]
  else if (name.startsWith('-l')) {
    if (mode === 'Static') names = [`lib${name.slice(2)}.a`]
    else if (closure.supply.target.operatingSystem === 'darwin')
      names = [`lib${name.slice(2)}.tbd`, `lib${name.slice(2)}.dylib`, `lib${name.slice(2)}.a`]
    else names = [`lib${name.slice(2)}.so`, `lib${name.slice(2)}.a`]
  }
  for (const root of closure.roots)
    for (const candidate of names) {
      const path = join(root, candidate)
      if (yield* PlatformSupplyResolver.exists(path)) return path
    }
  return yield* PlatformSupply.failure(
    'MissingCapability',
    name,
    origin,
    'Provide the requested input in an explicit compatible search root.',
  )
})

const scriptPath = Effect.fnUntraced(function* (
  closure: Closure,
  name: string,
  origin: string,
  kind: LinkerScript.Reference['kind'],
): Effect.fn.Return<string, PlatformSupply.SupplyError, PlatformSupplyResolver.Services> {
  if (name.startsWith('=')) return join(closure.supply.root, name.slice(1))
  if (name.startsWith('$SYSROOT')) return join(closure.supply.root, name.slice(8))
  if (isAbsolute(name)) {
    // GNU scripts installed inside a sysroot interpret their absolute inputs within that sysroot.
    if (
      kind === 'input' &&
      closure.supply.root !== '/' &&
      PlatformSupplyResolver.within(closure.supply.root, origin)
    )
      return join(closure.supply.root, name)
    return name
  }
  if (kind === 'search') return resolve(closure.directory, name)
  if (!name.startsWith('-l')) {
    if (kind === 'input') {
      const local = resolve(dirname(origin), name)
      if (yield* PlatformSupplyResolver.exists(local)) return local
    }
    const local = resolve(closure.directory, name)
    if (yield* PlatformSupplyResolver.exists(local)) return local
  }
  return yield* locate(closure, name, origin)
})

const addFile = Effect.fnUntraced(function* (
  closure: Closure,
  path: string,
  role: PlatformSupply.Role,
  origin: string,
): Effect.fn.Return<string, PlatformSupply.SupplyError, PlatformSupplyResolver.Services> {
  const input = yield* PlatformSupplyResolver.file(path, role, origin, closure.supply.root)
  const existing = closure.paths.get(input.path)
  if (existing !== undefined) {
    const mode = closure.scriptModes.get(input.path)
    if (mode !== undefined && mode !== closure.mode)
      return yield* fail(
        path,
        origin,
        'A selected script cannot be reused under different static/dynamic search modes.',
      )
    return existing
  }
  if (closure.active.has(input.path))
    return yield* fail(path, origin, 'Remove the cyclic linker script reference.')
  const isUser = closure.userPaths.has(resolve(path)) || closure.userPaths.has(input.path)
  if (
    !isUser &&
    !closure.supply.installations.some((installation) =>
      PlatformSupplyResolver.within(installation.root, input.path),
    ) &&
    !closure.roots.some(
      (root) => closure.userPaths.has(root) && PlatformSupplyResolver.within(root, input.path),
    )
  )
    return yield* PlatformSupply.failure(
      'MixedInstallation',
      input.path,
      origin,
      'Declare a compatible support installation or supply this input explicitly.',
    )
  closure.inputs.push(input)
  closure.active.add(input.path)
  const bytes = yield* PlatformSupplyResolver.read(input.path, origin)
  const binary = NativeInputFormat.inspect(bytes, closure.supply.target)
  if (binary !== undefined) {
    if (!binary.compatible)
      return yield* PlatformSupply.failure(
        'TargetMismatch',
        input.path,
        origin,
        `Supply an input for ${closure.supply.target.id}.`,
      )
    if (closure.supply.deployment !== undefined)
      for (const version of binary.versions)
        if (PlatformSupply.compareVersions(version, closure.supply.deployment) > 0)
          return yield* PlatformSupply.failure(
            'DeploymentMismatch',
            version,
            input.path,
            'Select components compatible with the requested deployment.',
          )
    if (binary.name === 'libc.so.6') {
      if (
        closure.supply.libc !== 'gnu' ||
        binary.providedVersions === undefined ||
        binary.providedVersions.length === 0
      )
        return yield* PlatformSupply.failure(
          'TargetMismatch',
          input.path,
          origin,
          'Provide the selected GNU glibc contract.',
        )
      closure.glibcVersion = [...binary.providedVersions]
        .sort(PlatformSupply.compareVersions)
        .at(-1)
    }
    // Register before traversing dynamic imports: shared libraries can legitimately import each other.
    closure.paths.set(input.path, input.path)
    for (const imported of binary.imports) {
      let dependency: string
      if (closure.supply.target.operatingSystem === 'darwin') {
        if (!isAbsolute(imported))
          return yield* fail(
            imported,
            input.path,
            'Use an absolute SDK install-name; unresolved @rpath imports are not admitted.',
          )
        dependency = yield* stubPath(closure, imported, input.path)
      } else dependency = yield* locate(closure, imported, input.path)
      yield* addFile(closure, dependency, 'library', input.path)
    }
  } else {
    const source = new TextDecoder().decode(bytes)
    if (source.startsWith('--- !tapi-tbd')) {
      const parsed = NativeStub.parse(source)
      if (Result.isFailure(parsed)) return yield* fail(input.path, origin, parsed.failure)
      closure.paths.set(input.path, input.path)
      for (const imported of parsed.success.imports)
        yield* addFile(closure, yield* stubPath(closure, imported, input.path), 'stub', input.path)
    } else {
      if (
        !/\b(INPUT|GROUP|SECTIONS|INCLUDE|OUTPUT_FORMAT)\s*\(?/.test(source) ||
        source.includes('\0')
      )
        return yield* fail(
          input.path,
          origin,
          'Supply an admitted ELF/Mach-O object, archive, TAPI v4 stub, or GNU linker script.',
        )
      if (closure.supply.target.operatingSystem !== 'linux')
        return yield* fail(input.path, origin, 'GNU linker scripts require a GNU target.')
      closure.scriptModes.set(input.path, closure.mode)
      const parsed = LinkerScript.parse(source)
      if (Result.isFailure(parsed)) return yield* fail(input.path, origin, parsed.failure)
      const paths: Array<string> = []
      for (const reference of parsed.success.references) {
        const selected = yield* scriptPath(closure, reference.value, input.path, reference.kind)
        if (reference.kind === 'search') {
          closure.roots.push(selected)
          paths.push(selected)
        } else
          paths.push(
            yield* addFile(
              closure,
              selected,
              reference.kind === 'include' ? 'script' : 'library',
              input.path,
            ),
          )
      }
      const rewritten = join(closure.scope, `link-script-${closure.scripts.length}.ld`)
      closure.scripts.push({ path: rewritten, source: LinkerScript.render(parsed.success, paths) })
      closure.paths.set(input.path, rewritten)
    }
  }
  closure.active.delete(input.path)
  return closure.paths.get(input.path) ?? input.path
})

const stubPath = Effect.fnUntraced(function* (
  closure: Closure,
  name: string,
  origin: string,
): Effect.fn.Return<string, PlatformSupply.SupplyError, PlatformSupplyResolver.Services> {
  const path = join(closure.supply.root, name)
  for (const candidate of [path.replace(/\.dylib$/, '.tbd'), `${path}.tbd`, path])
    if (yield* PlatformSupplyResolver.exists(candidate)) return candidate
  return yield* PlatformSupply.failure(
    'MissingCapability',
    name,
    origin,
    'Provide the referenced SDK library/framework stub.',
  )
})

const singleValues = new Set([
  '-arch',
  '-o',
  '-e',
  '--entry',
  '-m',
  '-soname',
  '--soname',
  '-install_name',
  '-compatibility_version',
  '-current_version',
  '-macosx_version_min',
  '-sdk_version',
  '-z',
  '-rpath',
  '--rpath',
  '-mllvm',
])
const switches = new Set([
  '-EL',
  '-demangle',
  '--eh-frame-hdr',
  '-dynamic',
  '-static',
  '-pie',
  '-no_pie',
  '-shared',
  '-dylib',
  '-r',
  '-no_deduplicate',
  '-export_dynamic',
  '-Bstatic',
  '-Bdynamic',
  '--as-needed',
  '--no-as-needed',
  '--start-group',
  '--end-group',
  '--whole-archive',
  '--no-whole-archive',
  '--gc-sections',
  '--no-undefined',
  '--build-id',
  '--build-id=sha1',
  '--hash-style=gnu',
  '--hash-style=both',
  '--enable-new-dtags',
  '--no-add-needed',
  '--fatal-warnings',
  '-adhoc_codesign',
])

export interface Options {
  readonly translations?: NativeLinkPlan.NativeLinkPlan['translations']

  readonly kind: ToolchainPlan.NativeArtifactKind
  readonly profile: CompilationProfile.Facts
  readonly helpers?: ReadonlyArray<HelperCapability.Report>
  readonly objects: ReadonlyArray<string>
  readonly inputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>
  readonly output: string
  readonly scope: string
  readonly entry: NativeLinkPlan.NativeLinkPlan['entry']
}

/** Resolves every admitted linker input before publishing an identity or invoking final linking. */
export const resolvePlan = Effect.fn('NativeLinkResolver.resolvePlan')(function* (
  supply: PlatformSupply.PlatformSupply,
  options: Options,
): Effect.fn.Return<
  NativeLinkPlan.NativeLinkPlan,
  PlatformSupply.SupplyError,
  PlatformSupplyResolver.Services
> {
  const planned = ToolchainPlan.nativeCommand(
    { clang: supply.compiler.command, llvmAr: supply.archiver.command },
    options.kind,
    supply.target,
    options.objects,
    options.inputs,
    options.output,
    options.entry.resolved,
  )
  if (planned._tag === 'UnsupportedNativePlan')
    return yield* fail(
      planned.reason,
      'native input',
      'Use an input admitted by this target and artifact form.',
    )
  const userRoots: Array<string> = []
  for (const input of options.inputs)
    if (input._tag === 'SearchPath')
      userRoots.push(yield* PlatformSupplyResolver.physicalPath(input.path))
  const roots = [...userRoots, ...supply.libraryRoots]
  const closure: Closure = {
    supply,
    roots,
    mode: 'Dynamic',
    glibcVersion: undefined,
    inputs: [],
    scripts: [],
    paths: new Map(),
    scriptModes: new Map(),
    active: new Set(),
    scope: options.scope,
    directory: resolve('.'),
    userPaths: new Set([
      ...userRoots,
      ...options.objects.map((path) => resolve(path)),
      ...options.inputs.flatMap((input) => {
        const path = input._tag === 'SearchPath' ? input.path : NativeLinkInput.path(input)
        return path === undefined ? [] : [resolve(path)]
      }),
    ]),
  }
  yield* PlatformSupplyResolver.validateFiles([
    supply.compiler,
    supply.linker,
    supply.archiver,
    ...supply.files,
  ])
  let query: PlatformSupply.Query | undefined
  let raw: ReadonlyArray<string>
  if (options.kind === 'NativeStaticLibrary') raw = planned.arguments
  else {
    const args = [
      ...supply.compilationArguments,
      `--ld-path=${supply.linker.command}`,
      '-###',
      ...(supply.libc === 'none' ? ['-nostdlib'] : []),
      ...(options.profile.link === 'static' ? ['-static'] : []),
      ...(supply.target.operatingSystem === 'linux' &&
      options.profile.relocation === 'static' &&
      options.kind === 'NativeExecutable'
        ? ['-no-pie']
        : []),
      ...planned.arguments.filter((argument) => !argument.startsWith('--target=')),
    ]
    query = yield* PlatformSupplyResolver.query(
      supply.environment,
      supply.compiler.command,
      args,
      'final linker planning',
    )
    const lines = query.stderr.split('\n').filter((line) => /^\s*"/.test(line))
    if (lines.length !== 1)
      return yield* fail(
        query.stderr,
        'driver planning',
        'The admitted driver must produce exactly one linker invocation.',
      )
    const parsed = argumentsOf(lines[0] ?? '')
    if (Result.isFailure(parsed))
      return yield* fail(query.stderr, 'driver planning', parsed.failure)
    const [command, ...arguments_] = parsed.success
    if (command !== supply.linker.command)
      return yield* fail(
        command ?? '',
        'driver planning',
        'The driver must use the frozen selected linker.',
      )
    raw = arguments_
  }
  // All search directories apply to every -l, regardless of their argv position in GNU ld.
  for (let index = 0; index < raw.length; index += 1) {
    const argument = raw[index] ?? ''
    if (argument === '-L') {
      const path = raw[++index]
      if (path !== undefined) roots.push(path)
    } else if (argument.startsWith('-L')) roots.push(argument.slice(2))
  }
  const args: Array<string> = [],
    identityArgs: Array<string> = []
  let interpreter: string | undefined,
    staticMode: 'Static' | 'Dynamic' = 'Dynamic'
  const inputArgument = Effect.fnUntraced(function* (
    path: string,
    origin: string,
    role: PlatformSupply.Role,
  ) {
    const concrete = yield* addFile(closure, path, role, origin)
    args.push(concrete)
    const original =
      closure.inputs.find((item) => item.path === path) ??
      closure.inputs.find((item) => closure.paths.get(item.path) === concrete)
    if (original === undefined)
      return yield* fail(path, origin, 'Missing selected input accounting.')
    const binary = NativeInputFormat.inspect(
      yield* PlatformSupplyResolver.read(original.path, origin),
      supply.target,
    )
    // Shared inputs without SONAME/install-name embed the argument path in the final image.
    let embeddedPath = ''
    if (options.kind === 'NativeStaticLibrary') embeddedPath = basename(concrete)
    else if (binary?.kind === 'library' && binary.name === undefined) embeddedPath = concrete
    identityArgs.push(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
        'input',
        original.digest,
        embeddedPath,
      ]).pipe(Effect.orDie),
    )
  })
  for (let index = 0; index < raw.length; index += 1) {
    const argument = raw[index] ?? ''
    if (options.kind === 'NativeStaticLibrary') {
      if (index === 0) {
        args.push(argument)
        identityArgs.push(argument)
      } else if (index === 1) {
        args.push(argument)
        identityArgs.push('<output>')
      } else yield* inputArgument(argument, 'archive member', 'object')
      continue
    }
    if (
      argument === '-L' ||
      argument === '-F' ||
      argument === '-syslibroot' ||
      argument === '--sysroot'
    ) {
      const value = raw[++index]
      if (value === undefined) return yield* fail(argument, 'linker argv', 'Missing option value.')
      // Retain only the sysroot needed for target stub import resolution; named inputs are concrete.
      if (argument === '-syslibroot' || argument === '--sysroot') {
        args.push(argument, value)
        identityArgs.push(argument, '<supply>')
      }
      continue
    }
    if (argument.startsWith('-L') || argument.startsWith('-F')) continue
    if (argument.startsWith('--sysroot=')) {
      args.push(argument)
      identityArgs.push('--sysroot=<supply>')
      continue
    }
    if (argument.startsWith('-l') && argument !== '-lto_library') {
      yield* inputArgument(
        yield* locate(closure, argument, 'driver library', staticMode),
        argument,
        'library',
      )
      continue
    }
    if (argument === '-framework') {
      const name = raw[++index]
      if (name === undefined) return yield* fail(argument, 'linker argv', 'Missing framework name.')
      const selected = yield* stubPath(
        closure,
        `/System/Library/Frameworks/${name}.framework/${name}`,
        `framework ${name}`,
      )
      yield* inputArgument(selected, `framework ${name}`, 'framework')
      continue
    }
    if (argument === '-dynamic-linker' || argument === '--dynamic-linker') {
      interpreter = raw[++index]
      if (interpreter === undefined || !isAbsolute(interpreter))
        return yield* fail(argument, 'linker argv', 'An absolute interpreter path is required.')
      yield* addFile(closure, join(supply.root, interpreter), 'interpreter', 'dynamic loader')
      args.push(argument, interpreter)
      identityArgs.push(argument, interpreter)
      continue
    }
    if (
      argument === '-T' ||
      argument === '--script' ||
      argument === '-lto_library' ||
      argument === '-plugin'
    ) {
      const path = raw[++index]
      if (path === undefined) return yield* fail(argument, 'linker argv', 'Missing input path.')
      if (argument === '-plugin')
        return yield* fail(path, 'linker plugin', 'LTO plugins are not admitted.')
      args.push(argument)
      identityArgs.push(argument)
      if (argument === '-lto_library') {
        // No bitcode reaches this linker: remove Clang's unused LTO-loader option entirely.
        args.pop()
        identityArgs.pop()
        continue
      }
      yield* inputArgument(path, argument, 'script')
      continue
    }
    if (argument === '-platform_version') {
      const platform = raw[++index],
        minimum = raw[++index],
        sdk = raw[++index]
      if (
        platform !== 'macos' ||
        minimum === undefined ||
        sdk === undefined ||
        minimum !== supply.deployment ||
        sdk !== supply.version
      )
        return yield* PlatformSupply.failure(
          'DeploymentMismatch',
          `${platform}/${minimum}/${sdk}`,
          'driver plan',
          'The driver must preserve the selected SDK and deployment.',
        )
      args.push(argument, platform, minimum, sdk)
      identityArgs.push(argument, platform, minimum, sdk)
      continue
    }
    if (singleValues.has(argument)) {
      const value = raw[++index]
      if (value === undefined) return yield* fail(argument, 'linker argv', 'Missing option value.')
      args.push(argument, value)
      identityArgs.push(argument, argument === '-o' ? '<output>' : value)
      continue
    }
    if (switches.has(argument)) {
      if (argument === '-Bstatic') {
        staticMode = 'Static'
        closure.mode = 'Static'
      }
      if (argument === '-Bdynamic') {
        staticMode = 'Dynamic'
        closure.mode = 'Dynamic'
      }
      args.push(argument)
      identityArgs.push(argument)
      continue
    }
    if (argument.startsWith('-') || argument.startsWith('@'))
      return yield* fail(
        argument,
        'linker argv',
        'Use an admitted structured native input; this linker option is unsupported.',
      )
    yield* inputArgument(
      argument,
      'driver input',
      /(?:^|\/)\w*crt\w*\.o$/.test(argument) ? 'crt' : 'object',
    )
  }
  if (
    supply.libc === 'gnu' &&
    options.kind !== 'NativeStaticLibrary' &&
    options.kind !== 'NativeObject' &&
    options.profile.link !== 'static' &&
    closure.glibcVersion === undefined
  )
    return yield* PlatformSupply.failure(
      'MissingCapability',
      'glibc',
      supply.root,
      'Provide the GNU glibc link contract.',
    )
  const resolvedSupply = {
    ...supply,
    version: closure.glibcVersion ?? supply.version,
  }
  if (supply.target.operatingSystem === 'linux') {
    const dependencyRoots = [
      ...new Set(
        closure.inputs
          .filter((input) => input.role === 'library')
          .map((input) => dirname(input.path)),
      ),
    ]
    for (const root of dependencyRoots) args.push('-rpath-link', root)
  }
  const identity = PlatformSupplyResolver.digest(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
      'native-link-v2',
      (options.helpers ?? []).map((report) => report.identity),
      supply.target.id,
      options.kind,
      options.entry,
      supply.deployment,
      resolvedSupply.version,
      (options.kind === 'NativeStaticLibrary' ? supply.archiver : supply.linker).digest,
      identityArgs,
      closure.inputs.map((input) => input.digest),
      supply.files.map((input) => input.digest),
    ]).pipe(Effect.orDie),
  )
  return {
    _tag: 'NativeLinkPlan',
    helpers: [...(options.helpers ?? [])],
    translations: [...(options.translations ?? [])],
    kind: options.kind,
    supply: resolvedSupply,
    command: {
      _tag: 'PlannedCommand',
      target: supply.target,
      command:
        options.kind === 'NativeStaticLibrary' ? supply.archiver.command : supply.linker.command,
      arguments: args,
    },
    query,
    inputs: closure.inputs,
    scripts: closure.scripts,
    identity,
    entry: options.entry,
    interpreter,
    output: options.output,
  }
})
