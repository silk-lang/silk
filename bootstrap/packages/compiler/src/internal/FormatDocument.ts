/** A private byte-oriented pretty-printing document. */
export type Document =
  | { readonly _tag: 'Empty' }
  | { readonly _tag: 'Text'; readonly bytes: ReadonlyArray<number> }
  | { readonly _tag: 'VerbatimMultiline'; readonly bytes: ReadonlyArray<number> }
  | { readonly _tag: 'HardLine' }
  | { readonly _tag: 'SoftLine' }
  | { readonly _tag: 'Concat'; readonly documents: ReadonlyArray<Document> }
  | { readonly _tag: 'Indent'; readonly document: Document }
  | { readonly _tag: 'Group'; readonly document: Document }
  | { readonly _tag: 'IfBreak'; readonly broken: Document; readonly flat: Document }

export const empty: Document = { _tag: 'Empty' }
export const hardLine: Document = { _tag: 'HardLine' }
export const softLine: Document = { _tag: 'SoftLine' }

type TextValue = string | ReadonlyArray<number> | Uint8Array

const bytesOf = (value: TextValue): ReadonlyArray<number> =>
  typeof value === 'string'
    ? Array.from(value, (character) => character.charCodeAt(0))
    : Array.from(value)

export const text = (value: TextValue): Document => {
  const bytes = bytesOf(value)
  return bytes.length === 0 ? empty : { _tag: 'Text', bytes }
}

/** Protected token content that may contain physical line endings and semantic whitespace. */
export const verbatimMultiline = (value: TextValue): Document => {
  const bytes = bytesOf(value)
  return bytes.length === 0 ? empty : { _tag: 'VerbatimMultiline', bytes }
}

export const concat = (...documents: ReadonlyArray<Document>): Document => {
  const nonempty = documents.filter((document) => document._tag !== 'Empty')
  if (nonempty.length === 0) return empty
  if (nonempty.length === 1) return nonempty[0] ?? empty
  return { _tag: 'Concat', documents: nonempty }
}

export const join = (separator: Document, documents: ReadonlyArray<Document>): Document =>
  concat(
    ...documents.flatMap((document, index) => (index === 0 ? [document] : [separator, document])),
  )

export const indent = (document: Document): Document =>
  document._tag === 'Empty' ? empty : { _tag: 'Indent', document }

export const group = (document: Document): Document =>
  document._tag === 'Empty' ? empty : { _tag: 'Group', document }

export const ifBreak = (broken: Document, flat: Document = empty): Document => ({
  _tag: 'IfBreak',
  broken,
  flat,
})

type Mode = 'Flat' | 'Break'

interface Command {
  readonly indentation: number
  readonly mode: Mode
  readonly document: Document
}

const pushChildren = (stack: Array<Command>, command: Command): void => {
  if (command.document._tag !== 'Concat') return
  for (let index = command.document.documents.length - 1; index >= 0; index -= 1) {
    const document = command.document.documents[index]
    if (document !== undefined) stack.push({ ...command, document })
  }
}

/** Tests only the remaining portion of one line, bounded by the target width. */
const fits = (remainingWidth: number, initial: ReadonlyArray<Command>): boolean => {
  const stack = Array.from(initial)
  let remaining = remainingWidth
  while (remaining >= 0) {
    const command = stack.pop()
    if (command === undefined) return true
    const document = command.document
    switch (document._tag) {
      case 'Empty':
        break
      case 'Text':
        remaining -= document.bytes.length
        break
      case 'VerbatimMultiline': {
        let width = 0
        for (let index = 0; index < document.bytes.length; index += 1) {
          const byte = document.bytes[index]
          if (byte === 0x0a || (byte === 0x0d && document.bytes[index + 1] === 0x0a)) return false
          width += 1
        }
        remaining -= width
        break
      }
      case 'HardLine':
        return false
      case 'SoftLine':
        if (command.mode === 'Break') return true
        remaining -= 1
        break
      case 'Concat':
        pushChildren(stack, command)
        break
      case 'Indent':
        stack.push({
          ...command,
          indentation: command.indentation + 2,
          document: document.document,
        })
        break
      case 'Group':
        stack.push({ ...command, mode: 'Flat', document: document.document })
        break
      case 'IfBreak':
        stack.push({
          ...command,
          document: command.mode === 'Break' ? document.broken : document.flat,
        })
        break
    }
  }
  return false
}

const trimHorizontalWhitespace = (output: Array<number>): void => {
  let last = output.at(-1)
  while (last === 0x20 || last === 0x09) {
    output.pop()
    last = output.at(-1)
  }
}

/** Renders a document with one deterministic width and exactly one final LF. */
export const render = (document: Document, width = 100): Uint8Array => {
  const output: Array<number> = []
  const stack: Array<Command> = [{ indentation: 0, mode: 'Break', document }]
  let column = 0

  // This is the formatter's measured hot loop: each selected document node is rendered once.
  while (stack.length > 0) {
    const command = stack.pop()
    if (command === undefined) break
    const current = command.document
    switch (current._tag) {
      case 'Empty':
        break
      case 'Text':
        output.push(...current.bytes)
        column += current.bytes.length
        break
      case 'VerbatimMultiline':
        for (let index = 0; index < current.bytes.length; index += 1) {
          const byte = current.bytes[index]
          if (byte === 0x0d && current.bytes[index + 1] === 0x0a) {
            output.push(0x0a)
            column = 0
            index += 1
          } else if (byte === 0x0a) {
            output.push(byte)
            column = 0
          } else if (byte !== undefined) {
            output.push(byte)
            column += 1
          }
        }
        break
      case 'HardLine':
        trimHorizontalWhitespace(output)
        output.push(0x0a, ...Array.from({ length: command.indentation }, () => 0x20))
        column = command.indentation
        break
      case 'SoftLine':
        if (command.mode === 'Flat') {
          output.push(0x20)
          column += 1
        } else {
          trimHorizontalWhitespace(output)
          output.push(0x0a, ...Array.from({ length: command.indentation }, () => 0x20))
          column = command.indentation
        }
        break
      case 'Concat':
        pushChildren(stack, command)
        break
      case 'Indent':
        stack.push({
          ...command,
          indentation: command.indentation + 2,
          document: current.document,
        })
        break
      case 'Group': {
        const flat: Command = { ...command, mode: 'Flat', document: current.document }
        stack.push(
          fits(width - column, [flat])
            ? flat
            : { ...command, mode: 'Break', document: current.document },
        )
        break
      }
      case 'IfBreak':
        stack.push({
          ...command,
          document: command.mode === 'Break' ? current.broken : current.flat,
        })
        break
    }
  }

  trimHorizontalWhitespace(output)
  while (output.at(-1) === 0x0a || output.at(-1) === 0x0d) output.pop()
  output.push(0x0a)
  return Uint8Array.from(output)
}
