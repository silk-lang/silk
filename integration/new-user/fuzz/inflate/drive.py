# Inflate differential: streams from Python's zlib (every level, strategy, window and memLevel; raw,
# zlib and gzip, multi-member gzip, gzip header fields) and corrupted copies, decoded by Silk in
# uneven pieces, compared with Python's own decoder.
import gzip, random, struct, subprocess, sys, zlib
binary, seed, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
r = random.Random(seed)
def payload():
    k = r.random(); n = r.choice([0, 1, 2, 10, 100, 1000, 30000, 70000, 300000])
    if k < 0.25: return r.randbytes(n)
    if k < 0.5: return bytes(r.choice(b'ab') for _ in range(n))
    if k < 0.7: return (b'the quick brown fox ' * (n // 20 + 1))[:n]
    if k < 0.85: return bytes([r.randrange(256)]) * n
    words = [r.randbytes(r.randint(1, 8)) for _ in range(20)]
    return b''.join(r.choice(words) for _ in range(n // 4))
def compress(data, wbits):
    c = zlib.compressobj(r.randint(0, 9), zlib.DEFLATED, wbits, r.randint(1, 9),
                         r.choice([zlib.Z_DEFAULT_STRATEGY, zlib.Z_FILTERED, zlib.Z_HUFFMAN_ONLY, zlib.Z_RLE, zlib.Z_FIXED]))
    out = b''; i = 0
    while i < len(data):
        k = r.randint(1, 50000); out += c.compress(data[i:i + k]); i += k
        if r.random() < 0.1: out += c.flush(r.choice([zlib.Z_SYNC_FLUSH, zlib.Z_FULL_FLUSH]))
    return out + c.flush()
def gzip_member(data):
    if r.random() < 0.6: return compress(data, 16 + r.randint(9, 15))
    flags = 0; extra = b''
    if r.random() < 0.5: flags |= 4; x = r.randbytes(r.randint(0, 40)); extra += struct.pack('<H', len(x)) + x
    if r.random() < 0.5: flags |= 8; extra += b'name-' + bytes(r.choice(b'abc') for _ in range(5)) + b'\0'
    if r.random() < 0.5: flags |= 16; extra += b'a comment\0'
    head = b'\x1f\x8b\x08' + bytes([flags]) + b'\0\0\0\0\0\xff' + extra
    if r.random() < 0.5:
        head = head[:3] + bytes([flags | 2]) + head[4:]
        head += struct.pack('<H', zlib.crc32(head) & 0xffff)
    return head + compress(data, -15) + struct.pack('<II', zlib.crc32(data), len(data) & 0xffffffff)
def reference(fmt, stream):
    if fmt == 2:
        # zlib checks reserved flags and the header CRC, which gzip.decompress skips.
        if not stream: raise zlib.error('empty')
        out = b''; rest = stream
        while rest:
            d = zlib.decompressobj(31); out += d.decompress(rest) + d.flush()
            if not d.eof: raise zlib.error('truncated member')
            rest = d.unused_data
        return out
    d = zlib.decompressobj(-15 if fmt == 0 else 15)
    out = d.decompress(stream) + d.flush()
    if not d.eof or d.unused_data: raise zlib.error('not at end')
    return out
bad = 0; checked = 0
for n in range(count):
    fmt = r.choice([0, 1, 2])
    data = payload()
    if fmt == 0: stream = compress(data, -r.randint(9, 15))
    elif fmt == 1: stream = compress(data, r.randint(9, 15))
    else: stream = b''.join(gzip_member(data if i == 0 else payload()) for i in range(r.choice([1, 1, 1, 2, 3])))
    corrupt = r.random() < 0.3
    if corrupt:
        k = r.random()
        if k < 0.4 and stream: stream = stream[:r.randrange(len(stream))]
        elif stream:
            b = bytearray(stream); i = r.randrange(len(b)); b[i] ^= 1 << r.randrange(8); stream = bytes(b)
    try: expected = reference(fmt, stream); ok = True
    except (zlib.error, EOFError, OSError, gzip.BadGzipFile): ok = False
    p = subprocess.run([binary], input=bytes([fmt]) + stream, capture_output=True, timeout=120)
    checked += 1
    if ok and (p.returncode != 0 or p.stdout != expected):
        open(f'fail-{seed}-{n}.bin','wb').write(bytes([fmt]) + stream); bad += 1; print('MISMATCH valid fmt', n, fmt, 'len', len(stream), 'corrupt', corrupt, '->', p.returncode, len(p.stdout), len(expected), p.stderr[:200])
    elif not ok and p.returncode == 0:
        bad += 1; print('ACCEPTED invalid fmt', fmt, 'len', len(stream), len(p.stdout))
    elif not ok and b'DecodeError' not in p.stderr and p.returncode != 3:
        bad += 1; print('ODD rejection fmt', fmt, p.returncode, p.stderr[:200])
print('done', checked, 'bad', bad)
