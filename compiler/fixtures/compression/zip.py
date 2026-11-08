"""Regenerate corpus/native/zip-read from archives made by Info-ZIP `zip` and Python's zipfile.

Info-ZIP writes the archives real tools publish: extra fields, an archive comment, Unix modes,
symbolic links, and (when it writes to a pipe) data descriptors. The ZIP64 case is written by hand
from APPNOTE 4.5.3 and checked with Python's zipfile. Each expected listing comes from Python's
zipfile, not from the reader under test. Needs `zip` on PATH.
"""
import io
import json
import os
import struct
import subprocess
import tempfile
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STAMP = 1700000000


def literal(data):
    return 'b"' + ''.join(f'\\x{x:02x}' for x in data) + '"'


def tree(directory):
    (directory / 'sdk/include').mkdir(parents=True)
    (directory / 'sdk/lib').mkdir(parents=True)
    (directory / 'sdk/include/sdk.h').write_text('int sdk(void);\n' * 40)
    (directory / 'sdk/lib/libsdk.a').write_bytes(bytes(range(256)) * 8)
    (directory / 'sdk/bin').mkdir()
    (directory / 'sdk/bin/tool').write_text('#!/bin/sh\necho tool\n')
    os.chmod(directory / 'sdk/bin/tool', 0o755)
    os.symlink('lib/libsdk.a', directory / 'sdk/current')
    for path in sorted(directory.rglob('*'), reverse=True):
        os.utime(path, (STAMP, STAMP), follow_symlinks=False)


def infozip(streamed):
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        tree(work)
        files = ['sdk/', 'sdk/bin/', 'sdk/bin/tool', 'sdk/current', 'sdk/include/', 'sdk/include/sdk.h', 'sdk/lib/', 'sdk/lib/libsdk.a']
        if streamed:
            # Writing to a pipe makes zip use data descriptors (general purpose bit 3). It cannot
            # store a member to a pipe, and a link is always stored, so the link stays out.
            files.remove('sdk/current')
            made = subprocess.run(['zip', '-q', '-y', '-', *files], cwd=work, check=True, capture_output=True).stdout
        else:
            subprocess.run(['zip', '-q', '-y', 'out.zip', *files], cwd=work, check=True)
            subprocess.run(['zip', '-q', '-z', 'out.zip'], cwd=work, input=b'An archive comment.\n', check=True)
            made = (work / 'out.zip').read_bytes()
    return made


def zip64():
    """One stored file whose sizes and offset live only in ZIP64 records."""
    name = b'wide/file.txt'
    data = b'zip64 sizes\n'
    crc = zlib.crc32(data)
    local = struct.pack('<IHHHHHIIIHH', 0x04034b50, 45, 0, 0, 0, 0x21, crc, 0xffffffff, 0xffffffff, len(name), 20)
    local += name + struct.pack('<HHQQ', 1, 16, len(data), len(data)) + data
    extra = struct.pack('<HHQQQ', 1, 24, len(data), len(data), 0)
    central = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 0x031e, 45, 0, 0, 0, 0x21, crc, 0xffffffff, 0xffffffff,
                          len(name), len(extra), 0, 0, 0, 0o100644 << 16, 0xffffffff) + name + extra
    offset = len(local)
    end64 = struct.pack('<IQHHIIQQQQ', 0x06064b50, 44, 45, 45, 0, 0, 1, 1, len(central), offset)
    locator = struct.pack('<IIQI', 0x07064b50, 0, offset + len(central), 1)
    end = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, 0xffff, 0xffff, 0xffffffff, 0xffffffff, 0)
    return local + central + end64 + locator + end


def plain(name, data, method=zipfile.ZIP_DEFLATED):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        info = zipfile.ZipInfo(name, (2023, 11, 14, 22, 13, 20))
        info.compress_type = method
        archive.writestr(info, data)
    return buffer.getvalue()


def listing(archive):
    """The listing the Silk program builds, from Python's own reader."""
    lines = []
    with zipfile.ZipFile(io.BytesIO(archive)) as opened:
        for info in opened.infolist():
            mode = info.external_attr >> 16 if info.create_system == 3 else 0
            if info.is_dir():
                kind, content = 'd', b''
            elif (mode & 0o170000) == 0o120000:
                kind, content = 'l', opened.read(info)
            else:
                kind, content = 'f', opened.read(info)
            executable = 'x' if kind == 'f' and mode & 0o111 else '-'
            lines.append(f'{kind}{executable} {info.filename.rstrip("/")} {len(content)} {zlib.crc32(content):08x}\n')
    return ''.join(lines).encode()


