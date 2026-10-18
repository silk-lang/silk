import type * as Handle from './Handle.js'

/**
 * Opaque builder-owned identity for a metadata string, tuple, constant, or debug node.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface Metadata extends Handle.Handle<'Metadata'> {}
