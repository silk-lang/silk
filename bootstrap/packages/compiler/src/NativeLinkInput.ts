/** Whether a named native library must be selected statically or dynamically. */
export type LibraryMode = 'Static' | 'Dynamic'

/** One ordered, structured native tool input. Raw linker arguments are intentionally absent. */
export type NativeLinkInput =
  | { readonly _tag: 'Object'; readonly path: string }
  | { readonly _tag: 'LinkerScript'; readonly path: string }
  | { readonly _tag: 'StaticArchive'; readonly path: string }
  | { readonly _tag: 'Library'; readonly name: string; readonly mode: LibraryMode }
  | { readonly _tag: 'SearchPath'; readonly path: string }
  | { readonly _tag: 'Framework'; readonly name: string }

export const object = (path: string): NativeLinkInput => ({ _tag: 'Object', path })

export const linkerScript = (path: string): NativeLinkInput => ({ _tag: 'LinkerScript', path })

export const staticArchive = (path: string): NativeLinkInput => ({ _tag: 'StaticArchive', path })

export const library = (name: string, mode: LibraryMode): NativeLinkInput => ({
  _tag: 'Library',
  name,
  mode,
})

export const searchPath = (path: string): NativeLinkInput => ({ _tag: 'SearchPath', path })

export const framework = (name: string): NativeLinkInput => ({ _tag: 'Framework', name })

/** Whether every path carried by the input is absolute and therefore cannot be a tool option. */
export const hasAbsolutePath = (self: NativeLinkInput): boolean => {
  if (self._tag === 'Library' || self._tag === 'Framework') return true
  return (
    self.path.startsWith('/') || self.path.startsWith('\\\\') || /^[A-Za-z]:[/\\]/.test(self.path)
  )
}

/** Reads the filesystem path carried by a path-backed input. */
export const path = (self: NativeLinkInput): string | undefined =>
  self._tag === 'Object' || self._tag === 'StaticArchive' || self._tag === 'LinkerScript'
    ? self.path
    : undefined

const part = (value: string): string => `${new TextEncoder().encode(value).length}:${value}`

/** Injective deterministic encoding for cache identities and inspection. */
export const encode = (self: NativeLinkInput): string => {
  switch (self._tag) {
    case 'LinkerScript':
      return `linker-script:${part(self.path)}`
    case 'Object':
      return `object:${part(self.path)}`
    case 'StaticArchive':
      return `static-archive:${part(self.path)}`
    case 'Library':
      return `library:${self.mode.toLowerCase()}:${part(self.name)}`
    case 'SearchPath':
      return `search-path:${part(self.path)}`
    case 'Framework':
      return `framework:${part(self.name)}`
  }
}
