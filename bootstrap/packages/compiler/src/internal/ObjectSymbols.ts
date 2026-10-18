import * as Result from 'effect/Result'
import type * as Target from '../Target.js'

export interface Symbol {
  readonly name: string
  readonly defined: boolean
  readonly weak: boolean
  readonly visibility: 'default' | 'hidden'
}

export interface Inventory {
  readonly format: 'elf' | 'macho' | 'wasm'
  readonly symbols: ReadonlyArray<Symbol>
  /** Symbol references made by relocations, including references to defined exports. */
  readonly references: ReadonlyArray<string>
}

export interface InvalidObject {
  readonly _tag: 'InvalidObject'
  readonly format: string
  readonly detail: string
}

const fail = (format: string, detail: string): Result.Result<never, InvalidObject> =>
  Result.fail({ _tag: 'InvalidObject', format, detail })

const range = (bytes: Uint8Array, offset: number, size: number): boolean =>
  Number.isSafeInteger(offset) &&
  Number.isSafeInteger(size) &&
  offset >= 0 &&
  size >= 0 &&
  offset <= bytes.length - size

const word = (bytes: Uint8Array, offset: number, size: 2 | 4 | 8): number | undefined => {
  if (!range(bytes, offset, size)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (size === 2) return view.getUint16(offset, true)
  if (size === 4) return view.getUint32(offset, true)
  const value = Number(view.getBigUint64(offset, true))
  return Number.isSafeInteger(value) ? value : undefined
}

const stringAt = (bytes: Uint8Array, offset: number, end: number): string | undefined => {
  if (!range(bytes, offset, end - offset) || offset === end) return undefined
  const zero = bytes.indexOf(0, offset)
  if (zero < offset || zero >= end) return undefined
  return new TextDecoder().decode(bytes.subarray(offset, zero))
}

interface Section {
  readonly type: number
  readonly offset: number
  readonly size: number
  readonly link: number
  readonly stride: number
}

const elf = (bytes: Uint8Array, target: Target.Target): Result.Result<Inventory, InvalidObject> => {
  if (
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    word(bytes, 16, 2) !== 1 ||
    word(bytes, 18, 2) !== (target.architecture === 'aarch64' ? 183 : 62)
  )
    return fail('elf', 'expected a compatible little-endian ELF64 relocatable object')
  const offset = word(bytes, 40, 8),
    count = word(bytes, 60, 2),
    stride = word(bytes, 58, 2)
  if (
    offset === undefined ||
    count === undefined ||
    count === 0 ||
    stride !== 64 ||
    !range(bytes, offset, count * stride)
  )
    return fail('elf', 'invalid section table')
  const sections: Array<Section> = []
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * stride
    const type = word(bytes, at + 4, 4),
      start = word(bytes, at + 24, 8),
      size = word(bytes, at + 32, 8),
      link = word(bytes, at + 40, 4),
      entrySize = word(bytes, at + 56, 8)
    if (
      type === undefined ||
      start === undefined ||
      size === undefined ||
      link === undefined ||
      entrySize === undefined ||
      (type !== 8 && !range(bytes, start, size))
    )
      return fail('elf', 'invalid section extent')
    sections.push({ type, offset: start, size, link, stride: entrySize })
  }
  const tables = new Map<number, ReadonlyArray<Symbol>>()
  const symbols: Array<Symbol> = []
  for (const [index, section] of sections.entries()) {
    if (section.type !== 2) continue
    const strings = sections[section.link]
    if (section.stride !== 24 || section.size % 24 !== 0 || strings?.type !== 3)
      return fail('elf', 'invalid symbol table')
    const entries: Array<Symbol> = []
    for (let at = section.offset; at < section.offset + section.size; at += 24) {
      const nameOffset = word(bytes, at, 4),
        info = bytes[at + 4],
        other = bytes[at + 5],
        sectionIndex = word(bytes, at + 6, 2)
      if (
        nameOffset === undefined ||
        nameOffset >= strings.size ||
        info === undefined ||
        other === undefined ||
        sectionIndex === undefined ||
        sectionIndex === 0xffff
      )
        return fail('elf', 'invalid symbol entry')
      const name = stringAt(bytes, strings.offset + nameOffset, strings.offset + strings.size)
      if (name === undefined) return fail('elf', 'unterminated symbol name')
      const symbol: Symbol = {
        name,
        defined: sectionIndex !== 0,
        weak: info >> 4 === 2,
        visibility: (other & 3) === 2 ? 'hidden' : 'default',
      }
      entries.push(symbol)
      if (name !== '' && info >> 4 !== 0) symbols.push(symbol)
    }
    tables.set(index, entries)
  }
  if (tables.size === 0) return fail('elf', 'missing symbol table')
  const references = new Set<string>()
  for (const section of sections) {
    if (section.type !== 4 && section.type !== 9) continue
    const table = tables.get(section.link),
      expected = section.type === 4 ? 24 : 16
    if (table === undefined || section.stride !== expected || section.size % expected !== 0)
      return fail('elf', 'invalid relocation table')
    for (let at = section.offset; at < section.offset + section.size; at += expected) {
      const index = word(bytes, at + 12, 4)
      const symbol = index === undefined ? undefined : table[index]
      if (symbol === undefined) return fail('elf', 'invalid relocation symbol')
      if (symbol.name !== '') references.add(symbol.name)
    }
  }
  return Result.succeed({ format: 'elf', symbols, references: [...references].sort() })
}

