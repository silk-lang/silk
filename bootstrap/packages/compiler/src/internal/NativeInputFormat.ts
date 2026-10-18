import type * as Target from '../Target.js'

export interface Binary {
  readonly kind: 'object' | 'library' | 'archive'
  readonly compatible: boolean
  readonly imports: ReadonlyArray<string>
  readonly name: string | undefined
  readonly versions: ReadonlyArray<string>
  readonly providedVersions?: ReadonlyArray<string>
}

const decoder = new TextDecoder()
const text = (bytes: Uint8Array, start: number, length: number): string =>
  decoder.decode(bytes.subarray(start, start + length))
const word = (
  bytes: Uint8Array,
  offset: number,
  size: 2 | 4,
  little = true,
): number | undefined => {
  if (offset < 0 || offset + size > bytes.length) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return size === 2 ? view.getUint16(offset, little) : view.getUint32(offset, little)
}
const wide = (bytes: Uint8Array, offset: number): number | undefined => {
  const low = word(bytes, offset, 4),
    high = word(bytes, offset + 4, 4)
  if (low === undefined || high === undefined) return undefined
  const value = low + high * 0x100000000
  return Number.isSafeInteger(value) ? value : undefined
}
const cstring = (bytes: Uint8Array, offset: number): string => {
  const end = bytes.indexOf(0, offset)
  return text(bytes, offset, (end < 0 ? bytes.length : end) - offset)
}
const invalid: Binary = {
  kind: 'object',
  compatible: false,
  imports: [],
  name: undefined,
  versions: [],
}

