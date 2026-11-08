"""Regenerate corpus/native/tar-read from archives made by GNU tar and Python's tarfile.

GNU tar writes the `./` paths of `tar -C dir .`, links, and GNU long names; Python's tarfile
writes ustar `prefix` paths and pax `path` records. The base-256 case is a tarfile header with
its size field rewritten in base-256. Each expected listing comes from Python's tarfile, not from
the reader under test. Needs GNU `tar` on PATH.
"""
import io
import json
import os
import subprocess
import tarfile
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STAMP = 1700000000
LONG = 'sdk/' + 'a-directory-whose-name-is-long-enough-that-the-whole-path-no-longer-fits-in-one-name-field/' + 'header.h'


def literal(data):
    return 'b"' + ''.join(f'\\x{x:02x}' for x in data) + '"'


def gnu():
    """`tar --format=gnu -cf - -C dir .` of a tree with a link, a hard link and a long name."""
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        (work / 'include').mkdir()
        (work / 'include/sdk.h').write_text('int sdk(void);\n')
        (work / 'bin').mkdir()
        (work / 'bin/tool').write_text('#!/bin/sh\necho tool\n')
        os.chmod(work / 'bin/tool', 0o755)
        os.symlink('include/sdk.h', work / 'current.h')
        os.link(work / 'include/sdk.h', work / 'same.h')
        (work / LONG).parent.mkdir(parents=True)
        (work / LONG).write_text('long\n')
        for path in sorted(work.rglob('*'), reverse=True):
            os.utime(path, (STAMP, STAMP), follow_symlinks=False)
        os.utime(work, (STAMP, STAMP))
        return subprocess.run(['tar', '--format=gnu', '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '-C', work, '.'],
                              check=True, capture_output=True).stdout


def made(entries, format):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=format) as archive:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            info.mtime = STAMP
            info.type = kind
            info.mode = 0o644
            if kind == tarfile.REGTYPE:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            else:
                archive.addfile(info)
    return buffer.getvalue()


def checksummed(header):
    header = bytearray(header)
    header[148:156] = b' ' * 8
    header[148:156] = b'%06o\x00 ' % sum(header)
    return bytes(header)


def base256():
    archive = bytearray(made([('big.bin', b'base-256 size\n', tarfile.REGTYPE)], tarfile.USTAR_FORMAT))
    archive[124:136] = b'\x80' + (14).to_bytes(11, 'big')
    archive[0:512] = checksummed(archive[0:512])
    return bytes(archive)