const macho = (bytes: Uint8Array): Result.Result<Inventory, InvalidObject> => {
  if (word(bytes, 4, 4) !== 0x100000c || word(bytes, 12, 4) !== 1)
    return fail('macho', 'expected an ARM64 relocatable object')
  const count = word(bytes, 16, 4),
    commandBytes = word(bytes, 20, 4)
  if (
    count === undefined ||
    commandBytes === undefined ||
    !range(bytes, 32, commandBytes) ||
    count > commandBytes / 8
  )
    return fail('macho', 'invalid load commands')
  let table: { offset: number; count: number; strings: number; stringBytes: number } | undefined
  const relocations: Array<{ offset: number; count: number }> = []
  let at = 32
  for (let index = 0; index < count; index += 1) {
    const command = word(bytes, at, 4),
      size = word(bytes, at + 4, 4)
    if (size === undefined || size < 8 || at + size > 32 + commandBytes)
      return fail('macho', 'invalid load command extent')
    if (command === 2) {
      const offset = word(bytes, at + 8, 4),
        symbolCount = word(bytes, at + 12, 4),
        strings = word(bytes, at + 16, 4),
        stringBytes = word(bytes, at + 20, 4)
      if (
        size !== 24 ||
        table !== undefined ||
        offset === undefined ||
        symbolCount === undefined ||
        strings === undefined ||
        stringBytes === undefined ||
        !range(bytes, offset, symbolCount * 16) ||
        !range(bytes, strings, stringBytes)
      )
        return fail('macho', 'invalid symbol command')
      table = { offset, count: symbolCount, strings, stringBytes }
    }
    if (command === 0x19) {
      const sections = word(bytes, at + 64, 4)
      if (sections === undefined || size < 72 || sections > (size - 72) / 80)
        return fail('macho', 'invalid segment sections')
      for (let section = 0; section < sections; section += 1) {
        const start = at + 72 + section * 80
        const offset = word(bytes, start + 56, 4),
          relocationCount = word(bytes, start + 60, 4)
        if (
          offset === undefined ||
          relocationCount === undefined ||
          !range(bytes, offset, relocationCount * 8)
        )
          return fail('macho', 'invalid section relocations')
        relocations.push({ offset, count: relocationCount })
      }
    }
    at += size
  }
  if (at !== 32 + commandBytes || table === undefined) return fail('macho', 'missing symbol table')
  const entries: Array<Symbol | undefined> = [],
    symbols: Array<Symbol> = []
  for (let index = 0; index < table.count; index += 1) {
    const start = table.offset + index * 16
    const nameOffset = word(bytes, start, 4),
      type = bytes[start + 4],
      description = word(bytes, start + 6, 2),
      value = word(bytes, start + 8, 8)
    if (
      nameOffset === undefined ||
      nameOffset >= table.stringBytes ||
      type === undefined ||
      description === undefined ||
      value === undefined
    )
      return fail('macho', 'invalid symbol entry')
    const name = stringAt(bytes, table.strings + nameOffset, table.strings + table.stringBytes)
    if (name === undefined) return fail('macho', 'unterminated symbol name')
    if ((type & 0xe0) !== 0) {
      entries.push(undefined)
      continue
    }
    const symbol: Symbol = {
      name,
      defined: (type & 0xe) !== 0 || value !== 0,
      weak: (description & 0xc0) !== 0,
      visibility: (type & 0x10) !== 0 ? 'hidden' : 'default',
    }
    entries.push(symbol)
    if (name !== '' && (type & 1) !== 0) symbols.push(symbol)
  }
  const references = new Set<string>()
  for (const relocation of relocations) {
    for (let index = 0; index < relocation.count; index += 1) {
      const info = word(bytes, relocation.offset + index * 8 + 4, 4)
      if (info === undefined) return fail('macho', 'invalid relocation')
      if ((info & 0x8000000) === 0) continue
      const symbol = entries[info & 0xffffff]
      if (symbol === undefined) return fail('macho', 'invalid relocation symbol')
      references.add(symbol.name)
    }
  }
  return Result.succeed({ format: 'macho', symbols, references: [...references].sort() })
}

