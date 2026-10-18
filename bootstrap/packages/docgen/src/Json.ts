import * as Schema from 'effect/Schema'
import type * as Project from './Project.js'

const DocumentationJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })
const encodeUnknown = Schema.encodeSync(DocumentationJson)

/** Encodes the canonical experimental documentation artifact deterministically. */
export const encode = (self: Project.Project): string => `${encodeUnknown(self)}\n`

/** Encodes an unknown JSON-compatible value with the documentation artifact formatting. */
export const encodeValue = (value: unknown): string => `${encodeUnknown(value)}\n`

/** Decodes an untrusted JSON string before its documentation shape is validated. */
export const decode = Schema.decodeUnknownEffect(DocumentationJson)

/** Decodes JSON synchronously for tests and other already-synchronous boundaries. */
export const decodeSync = Schema.decodeUnknownSync(DocumentationJson)