def trimmed(archive):
    """`archive` cut after its last member and one end-of-archive block, dropping record padding."""
    with tarfile.open(fileobj=io.BytesIO(archive)) as opened:
        end = max(info.offset_data + (info.size + 511) // 512 * 512 for info in opened.getmembers())
    return archive[:end] + bytes(512)


def listing(archive):
    """The listing the Silk program builds, from Python's own reader."""
    lines = []
    with tarfile.open(fileobj=io.BytesIO(archive)) as opened:
        for info in opened.getmembers():
            if info.isdir():
                kind, content = 'd', b''
            elif info.issym():
                kind, content = 's', info.linkname.encode()
            elif info.islnk():
                kind, content = 'h', info.linkname.encode()
            else:
                kind, content = 'f', opened.extractfile(info).read()
            executable = 'x' if kind == 'f' and info.mode & 0o111 else '-'
            lines.append(f'{kind}{executable} {info.name} {len(content)} {zlib.crc32(content):08x}\n')
    return ''.join(lines).encode()


def main():
    cases = {
        'gnu': gnu(),
        'ustar-prefix': made([(LONG, b'prefixed\n', tarfile.REGTYPE), ('sdk/dir', b'', tarfile.DIRTYPE)], tarfile.USTAR_FORMAT),
        'pax': made([(LONG + '-pax-' + 'x' * 100, b'pax\n', tarfile.REGTYPE)], tarfile.PAX_FORMAT),
        'base-256': base256(),
    }
    assert b'././@LongLink' in cases['gnu'], 'tar wrote no GNU long name'
    assert cases['ustar-prefix'][345] != 0, 'tarfile wrote no ustar prefix'
    plain = trimmed(made([('a.txt', b'plain text\n', tarfile.REGTYPE)], tarfile.USTAR_FORMAT))
    corrupt = bytearray(plain)
    corrupt[0] ^= 1
    badnumber = bytearray(plain)
    badnumber[124:136] = b'0000000001x\x00'
    badnumber[0:512] = checksummed(badnumber[0:512])
    refused = {
        'UnsafePath': [made([('../escape', b'x', tarfile.REGTYPE)], tarfile.USTAR_FORMAT),
                       made([('/etc/escape', b'x', tarfile.REGTYPE)], tarfile.USTAR_FORMAT),
                       made([('a\\b', b'x', tarfile.REGTYPE)], tarfile.USTAR_FORMAT),
                       made([('sdk/' + '../' * 40 + 'x' * 40 + '/escape', b'x', tarfile.REGTYPE)], tarfile.USTAR_FORMAT),
                       made([('../' + 'y' * 120, b'x', tarfile.REGTYPE)], tarfile.GNU_FORMAT)],
        'BadHeader': [bytes(corrupt), bytes(badnumber)],
        'Truncated': [plain[:520], plain[:100]],
    }
    lines = ['// Generated by compiler/fixtures/compression/tar.py from GNU tar and Python tarfile archives.',
             'import silk.mem.allocator {Allocator, OutOfMemoryError}',
             'import silk.core.effect {Effect}',
             'import silk.compress.tar {TarError, TarKind, TarMember, TarReader}',
             'import silk.collections.bytes {Bytes}',
             'import silk.compress.checksum {CompressionChecksum}',
             'import silk.core.option {Option}',
             'import silk.core.result {Result}',
             'import silk.num.u32',
             'import silk.num.usize',
             '',
             SOURCE]
    lines.append('effect fn program() -> i32 ! OutOfMemoryError | TarError ? &mut Allocator {')
    code = 1
    cases = {name: trimmed(archive) for name, archive in cases.items()}
    for name, archive in cases.items():
        lines.append(f'  // {name}')
        lines.append(f'  if !same(Bytes.asSlice(&run listing({literal(archive)})), {literal(listing(archive))}) {{ return {code} }}')
        code += 1
    for error, archives in refused.items():
        for archive in archives:
            archive = trimmed(archive) if error == 'UnsafePath' else archive
            lines.append(f'  if !run refuses({literal(archive)}, TarError.{error}) {{ return {code} }}')
            code += 1
    lines.append('  return 42')
    lines.append('}')
    lines.append('')
    lines.append('pub effect fn main() -> i32 ! OutOfMemoryError | TarError {')
    lines.append('  let mut allocator = Allocator.systemAllocatorProvider()')
    lines.append('  return run program() |> Effect.provideMut<Allocator>(&mut allocator)')
    lines.append('}')
    directory = ROOT / 'corpus/native/tar-read'
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

// One line per member: its kind, whether it is executable, its path, and the length and CRC-32 of
// its content, or of its link target for a link.
effect fn listing(archive: &[u8]) -> Bytes ! OutOfMemoryError | TarError ? &mut Allocator {
  let mut reader = TarReader.open(archive)
  let mut text = Bytes.make()
  while true {
    let next = match TarReader.next(&mut reader) {
      Result.Success {value} => move value
      Result.Failure {error} => { fail error }
    }
    let member = match move next {
      Option<TarMember>.Some {value} => move value
      Option<TarMember>.None => { return move text }
    }
    let kind = match member.kind {
      TarKind.File => b"f"
      TarKind.Directory => b"d"
      TarKind.SymbolicLink => b"s"
      TarKind.HardLink => b"h"
      TarKind.Other => b"o"
    }
    let data = if member.kind == TarKind.SymbolicLink || member.kind == TarKind.HardLink { member.link } else { member.content }
    run Bytes.append(&mut text, kind)
    run Bytes.append(&mut text, if member.executable { b"x " } else { b"- " })
    if member.prefix.length > 0 {
      run Bytes.append(&mut text, member.prefix)
      run Bytes.append(&mut text, b"/")
    }
    run Bytes.append(&mut text, member.name)
    run Bytes.append(&mut text, b" ")
    run appendDecimal(&mut text, data.length)
    run Bytes.append(&mut text, b" ")
    run appendHex(&mut text, CompressionChecksum.crc32(data))
    run Bytes.append(&mut text, b"\\n")
  }
  return move text
}

// Whether reading all of `archive` fails with `expected`.
effect fn refuses(archive: &[u8], expected: TarError) -> bool ! OutOfMemoryError ? &mut Allocator {
  return match move run Effect.result(listing(archive)) {
    Result<Bytes, OutOfMemoryError | TarError>.Success {..} => false
    Result<Bytes, OutOfMemoryError | TarError>.Failure {error} => match move error {
      TarError refused => refused == expected
      OutOfMemoryError exhausted => { fail move exhausted }
    }
  }
}
'''

if __name__ == '__main__':
    main()