interface Cursor {
  offset: number
  readonly end: number
}

const leb = (bytes: Uint8Array, cursor: Cursor): number | undefined => {
  let value = 0
  for (let index = 0; index < 5 && cursor.offset < cursor.end; index += 1) {
    const byte = bytes[cursor.offset++]
    if (byte === undefined || (index === 4 && byte > 15)) return undefined
    value += (byte & 127) * 2 ** (index * 7)
    if (byte < 128) return value
  }
  return undefined
}

const wasmString = (bytes: Uint8Array, cursor: Cursor): string | undefined => {
  const size = leb(bytes, cursor)
  if (size === undefined || size > cursor.end - cursor.offset) return undefined
  const result = new TextDecoder().decode(bytes.subarray(cursor.offset, cursor.offset + size))
  cursor.offset += size
  return result
}

const wasm = (bytes: Uint8Array): Result.Result<Inventory, InvalidObject> => {
  if (word(bytes, 4, 4) !== 1) return fail('wasm', 'unsupported binary version')
  const sections: Array<{ id: number; cursor: Cursor; name: string }> = []
  const stream: Cursor = { offset: 8, end: bytes.length }
  while (stream.offset < stream.end) {
    const id = leb(bytes, stream),
      size = leb(bytes, stream)
    if (id === undefined || id > 13 || size === undefined || size > stream.end - stream.offset)
      return fail('wasm', 'invalid section extent')
    const cursor = { offset: stream.offset, end: stream.offset + size }
    const name = id === 0 ? wasmString(bytes, cursor) : ''
    if (name === undefined) return fail('wasm', 'invalid custom section name')
    sections.push({ id, cursor, name })
    stream.offset += size
  }
  const imports = new Map<number, Array<string>>()
  for (const section of sections.filter((entry) => entry.id === 2)) {
    const cursor = { ...section.cursor },
      count = leb(bytes, cursor)
    if (count === undefined || count > cursor.end - cursor.offset)
      return fail('wasm', 'invalid import count')
    for (let index = 0; index < count; index += 1) {
      const module = wasmString(bytes, cursor),
        name = wasmString(bytes, cursor),
        kind = leb(bytes, cursor)
      if (module === undefined || name === undefined || kind === undefined || kind > 4)
        return fail('wasm', 'invalid import')
      const names = imports.get(kind) ?? []
      names.push(name)
      imports.set(kind, names)
      if (kind === 0) {
        if (leb(bytes, cursor) === undefined) return fail('wasm', 'invalid function import')
      } else if (kind === 3 || kind === 4) {
        if (leb(bytes, cursor) === undefined || leb(bytes, cursor) === undefined)
          return fail('wasm', 'invalid global or tag import')
      } else {
        if (kind === 1 && leb(bytes, cursor) !== 0x70) return fail('wasm', 'unsupported table type')
        const flags = leb(bytes, cursor)
        if (
          flags === undefined ||
          flags > 3 ||
          leb(bytes, cursor) === undefined ||
          ((flags & 1) !== 0 && leb(bytes, cursor) === undefined)
        )
          return fail('wasm', 'unsupported memory/table limits')
      }
    }
    if (cursor.offset !== cursor.end) return fail('wasm', 'trailing import data')
  }
  const entries: Array<Symbol | undefined> = [],
    symbols: Array<Symbol> = []
  let found = false
  for (const section of sections.filter((entry) => entry.name === 'linking')) {
    const cursor = { ...section.cursor }
    if (leb(bytes, cursor) !== 2) return fail('wasm', 'unsupported linking version')
    while (cursor.offset < cursor.end) {
      const kind = leb(bytes, cursor),
        size = leb(bytes, cursor)
      if (kind === undefined || size === undefined || size > cursor.end - cursor.offset)
        return fail('wasm', 'invalid linking subsection')
      const data = { offset: cursor.offset, end: cursor.offset + size }
      cursor.offset += size
      if (kind !== 8) continue
      if (found) return fail('wasm', 'duplicate symbol table')
      found = true
      const count = leb(bytes, data)
      if (count === undefined || count > data.end - data.offset)
        return fail('wasm', 'invalid symbol count')
      for (let ordinal = 0; ordinal < count; ordinal += 1) {
        const type = leb(bytes, data),
          flags = leb(bytes, data)
        if (type === undefined || type > 5 || flags === undefined)
          return fail('wasm', 'invalid symbol')
        const defined = (flags & 0x10) === 0
        let name: string | undefined
        if (type === 1) {
          name = wasmString(bytes, data)
          if (
            defined &&
            (leb(bytes, data) === undefined ||
              leb(bytes, data) === undefined ||
              leb(bytes, data) === undefined)
          )
            return fail('wasm', 'invalid data symbol')
        } else {
          const index = leb(bytes, data)
          if (index === undefined) return fail('wasm', 'invalid symbol index')
          if (type === 3) {
            entries.push(undefined)
            continue
          }
          let importKind = type
          if (type === 2) importKind = 3
          else if (type === 5) importKind = 1
          name =
            defined || (flags & 0x40) !== 0
              ? wasmString(bytes, data)
              : imports.get(importKind)?.[index]
        }
        if (name === undefined) return fail('wasm', 'missing symbol name')
        const symbol: Symbol = {
          name,
          defined,
          weak: (flags & 3) === 1,
          visibility: (flags & 4) !== 0 ? 'hidden' : 'default',
        }
        entries.push(symbol)
        if ((flags & 3) !== 2) symbols.push(symbol)
      }
      if (data.offset !== data.end) return fail('wasm', 'trailing symbol data')
    }
  }
  if (!found) return fail('wasm', 'missing linking symbol table')
  const references = new Set<string>()
  for (const section of sections.filter((entry) => entry.name.startsWith('reloc.'))) {
    const cursor = { ...section.cursor },
      targetIndex = leb(bytes, cursor),
      count = leb(bytes, cursor)
    const target = targetIndex === undefined ? undefined : sections[targetIndex]
    if (target === undefined || count === undefined || count > cursor.end - cursor.offset)
      return fail('wasm', 'invalid relocation section')
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const type = leb(bytes, cursor),
        offset = leb(bytes, cursor),
        index = leb(bytes, cursor)
      if (
        type === undefined ||
        ![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21, 23, 26].includes(type) ||
        offset === undefined ||
        offset >= target.cursor.end - target.cursor.offset ||
        index === undefined
      )
        return fail('wasm', 'unsupported or invalid relocation')
      if ([3, 4, 5, 8, 9, 11, 21, 23].includes(type)) {
        // Signed i32 addends are consumed without interpretation; only symbol identity is needed.
        let complete = false
        for (let byteIndex = 0; byteIndex < 5 && cursor.offset < cursor.end; byteIndex += 1) {
          const byte = bytes[cursor.offset++]
          if (byte === undefined) break
          if (byte < 128) {
            complete = true
            break
          }
        }
        if (!complete) return fail('wasm', 'invalid relocation addend')
      }
      if (type === 6) continue // Type-table indices are not symbol-table indices.
      if (index >= entries.length) return fail('wasm', 'invalid relocation symbol')
      const symbol = entries[index]
      if (symbol !== undefined) references.add(symbol.name)
    }
    if (cursor.offset !== cursor.end) return fail('wasm', 'trailing relocation data')
  }
  return Result.succeed({ format: 'wasm', symbols, references: [...references].sort() })
}

/** Strictly reads target-object accounting; the final linker still owns symbol resolution. */
export const inspect = (
  bytes: Uint8Array,
  target: Target.Target,
): Result.Result<Inventory, InvalidObject> => {
  const magic = word(bytes, 0, 4)
  if (magic === 0x6d736100 && target.kind === 'WebAssembly') return wasm(bytes)
  if (magic === 0x464c457f && target.operatingSystem === 'linux') return elf(bytes, target)
  if (magic === 0xfeedfacf && target.operatingSystem === 'darwin') return macho(bytes)
  return fail('unknown', `unsupported object format for ${target.id}`)
}
