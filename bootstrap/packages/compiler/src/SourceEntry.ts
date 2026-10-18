import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Path from 'effect/Path'
import * as SourceResolver from './SourceResolver.js'

/**
 * A project's explicit root source. A physical path is not a module identity: this actor normalizes
 * the selected source root, verifies that the entry is below it, and derives the canonical
 * extensionless identity used by the compiler.
 */

/** One selected entry path and its canonical module identity; source bytes are resolver-owned. */
export interface SourceEntry {
  readonly _tag: 'SourceEntry'
  readonly module: string
  readonly path: string
  readonly sourceRoot: string
}

/** The selected path yields no valid canonical module identity. */
export class SourceEntryError extends Data.TaggedError('SourceEntryError')<{
  readonly operation: 'SourceEntry.select'
  readonly path: string
  readonly message: string
  readonly reason:
    | { readonly _tag: 'InvalidIdentity' }
    | { readonly _tag: 'OutsideSourceRoot'; readonly sourceRoot: string }
}> {}

/**
 * Derives a canonical module identity from a relative file path by dropping its exact `.silk`
 * suffix.
 * Uses the same canonical-identity rule as compiler requests.
 */
export const identify = (relativePath: string, separator = '/'): string | undefined => {
  if (!relativePath.endsWith('.silk')) return undefined
  const extensionless = relativePath.slice(0, -'.silk'.length)
  const module = extensionless.split(separator).join('/')
  return SourceResolver.isCanonicalModule(module) ? module : undefined
}

/** Selects an entry path and identity without accessing its source bytes. */
export const select = Effect.fn('SourceEntry.select')(function* (
  file: string,
  selectedSourceRoot?: string,
): Effect.fn.Return<SourceEntry, SourceEntryError, Path.Path> {
  const path = yield* Path.Path

  const absoluteFile = path.resolve(file)
  const sourceRoot = path.resolve(selectedSourceRoot ?? path.dirname(absoluteFile))
  const relative = path.relative(sourceRoot, absoluteFile)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return yield* new SourceEntryError({
      operation: 'SourceEntry.select',
      path: absoluteFile,
      message: `Source entry ${absoluteFile} is outside source root ${sourceRoot}`,
      reason: { _tag: 'OutsideSourceRoot', sourceRoot },
    })
  }
  const module = identify(relative, path.sep)
  if (module === undefined) {
    return yield* new SourceEntryError({
      operation: 'SourceEntry.select',
      path: absoluteFile,
      message: `Source entry ${absoluteFile} must be a canonical relative path ending in .silk`,
      reason: { _tag: 'InvalidIdentity' },
    })
  }

  return {
    _tag: 'SourceEntry' as const,
    module,
    path: absoluteFile,
    sourceRoot,
  }
})
