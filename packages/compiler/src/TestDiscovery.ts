import * as Effect from 'effect/Effect'
import * as AuthoredEncoding from './AuthoredEncoding.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as AuthoredLowering from './AuthoredLowering.js'
import * as Canonical from './internal/Canonical.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as Elaboration from './Elaboration.js'
import type * as ModuleClosure from './ModuleClosure.js'
import * as SemanticContext from './SemanticContext.js'
import * as Type from './Type.js'

/** Authoritative ownership and logical path for a source supply that is not a project file. */
export interface Source {
  readonly ownership: 'Project' | 'Dependency'
  readonly logicalPath: string
}

/** The independent root and source-identity policy used by static test discovery. */
export interface Request {
  readonly root: string
  /** Project-relative directory containing canonical module paths. */
  readonly logicalRoot?: string
  /** Explicit facts for in-memory, dependency, or nonstandard source supplies. */
  readonly sources?: ReadonlyMap<string, Source>
}

/** Runtime metadata projected from one phase-only test descriptor. */
export interface Info {
  readonly identity: string
  readonly name: string
  readonly module: string
  readonly path: string
  readonly line: number
  readonly column: number
  readonly fingerprint: string
}

/** One compiler-issued descriptor payload. It never has a runtime representation. */
export interface Entry {
  readonly declaration: DeclarationFacts.DeclarationFact
  readonly callable: Type.Callable
  readonly info: Info
}

/** A root-scoped, canonical-order catalog sealed into one frontend. */
export interface Catalog {
  readonly _tag: 'TestCatalog'
  readonly request: Request
  readonly entries: ReadonlyArray<Entry>
  readonly identity: string
}

const encoder = new TextEncoder()

const frame = (bytes: ReadonlyArray<number>): ReadonlyArray<number> => {
  const length = bytes.length
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...bytes,
  ]
}

/** Versioned, domain-separated digest of exactly one declaration's authored header and body. */
export const fingerprint = Effect.fn('TestDiscovery.fingerprint')(function* (
  result: Elaboration.Result,
  declaration: DeclarationFacts.DeclarationFact,
): Effect.fn.Return<string, AuthoredEncoding.AuthoredEncodingError> {
  const authored = AuthoredLowering.declarationOf(result.authored, declaration.owner)
  if (authored === undefined)
    return yield* new AuthoredEncoding.AuthoredEncodingError({
      reason: { _tag: 'InvalidArtifact', message: 'Test declaration has no authored owner' },
    })
  const header = yield* AuthoredEncoding.header(result.authored.module.pool, authored)
  const body = yield* AuthoredEncoding.body(result.authored.module.pool, authored)
  const domain = Array.from(encoder.encode('silk:test-fingerprint:v1'))
  const digest = yield* AuthoredEncoding.digest([
    ...frame(domain),
    ...frame(header),
    ...frame(body),
  ])
  return `silk-test-v1:${digest}`
})

const reachableModules = (root: string, closure: ModuleClosure.Facts): ReadonlySet<string> => {
  const modules = new Map(closure.modules.map((module) => [module.name, module]))
  const reached = new Set<string>()
  const pending = [root]
  while (pending.length > 0) {
    pending.sort(Canonical.compare)
    const name = pending.shift()
    if (name === undefined || reached.has(name)) continue
    const module = modules.get(name)
    if (module === undefined) continue
    reached.add(name)
    for (const fact of module.imports) {
      if (fact.target._tag !== 'Resolved') continue
      if (!reached.has(fact.target.module) && !pending.includes(fact.target.module))
        pending.push(fact.target.module)
    }
  }
  return reached
}

const normalizeLogicalPath = (value: string): string =>
  value
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/')

const sourceOf = (request: Request, module: ModuleClosure.Module): Source | undefined => {
  const supplied = request.sources?.get(module.name)
  if (supplied !== undefined)
    return { ...supplied, logicalPath: normalizeLogicalPath(supplied.logicalPath) }
  if (module.syntax.source.origin._tag !== 'ProjectFile') return undefined
  const prefix = request.logicalRoot === undefined ? '' : normalizeLogicalPath(request.logicalRoot)
  return {
    ownership: 'Project',
    logicalPath: `${prefix.length === 0 ? '' : `${prefix}/`}${module.name}.silk`,
  }
}

