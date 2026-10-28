"""Check Silk DEFLATE output with Python/zlib: python verify.py --silk PATH --clang PATH."""
import argparse
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CASES = [(0, 0), (1, 0), (2, 1), (3, 0), (257, 1), (258, 0), (259, 0),
         (32768, 1), (65539, 2), (90000, 3), (90001, 4)]

SOURCE = '''import silk.mem.allocator {Allocator, OutOfMemoryError}
import silk.core.effect {Effect}
import silk.compress.deflate {Deflate, EncodeError}
import silk.compress.inflate {Format}
import silk.collections.list {List}
import silk.io.writer_native {StdoutWriter}
import silk.io.writer {Writer, WriterError}
import silk.collections.slice {Slice}
import silk.num.u32
import silk.num.usize

effect fn emit(size: usize, mode: usize, format: Format) -> ()
! OutOfMemoryError | EncodeError | WriterError ? &mut Allocator {
  let mut input = List<u8>.make()
  let mut output = List<u8>.make()
  run List<u8>.reserveExact(&mut input, size)
  run List<u8>.reserveExact(&mut output, size * 2 + 32)
  let mut index: usize = 0
  let mut random: u32 = 123456789
  while index < size {
    let mut byte: u8 = 97
    if mode == 1 { byte = usize.toU8(usize.remainder(index, 256)) }
    if mode == 2 || mode == 3 {
      if mode == 3 && index >= 30000 { byte = List<u8>.get(&input, usize.remainder(index, 30000)) }
      else {
        random = u32.bitXor(random, u32.shiftLeft(random, 13))
        random = u32.bitXor(random, u32.shiftRight(random, 17))
        random = u32.bitXor(random, u32.shiftLeft(random, 5))
        byte = u32.toU8(u32.bitAnd(random, 255))
      }
    }
    if mode == 4 { byte = usize.toU8(97 + usize.remainder(index, 3)) }
    run List<u8>.append(&mut input, byte)
    index = index + 1
  }
  index = 0
  while index < size * 2 + 32 { run List<u8>.append(&mut output, 0) index = index + 1 }
  let encoded = run Deflate.encode(List<u8>.asSlice(&input), List<u8>.asMutSlice(&mut output), format)
  let count = usize.toU32(encoded)
  let prefix: [u8; 4] = [u32.toU8(u32.bitAnd(count, 255)), u32.toU8(u32.bitAnd(u32.shiftRight(count, 8), 255)), u32.toU8(u32.bitAnd(u32.shiftRight(count, 16), 255)), u32.toU8(u32.shiftRight(count, 24))]
  let mut stdout = StdoutWriter.make()
  run Writer.writeAll(&prefix) |> Effect.provideMut<Writer>(&mut stdout)
  run Writer.writeAll(Slice.view<u8>(List<u8>.asSlice(&output), 0, encoded)) |> Effect.provideMut<Writer>(&mut stdout)
}
pub effect fn main() -> i32 ! OutOfMemoryError | EncodeError | WriterError {
  let mut allocator = Allocator.systemAllocatorProvider()
'''


def expected(size, mode):
    data = bytearray()
    random = 123456789
    for index in range(size):
        byte = 97
        if mode == 1:
            byte = index % 256
        if mode in (2, 3):
            if mode == 3 and index >= 30000:
                byte = data[index % 30000]
            else:
                random ^= (random << 13) & 0xffffffff
                random ^= random >> 17
                random ^= (random << 5) & 0xffffffff
                byte = random & 255
        if mode == 4:
            byte = 97 + index % 3
        data.append(byte)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--silk', type=Path, required=True)
    parser.add_argument('--clang', type=Path, required=True)
    args = parser.parse_args()
    source = SOURCE
    for container in ('Raw', 'Zlib', 'Gzip'):
        for size, mode in CASES:
            source += f'  run emit({size}, {mode}, Format.{container}) |> Effect.provideMut<Allocator>(&mut allocator)\n'
    source += '  return 0\n}\n'
    with tempfile.TemporaryDirectory(prefix='silk-compression-') as directory:
        project = Path(directory)
        (project / 'silk.toml').write_text('[package]\nname = "compression-interop"\nversion = "0.0.0"\nsource = "."\nmain = "main.silk"\n')
        (project / 'main.silk').write_text(source)
        subprocess.run([str(args.silk.resolve()), 'build', str(project / 'main.silk'), '-o', str(project / 'probe'), '--stdlib', str(ROOT / 'stdlib'), '--clang', str(args.clang.resolve())], check=True)
        result = subprocess.run([str(project / 'probe')], capture_output=True, check=True)
    cursor = 0
    for wbits in (-15, 15, 31):
        for size, mode in CASES:
            length, = struct.unpack_from('<I', result.stdout, cursor)
            cursor += 4
            wire = result.stdout[cursor:cursor + length]
            cursor += length
            decoder = zlib.decompressobj(wbits)
            actual = decoder.decompress(wire) + decoder.flush()
            assert decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
            assert actual == expected(size, mode), (wbits, size, mode)
    assert cursor == len(result.stdout)
    print(f'zlib independently decoded all {3 * len(CASES)} Silk streams')


if __name__ == '__main__':
    main()
