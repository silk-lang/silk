/** The provenance of the exact bytes held by one analyzed source snapshot. */
export type SourceOrigin =
  | { readonly _tag: 'ProjectFile'; readonly path: string }
  | { readonly _tag: 'ToolchainFile'; readonly uri: string }
  | { readonly _tag: 'Memory'; readonly uri?: string }

/** Identifies source bytes read from one project-owned file. */
export const projectFile = (path: string): SourceOrigin => ({ _tag: 'ProjectFile', path })

/** Identifies source bytes shipped as part of the active compiler toolchain. */
export const toolchainFile = (uri: string): SourceOrigin => ({ _tag: 'ToolchainFile', uri })

/** Identifies caller-supplied bytes, optionally associated with a real editor document URI. */
export const memory = (uri?: string): SourceOrigin =>
  uri === undefined ? { _tag: 'Memory' } : { _tag: 'Memory', uri }

/** Tests structural equality of two source origins. */
export const equals = (self: SourceOrigin, other: SourceOrigin): boolean => {
  if (self._tag !== other._tag) return false
  switch (self._tag) {
    case 'ProjectFile':
      return other._tag === 'ProjectFile' && self.path === other.path
    case 'ToolchainFile':
      return other._tag === 'ToolchainFile' && self.uri === other.uri
    case 'Memory':
      return other._tag === 'Memory' && self.uri === other.uri
  }
}