const callableType = (declaration: DeclarationFacts.DeclarationFact): Type.Callable => {
  const contract = DeclarationFacts.callableContract(declaration)
  return Type.callable(
    contract.parameters.map((parameter) => parameter.type),
    contract.result,
    contract,
    'Shared',
    undefined,
    contract.unsafe,
  )
}

/** Offsets just past each newline of one source; line `n` (1-based) starts at entry `n - 1`. */
const lineStarts = (bytes: Uint8Array): ReadonlyArray<number> => {
  const starts = [0]
  for (let index = 0; index < bytes.length; index += 1)
    if (bytes[index] === 0x0a) starts.push(index + 1)
  return starts
}

/**
 * The 1-based line and column of one test declaration. Rescanning the source from its start for
 * every test cost 13 s on the selfhost semantic root, so each module's line starts are built once.
 */
const position = (
  module: ModuleClosure.Module,
  starts: ReadonlyArray<number>,
  declaration: DeclarationFacts.DeclarationFact,
): { readonly line: number; readonly column: number } => {
  const offset = SemanticContext.make(module.authored).spanOf(declaration.anchor).start
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((starts[middle] ?? 0) <= offset) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 }
}

const compareEntries = (left: Entry, right: Entry): number => {
  const module = Canonical.compare(left.info.module, right.info.module)
  if (module !== 0) return module
  const name = Canonical.compare(left.info.name, right.info.name)
  return name !== 0 ? name : Canonical.compare(left.info.identity, right.info.identity)
}

/** Builds the project-owned test catalog after module selection and complete header analysis. */
export const make = Effect.fn('TestDiscovery.make')(function* (
  request: Request,
  closure: ModuleClosure.Facts,
  index: DeclarationIndex.Index,
  results: ReadonlyMap<string, Elaboration.Result>,
): Effect.fn.Return<Catalog, AuthoredEncoding.AuthoredEncodingError> {
  const reachable = reachableModules(request.root, closure)
  const modules = new Map(closure.modules.map((module) => [module.name, module]))
  const entries: Array<Entry> = []
  for (const headers of index.modules) {
    if (!reachable.has(headers.module)) continue
    const module = modules.get(headers.module)
    const source = module === undefined ? undefined : sourceOf(request, module)
    const result = results.get(headers.module)
    if (module === undefined || source?.ownership !== 'Project' || result === undefined) continue
    let starts: ReadonlyArray<number> | undefined
    for (const declaration of headers.declarations) {
      if (!declaration.test || declaration.canonical._tag !== 'Canonical') continue
      if (declaration.name._tag !== 'Present') continue
      starts ??= lineStarts(module.syntax.source.bytes)
      const location = position(module, starts, declaration)
      entries.push({
        declaration,
        callable: callableType(declaration),
        info: {
          identity: AuthoredIdentity.key(declaration.owner),
          name: declaration.name.spelling,
          module: headers.module,
          path: source.logicalPath,
          line: location.line,
          column: location.column,
          fingerprint: yield* fingerprint(result, declaration),
        },
      })
    }
  }
  entries.sort(compareEntries)
  const frozen = entries
  return {
    _tag: 'TestCatalog',
    request: {
      ...request,
      ...(request.sources === undefined ? {} : { sources: new Map(request.sources) }),
    },
    entries: frozen,
    identity: Canonical.record('TestCatalog.v1', [
      request.root,
      request.logicalRoot ?? '',
      Canonical.array(
        frozen.map((entry) =>
          Canonical.record('Test', [
            entry.info.identity,
            entry.info.name,
            entry.info.module,
            entry.info.path,
            String(entry.info.line),
            String(entry.info.column),
            entry.info.fingerprint,
            Type.key(entry.callable),
          ]),
        ),
      ),
    ]),
  }
})
