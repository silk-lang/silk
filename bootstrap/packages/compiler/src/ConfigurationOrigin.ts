import type * as SourceSpan from './SourceSpan.js'

/** How an explicit build input was obtained; classified before its value is inspected. */
export type Provenance = 'literal' | 'translated-public' | 'secret' | 'physical-supply' | 'runtime'

/** A current-request diagnostic origin, deliberately excluded from semantic profile identity. */
export interface ConfigurationOrigin {
  readonly source: string
  readonly provenance: Provenance
  readonly translator?: string
  readonly span?: SourceSpan.SourceSpan
}

/** Copies provenance so a caller cannot mutate a published diagnostic's origin. */
export const snapshot = (self: ConfigurationOrigin): ConfigurationOrigin => ({ ...self })

/** An explicit logical request without a source span. */
export const literal = (source: string): ConfigurationOrigin => ({ source, provenance: 'literal' })

/** Whether a value is permitted to enter static configuration at all. */
export const isPublic = (self: ConfigurationOrigin): boolean =>
  self.provenance === 'literal' ||
  (self.provenance === 'translated-public' &&
    self.translator !== undefined &&
    self.translator.length > 0)