def main():
    cases = {
        'infozip': infozip(False),
        'streamed': infozip(True),
        'zip64': zip64(),
        'stored': plain('a.txt', b'stored text', zipfile.ZIP_STORED),
    }
    assert any(info.flag_bits & 8 for info in zipfile.ZipFile(io.BytesIO(cases['streamed'])).infolist()), 'zip wrote no data descriptor'
    assert cases['infozip'].endswith(b'An archive comment.')
    with zipfile.ZipFile(io.BytesIO(cases['zip64'])) as opened:
        assert opened.read('wide/file.txt') == b'zip64 sizes\n'
    stored = bytearray(cases['stored'])
    stored[stored.index(b'stored text')] ^= 1
    refused = {
        'UnsafePath': [plain('../escape', b'x'), plain('/root', b'x'), plain('a/./b', b'x'), plain('a\\b', b'x')],
        'BadChecksum': [bytes(stored)],
        'Truncated': [cases['stored'][:-1], b''],
        'InvalidDirectory': [cases['stored'][:30] + b'\x00' + cases['stored'][31:]],
    }
    encrypted = bytearray(cases['stored'])
    central = encrypted.index(b'PK\x01\x02')
    encrypted[central + 8] |= 1
    refused['UnsupportedMember'] = [bytes(encrypted)]
    lines = ['// Generated by compiler/fixtures/compression/zip.py from Info-ZIP and Python zipfile archives.',
             'import silk.mem.allocator {Allocator, OutOfMemoryError}',
             'import silk.core.effect {Effect}',
             'import silk.compress.zip {ZipError, ZipKind, ZipMember, ZipReader}',
             'import silk.collections.bytes {Bytes}',
             'import silk.compress.checksum {CompressionChecksum}',
             'import silk.core.option {Option}',
             'import silk.core.result {Result}',
             'import silk.num.u32',
             'import silk.num.u64',
             'import silk.num.usize',
             '',
             SOURCE]
    lines.append('effect fn program() -> i32 ! OutOfMemoryError | ZipError ? &mut Allocator {')
    code = 1
    for name, archive in cases.items():
        lines.append(f'  // {name}')
        lines.append(f'  if !same(Bytes.asSlice(&run listing({literal(archive)}, 1048576)), {literal(listing(archive))}) {{ return {code} }}')
        code += 1
    for error, archives in refused.items():
        for archive in archives:
            lines.append(f'  if !run refuses({literal(archive)}, 1048576, ZipError.{error}) {{ return {code} }}')
            code += 1
    total = sum(info.file_size for info in zipfile.ZipFile(io.BytesIO(cases['infozip'])).infolist())
    lines.append(f'  if !run refuses({literal(cases["infozip"])}, {total - 1}, ZipError.LimitExceeded) {{ return {code} }}')
    code += 1
    lines.append(f'  if Bytes.length(&run listing({literal(cases["infozip"])}, {total})) == 0 {{ return {code} }}')
    lines.append('  return 42')
    lines.append('}')
    lines.append('')
    lines.append('pub effect fn main() -> i32 ! OutOfMemoryError | ZipError {')
    lines.append('  let mut allocator = Allocator.systemAllocatorProvider()')
    lines.append('  return run program() |> Effect.provideMut<Allocator>(&mut allocator)')
    lines.append('}')
    directory = ROOT / 'corpus/native/zip-read'
    directory.mkdir(exist_ok=True)
    (directory / 'main.silk').write_text('\n'.join(lines) + '\n')
    (directory / 'outcome.json').write_text(json.dumps({'expected': {'exitCode': 42, 'kind': 'completes'}, 'schemaVersion': 1}, indent=2) + '\n')


SOURCE = '''fn same(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut at: usize = 0
  while at < left.length {
    if left[at] != right[at] { return false }
    at = at + 1
  }
  return true
}

effect fn appendHex(text: &mut Bytes, value: u32) -> () ! OutOfMemoryError ? &mut Allocator {
  let digits = b"0123456789abcdef"
  let mut shift: u32 = 28
  while true {
    let digit: [u8; 1] = [digits[u32.toUsize(u32.shiftRight(value, shift) & 15)]]
    run Bytes.append(&mut text.*, &digit)
    if shift == 0 { return }
    shift = shift - 4
  }
}

effect fn appendDecimal(text: &mut Bytes, value: usize) -> () ! OutOfMemoryError ? &mut Allocator {
  if value >= 10 { run appendDecimal(&mut text.*, value / 10) }
  let digit: [u8; 1] = [usize.toU8(value % 10) + 48]
  run Bytes.append(&mut text.*, &digit)
}

// One line per member: its kind, whether it is executable, its name, and its decoded length and CRC-32.
effect fn listing(archive: &[u8], limit: u64) -> Bytes ! OutOfMemoryError | ZipError ? &mut Allocator {
  let mut reader = match ZipReader.open(archive, limit) {
    Result.Success {value} => move value
    Result.Failure {error} => { fail error }
  }
  let mut text = Bytes.make()
  while true {
    let next = match ZipReader.next(&mut reader) {
      Result.Success {value} => move value
      Result.Failure {error} => { fail error }
    }
    let member = match move next {
      Option<ZipMember>.Some {value} => move value
      Option<ZipMember>.None => { return move text }
    }
    let content = run ZipMember.content(&member)
    let kind = match member.kind { ZipKind.File => b"f" ZipKind.Directory => b"d" ZipKind.SymbolicLink => b"l" }
    run Bytes.append(&mut text, kind)
    run Bytes.append(&mut text, if member.executable { b"x " } else { b"- " })
    run Bytes.append(&mut text, member.name)
    run Bytes.append(&mut text, b" ")
    run appendDecimal(&mut text, Bytes.length(&content))
    run Bytes.append(&mut text, b" ")
    run appendHex(&mut text, CompressionChecksum.crc32(Bytes.asSlice(&content)))
    run Bytes.append(&mut text, b"\\n")
  }
  return move text
}

// Whether reading all of `archive` fails with `expected`.
effect fn refuses(archive: &[u8], limit: u64, expected: ZipError) -> bool ! OutOfMemoryError ? &mut Allocator {
  return match move run Effect.result(listing(archive, limit)) {
    Result<Bytes, OutOfMemoryError | ZipError>.Success {..} => false
    Result<Bytes, OutOfMemoryError | ZipError>.Failure {error} => match move error {
      ZipError refused => refused == expected
      OutOfMemoryError exhausted => { fail move exhausted }
    }
  }
}
'''

if __name__ == '__main__':
    main()