/** Reads only the format facts used by supply compatibility; symbol resolution belongs to the linker. */
export const inspect = (bytes: Uint8Array, target: Target.Target): Binary | undefined => {
  if (text(bytes, 0, 8) === '!<arch>\n') {
    let offset = 8,
      members = 0
    while (offset + 60 <= bytes.length) {
      const name = text(bytes, offset, 16).trim()
      const size = Number(text(bytes, offset + 48, 10).trim())
      if (!Number.isSafeInteger(size) || size < 0 || offset + 60 + size > bytes.length)
        return invalid
      const extended = name.startsWith('#1/') ? Number(name.slice(3)) : 0
      if (!Number.isSafeInteger(extended) || extended < 0 || extended > size) return invalid
      const memberName = extended > 0 ? text(bytes, offset + 60, extended) : name
      if (!['/', '//', '/SYM64/'].includes(memberName) && !memberName.startsWith('__.SYMDEF')) {
        const member = inspect(bytes.subarray(offset + 60 + extended, offset + 60 + size), target)
        if (member?.compatible !== true) return invalid
        members += 1
      }
      offset += 60 + size + (size % 2)
    }
    return {
      kind: 'archive',
      compatible: offset === bytes.length && members > 0,
      imports: [],
      name: undefined,
      versions: [],
    }
  }
  // Universal Mach-O archives/objects select exactly the requested architecture slice.
  if (word(bytes, 0, 4, false) === 0xcafebabe) {
    const count = word(bytes, 4, 4, false) ?? 0
    if (count > (bytes.length - 8) / 20) return invalid
    for (let index = 0; index < count; index += 1) {
      const at = 8 + index * 20
      if (word(bytes, at, 4, false) !== 0x100000c) continue
      const offset = word(bytes, at + 8, 4, false),
        size = word(bytes, at + 12, 4, false)
      if (offset === undefined || size === undefined || offset + size > bytes.length) return invalid
      return inspect(bytes.subarray(offset, offset + size), target)
    }
    return invalid
  }
  if (word(bytes, 0, 4) === 0xfeedfacf) {
    if (target.operatingSystem !== 'darwin' || word(bytes, 4, 4) !== 0x100000c) return invalid
    const fileType = word(bytes, 12, 4)
    if (fileType !== 1 && fileType !== 6) return invalid
    const kind = fileType === 1 ? 'object' : 'library'
    const count = word(bytes, 16, 4) ?? 0
    const imports: Array<string> = [],
      versions: Array<string> = []
    let offset = 32,
      name: string | undefined
    for (let index = 0; index < count; index += 1) {
      const command = word(bytes, offset, 4),
        size = word(bytes, offset + 4, 4)
      if (size === undefined || size < 8 || offset + size > bytes.length) return invalid
      if ([0xc, 0xd, 0x80000018, 0x8000001f, 0x80000023].includes(command ?? 0)) {
        const start = word(bytes, offset + 8, 4)
        if (start === undefined || start >= size) return invalid
        const value = cstring(bytes.subarray(0, offset + size), offset + start)
        if (command === 0xd) name = value
        else imports.push(value)
      }
      if (command === 0x32 || command === 0x24) {
        const value = word(bytes, offset + (command === 0x32 ? 12 : 8), 4)
        if (value !== undefined)
          versions.push(`${value >>> 16}.${(value >>> 8) & 255}.${value & 255}`)
      }
      offset += size
    }
    return { kind, compatible: true, imports, name, versions }
  }
  if (text(bytes, 0, 4) !== '\u007fELF') return undefined
  if (
    target.operatingSystem !== 'linux' ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    word(bytes, 18, 2) !== (target.architecture === 'aarch64' ? 183 : 62)
  )
    return invalid
  const fileType = word(bytes, 16, 2)
  if (fileType !== 1 && fileType !== 3) return invalid
  const kind = fileType === 1 ? 'object' : 'library'
  const sectionOffset = wide(bytes, 40),
    entrySize = word(bytes, 58, 2),
    count = word(bytes, 60, 2)
  if (count === 0 && kind === 'object') return { ...invalid, compatible: true }
  if (
    sectionOffset === undefined ||
    entrySize === undefined ||
    count === undefined ||
    entrySize < 64 ||
    sectionOffset + entrySize * count > bytes.length
  )
    return invalid
  const imports: Array<string> = [],
    versions: Array<string> = [],
    providedVersions: Array<string> = []
  let name: string | undefined
  for (let index = 0; index < count; index += 1) {
    const at = sectionOffset + index * entrySize,
      type = word(bytes, at + 4, 4)
    if (type !== 6 && type !== 0x6ffffffe && type !== 0x6ffffffd) continue
    const offset = wide(bytes, at + 24),
      size = wide(bytes, at + 32),
      link = word(bytes, at + 40, 4)
    if (
      offset === undefined ||
      size === undefined ||
      link === undefined ||
      link >= count ||
      offset + size > bytes.length
    )
      return invalid
    const stringsOffset = wide(bytes, sectionOffset + link * entrySize + 24)
    const stringsSize = wide(bytes, sectionOffset + link * entrySize + 32)
    if (
      stringsOffset === undefined ||
      stringsSize === undefined ||
      stringsOffset + stringsSize > bytes.length
    )
      return invalid
    const stringAt = (relative: number): string =>
      relative < stringsSize
        ? cstring(bytes.subarray(0, stringsOffset + stringsSize), stringsOffset + relative)
        : ''
    if (type === 6) {
      for (let item = offset; item + 16 <= offset + size; item += 16) {
        const tag = wide(bytes, item),
          value = wide(bytes, item + 8)
        if (value === undefined) return invalid
        if (tag === 1) imports.push(stringAt(value))
        if (tag === 14) name = stringAt(value)
      }
    } else if (type === 0x6ffffffd) {
      let item = offset
      while (item + 20 <= offset + size) {
        const aux = word(bytes, item + 12, 4) ?? 0
        if (aux === 0 || item + aux + 8 > offset + size) return invalid
        const version = stringAt(word(bytes, item + aux, 4) ?? 0)
        if (/^GLIBC_\d+\.\d+(?:\.\d+)?$/.test(version)) providedVersions.push(version.slice(6))
        const next = word(bytes, item + 16, 4) ?? 0
        if (next === 0) break
        item += next
      }
    } else {
      let item = offset
      while (item + 16 <= offset + size) {
        const aux = word(bytes, item + 8, 4) ?? 0,
          next = word(bytes, item + 12, 4) ?? 0
        let cursor = item + aux
        for (let remaining = word(bytes, item + 2, 2) ?? 0; remaining > 0; remaining -= 1) {
          if (cursor + 16 > offset + size) return invalid
          const version = stringAt(word(bytes, cursor + 8, 4) ?? 0)
          if (/^GLIBC_\d+\.\d+(?:\.\d+)?$/.test(version)) versions.push(version.slice(6))
          const step = word(bytes, cursor + 12, 4) ?? 0
          if (step === 0) break
          cursor += step
        }
        if (next === 0) break
        item += next
      }
    }
  }
  return { kind, compatible: true, imports, name, versions, providedVersions }
}
