import type * as Backend from '@silklang/compiler/Backend'
import type * as Diagnostic from '@silklang/compiler/Diagnostic'
import type * as Driver from '@silklang/compiler/Driver'
import * as FileSourceResolver from '@silklang/compiler/FileSourceResolver'
import type * as Mir from '@silklang/compiler/Mir'
import type * as NativeToolchain from '@silklang/compiler/NativeToolchain'
import * as SourceFile from '@silklang/compiler/SourceFile'
import type * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as ToolchainIntegrity from '@silklang/compiler/ToolchainIntegrity'
import type * as Path from 'effect/Path'

/**
 * Terminal rendering of driver outcomes: diagnostics, per-phase timings, and failure provenance.
 * Pure string building over the driver's closed outcome data — nothing here performs effects, so
 * the exact text a run prints is directly assertable in tests.
 */

/** Where a byte offset falls in a source, in the 1-based terms editors and humans use. */
export interface Position {
  readonly line: number
  readonly column: number
}

/** Physical display path and exact bytes for one loaded canonical module. */
export interface DisplaySource {
  readonly path: string
  readonly bytes: Uint8Array
}

/** Loaded sources keyed by the diagnostic source identities they own. */
export type SourceCatalog = ReadonlyMap<string, DisplaySource>

/** Builds display locations for the canonical modules loaded through one filesystem resolver. */
export const catalog = (
  resolver: FileSourceResolver.FileSourceResolver,
  sources: ReadonlyMap<string, SourceFile.SourceFile>,
  path: Path.Path,
): SourceCatalog =>
  new Map(
    [...sources].map(([module, source]) => [
      module,
      {
        path: FileSourceResolver.sourcePath(resolver, module, path),
        bytes: SourceFile.toUint8Array(source),
      },
    ]),
  )

const lineFeed = 0x0a

/**
 * Converts a byte offset into a 1-based line and column. Diagnostic spans are byte offsets into
 * the source, but a byte offset is not actionable in a terminal; a file:line:column prefix is.
 * Columns count bytes, matching the compiler's byte-oriented spans.
 */
export const positionAt = (bytes: Uint8Array, offset: number): Position => {
  const bounded = Math.max(0, Math.min(offset, bytes.length))
  let line = 1
  let lineStart = 0
  for (let index = 0; index < bounded; index += 1) {
    if (bytes[index] === lineFeed) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: bounded - lineStart + 1 }
}

/** Renders one diagnostic as a `path:line:column: severity[CODE] message` line with its notes. */
export const diagnostic = (self: Diagnostic.Diagnostic, sources: SourceCatalog): string => {
  const source = sources.get(self.span.sourceId)
  if (source === undefined) {
    return `${self.span.sourceId}:?:?: ${self.severity}[${self.code}] ${self.message}`
  }
  const at = positionAt(source.bytes, self.span.start)
  const head = `${source.path}:${at.line}:${at.column}: ${self.severity}[${self.code}] ${self.message}`
  const notes = (self.notes ?? []).map((note) => `  note: ${note}`)
  return [head, ...notes].join('\n')
}

/** Renders every diagnostic of one run, in the order the driver published them. */
export const diagnostics = (
  self: ReadonlyArray<Diagnostic.Diagnostic>,
  sources: SourceCatalog,
): string => self.map((entry) => diagnostic(entry, sources)).join('\n')

