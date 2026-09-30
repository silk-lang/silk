import { assert, it } from '@effect/vitest'
import * as Bitstream from '../src/internal/Bitstream.js'

it('packs crossing bit writes into little-endian words', () => {
  const writer = Bitstream.make()
  Bitstream.writeBits(writer, 0x3fff_ffff, 30)
  Bitstream.writeBits(writer, 0b10101, 5)
  Bitstream.alignTo32(writer)

  assert.deepEqual(
    Bitstream.toUint8Array(writer),
    Uint8Array.of(0xff, 0xff, 0xff, 0x7f, 0x05, 0x00, 0x00, 0x00),
  )
})

it('writes VBR values with exact bigint semantics', () => {
  const writer = Bitstream.make()
  Bitstream.writeVbr(writer, 63n, 6)
  Bitstream.writeVbr(writer, 0xffff_ffff_ffff_ffffn, 8)
  Bitstream.alignTo32(writer)

  assert.strictEqual(Bitstream.bitsVbr(63n, 6), 12)
  assert.deepEqual(
    Bitstream.toUint8Array(writer),
    Uint8Array.of(0x7f, 0xf0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00),
  )
})

it('packs wide numbers and bigint limbs across unaligned word boundaries', () => {
  const writer = Bitstream.make()
  Bitstream.writeBits(writer, 1, 1)
  Bitstream.writeBits(writer, Number.MAX_SAFE_INTEGER, 53)
  Bitstream.writeBits(writer, 0x89ab_cdef, 32)
  Bitstream.writeBits(writer, 0, 0)
  Bitstream.writeBits(writer, 0x123456789abcdef0123456789abcdefn, 100)
  Bitstream.alignTo32(writer)

  assert.deepEqual(
    Array.from(writer.words.subarray(0, writer.length)),
    [0xffff_ffff, 0x7bff_ffff, 0x7be2_6af3, 0x59e2_6af3, 0x7bc0_48d1, 0x01e2_6af3],
  )
})

it('preserves high numeric bits and continuation bits in wide VBR groups', () => {
  const writer = Bitstream.make()
  Bitstream.writeBits(writer, 0x15, 5)
  Bitstream.writeVbr(writer, Number.MAX_SAFE_INTEGER, 32)
  Bitstream.writeVbr(writer, 0xffff_ffff, 31)
  Bitstream.writeVbr(writer, 0x1_0000_0000, 6)
  Bitstream.writeVbr(writer, 0, 2)
  Bitstream.writeVbr(writer, 0xffff_ffff_ffff_ffffn, 32)
  Bitstream.alignTo32(writer)

  assert.deepEqual(
    Array.from(writer.words.subarray(0, writer.length)),
    [
      0xffff_fff5, 0x07ff_ffff, 0xffff_ffe0, 0x0000_003f, 0x0410_4100, 0xffff_8241, 0xffff_ffff,
      0x0001_ffff, 0x0000_0000,
    ],
  )
})

it('rejects characters outside LLVM char6', () => {
  assert.throws(() => Bitstream.char6('-'), /Character is not representable/)
  assert.strictEqual(Bitstream.char6('a'), 0)
  assert.strictEqual(Bitstream.char6('_'), 63)
})

it('aligns and pads blobs to little-endian words', () => {
  const writer = Bitstream.make()
  Bitstream.writeBits(writer, 1, 1)
  Bitstream.writeBlob(writer, [0x11, 0x22, 0x33, 0x44, 0x55])

  assert.deepEqual(
    Bitstream.toUint8Array(writer),
    Uint8Array.of(0x01, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x00, 0x00, 0x00),
  )
})

it('encodes a blob beyond the 16-bit length boundary without truncation', () => {
  const writer = Bitstream.make()
  const blob = Array.from({ length: 65_537 }, (_, index) => index & 0xff)
  Bitstream.writeBlob(writer, blob)
  const bytes = Bitstream.toUint8Array(writer)

  assert.lengthOf(bytes, 65_540)
  assert.deepEqual(bytes.slice(0, 4), Uint8Array.of(0, 1, 2, 3))
  assert.deepEqual(Array.from(bytes.slice(65_536)), [0, 0, 0, 0])
})

it('defines abbreviations, writes records, and backpatches block lengths', () => {
  const record: Bitstream.Abbreviation = {
    name: 'TEST_RECORD',
    ops: [
      { _tag: 'Literal', value: 7n },
      { _tag: 'Vbr', width: 6 },
      { _tag: 'Array' },
      { _tag: 'Fixed', width: 8 },
    ],
  }
  const block: Bitstream.Block = { id: 8, abbreviations: [record] }
  const writer = Bitstream.make()
  const entered = Bitstream.enterBlock(writer, block)
  Bitstream.writeRecord(entered, record, [42n, [0x61, 0x62]])
  Bitstream.writeUnabbreviatedRecord(entered, 9, [1, 2, 3])
  Bitstream.endBlock(entered)

  const bytes = Bitstream.toUint8Array(writer)
  assert.deepEqual(bytes.slice(0, 8), Uint8Array.of(0x21, 0x0c, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00))
  assert.strictEqual(bytes.length % 4, 0)
})