const milliseconds = (value: number): string => `${value.toFixed(1)}ms`

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`

/** Renders the per-phase timing table the driver records for every run. */
export const phases = (self: ReadonlyArray<Driver.DriverPhaseReport>): string => {
  const rows = self.map((entry) => ({
    phase: entry.phase,
    elapsed: milliseconds(entry.elapsedMs),
    counts: `${entry.inputs} in / ${entry.outputs} out`,
    diagnostics: `${entry.diagnostics} diag`,
    heap: megabytes(entry.heapBytes),
  }))
  const width = rows.reduce((widest, row) => Math.max(widest, row.phase.length), 0)
  return rows
    .map(
      (row) =>
        `  ${row.phase.padEnd(width)}  ${row.elapsed.padStart(8)}  ${row.counts}  ${row.diagnostics}  heap ${row.heap}`,
    )
    .join('\n')
}

/**
 * Renders a native toolchain failure with the exact command that failed. The driver keeps full
 * command provenance precisely so a build failure is reproducible by hand; dropping it here would
 * waste the only information that makes a linker error debuggable.
 */
export const toolchainError = (failure: NativeToolchain.ToolchainError): string => {
  if (failure.reason._tag === 'SupplyFailed') {
    const supply = failure.reason.failure
    return `${supply.message}\n${supply.correction}${supply.query === undefined ? '' : `\n${supply.query.stderr}`}`
  }
  if (failure.reason._tag === 'HelperFailed') {
    return `${failure.stage} stage failed: ${failure.message}`
  }
  if (failure.reason._tag === 'StorageFailed') {
    return `${failure.stage} stage failed: ${failure.message}`
  }
  if (failure.reason._tag === 'UnsupportedPlan' || failure.reason._tag === 'InvalidPackageName') {
    return `${failure.stage} stage failed: ${failure.message}`
  }
  const command = [failure.reason.planned.command, ...failure.reason.planned.arguments].join(' ')
  const reason =
    failure.reason.status === null
      ? failure.message
      : `process exited with status ${failure.reason.status}`
  return [
    `${failure.stage} stage failed: ${reason}`,
    `  command: ${command}`,
    ...(failure.reason.output.trim().length > 0
      ? failure.reason.output
          .trimEnd()
          .split('\n')
          .map((line) => `  | ${line}`)
      : []),
  ].join('\n')
}

/** Renders one MIR violation as a diagnostic-style `path:line:column` line with rule and detail. */
const mirViolation = (violation: Mir.Violation, sources: SourceCatalog): string => {
  const owner =
    violation.function === undefined
      ? ''
      : ` (in ${violation.function.module}.${violation.function.name})`
  const body = `error[${violation.rule}] ${violation.detail}${owner}`
  const span = violation.provenance?.span
  if (span === undefined) return `  ${body}`
  const source = sources.get(span.sourceId)
  if (source === undefined) return `  ${span.sourceId}:?:?: ${body}`
  const at = positionAt(source.bytes, span.start)
  return `  ${source.path}:${at.line}:${at.column}: ${body}`
}

/**
 * Renders a backend failure with its structured reason. The backend records exactly which MIR
 * capability diagnostics stopped emission; printing only the summary message would
 * leave the user with nothing actionable.
 */
export const backendError = (self: Backend.BackendError, sources: SourceCatalog): string => {
  const head = `Backend error: ${self.message}`
  switch (self.reason._tag) {
    case 'UnsupportedIntrinsic':
    case 'UnsupportedForeignFunction': {
      const rendered = diagnostics(self.reason.diagnostics, sources)
      return rendered.length > 0 ? [head, rendered].join('\n') : head
    }
    default:
      return head
  }
}

/** The human-readable summary of one outcome, excluding the phase table. */
export const outcome = (
  self: Driver.Outcome,
  sources: SourceCatalog,
  entryPath: string,
  displayPath: (value: string) => string = (value) => value,
): string => {
  switch (self._tag) {
    case 'Compiled': {
      const rendered = diagnostics(self.diagnostics, sources)
      return [
        ...(rendered.length > 0 ? [rendered] : []),
        `Compiled ${displayPath(entryPath)} -> ${displayPath(self.path)} (${self.backend}, ${self.target.id}, ${self.symbols.length} symbols)`,
        ...(self.libraryInterface === undefined
          ? []
          : [
              `C header: ${displayPath(self.libraryInterface.cHeader)}`,
              `ABI manifest: ${displayPath(self.libraryInterface.abiManifest)}`,
            ]),
      ].join('\n')
    }
    case 'TargetFailed': {
      const rendered = diagnostics(self.diagnostics, sources)
      return [
        ...(rendered.length > 0 ? [rendered] : []),
        `Target error: ${self.error.message}`,
      ].join('\n')
    }
    case 'VerificationFailed': {
      const rendered = diagnostics(self.diagnostics, sources)
      return [
        ...(rendered.length > 0 ? [rendered] : []),
        `Verification error: ${self.error.message}`,
        ...self.error.violations.map((violation) => mirViolation(violation, sources)),
      ].join('\n')
    }
    case 'BackendFailed': {
      const rendered = diagnostics(self.diagnostics, sources)
      return [...(rendered.length > 0 ? [rendered] : []), backendError(self.error, sources)].join(
        '\n',
      )
    }
    case 'ToolchainFailed':
      return [
        `Broken toolchain: expected ${self.expectedIdentity}, observed ${self.observedIdentity}`,
        ...self.failures.map((failure) => `  ${ToolchainIntegrity.formatFailure(failure)}`),
      ].join('\n')
    case 'Rejected':
      return diagnostics(self.diagnostics, sources)
  }
}

/** Renders a typed source-resolution failure with every safe frontend diagnostic. */
export const sourceResolutionFailed = (
  self: Driver.SourceResolutionFailed,
  sources: SourceCatalog,
): string => {
  const renderedDiagnostics = diagnostics(self.diagnostics, sources)
  const failures = resolutionFailures(self.failures)
  return [...(renderedDiagnostics.length > 0 ? [renderedDiagnostics] : []), ...failures].join('\n')
}

/** Renders operational source resolver failures independently of any strict driver outcome. */
export const resolutionFailures = (
  self: ReadonlyArray<SourceResolver.SourceResolverError>,
): ReadonlyArray<string> =>
  self.map((failure) => `Source resolution error [${failure.module}]: ${failure.message}`)

/** Whether an outcome represents a successful compilation, deciding the process exit status. */
export const succeeded = (self: Driver.Outcome): self is Driver.Compiled => self._tag === 'Compiled'
