# Zstd differential: frames from the zstandard package (levels -5 to 22, checksums, content sizes,
# streamed frames with flushes, long windows, several frames, skippable frames) and corrupted
# copies, decoded by Silk in uneven pieces, compared with zstandard's own decoder.
import random, struct, subprocess, sys
import zstandard as z
binary, seed, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
r = random.Random(seed)
def payload():
    k = r.random(); n = r.choice([0, 1, 5, 100, 1000, 30000, 140000, 600000])
    if k < 0.25: return r.randbytes(n)
    if k < 0.5: return bytes(r.choice(b'ab') for _ in range(n))
    if k < 0.7: return (b'the quick brown fox ' * (n // 20 + 1))[:n]
    if k < 0.8: return bytes([r.randrange(256)]) * n
    words = [r.randbytes(r.randint(1, 8)) for _ in range(30)]
    return b''.join(r.choice(words) for _ in range(n // 4))
def frame(data):
    level = r.choice([-5, -1, 1, 3, 5, 9, 15, 19, 22])
    params = dict(compression_level=level, write_checksum=r.random() < 0.5, write_content_size=r.random() < 0.7)
    if r.random() < 0.2: params['enable_ldm'] = True; params['window_log'] = r.randint(20, 27)
    cp = z.ZstdCompressionParameters.from_level(level, **{k: v for k, v in params.items() if k != 'compression_level'})
    c = z.ZstdCompressor(compression_params=cp)
    if r.random() < 0.5: return c.compress(data)
    o = c.compressobj(); out = b''; i = 0
    while i < len(data):
        k = r.randint(1, 100000); out += o.compress(data[i:i + k]); i += k
        if r.random() < 0.2: out += o.flush(z.COMPRESSOBJ_FLUSH_BLOCK)
    return out + o.flush()
def skippable():
    body = r.randbytes(r.randint(0, 50))
    return struct.pack('<II', 0x184D2A50 + r.randrange(16), len(body)) + body
def reference(stream):
    if not stream: raise z.ZstdError('empty')
    out = b''; rest = stream
    while rest:
        if len(rest) >= 8 and (struct.unpack('<I', rest[:4])[0] & 0xFFFFFFF0) == 0x184D2A50:
            size = struct.unpack('<I', rest[4:8])[0]
            if len(rest) < 8 + size: raise z.ZstdError('truncated skippable')
            rest = rest[8 + size:]; continue
        d = z.ZstdDecompressor(max_window_size=1 << 27).decompressobj()
        out += d.decompress(rest)
        if not d.eof: raise z.ZstdError('truncated frame')
        rest = d.unused_data
    return out
bad = 0
for n in range(count):
    parts = []
    for i in range(r.choice([1, 1, 1, 2, 3])):
        if r.random() < 0.15: parts.append(skippable())
        parts.append(frame(payload()))
    stream = b''.join(parts)
    corrupt = r.random() < 0.3
    if corrupt and stream:
        if r.random() < 0.4: stream = stream[:r.randrange(len(stream))]
        else:
            b = bytearray(stream); i = r.randrange(len(b)); b[i] ^= 1 << r.randrange(8); stream = bytes(b)
    try: expected = reference(stream); ok = True
    except z.ZstdError: ok = False
    p = subprocess.run([binary], input=b'\0' + stream, capture_output=True, timeout=300)
    if ok and (p.returncode != 0 or p.stdout != expected):
        open(f'fail-{seed}-{n}.bin', 'wb').write(stream); bad += 1
        print('MISMATCH valid', n, 'len', len(stream), 'corrupt', corrupt, '->', p.returncode, len(p.stdout), len(expected), p.stderr[:160])
    elif not ok and p.returncode == 0:
        open(f'fail-{seed}-{n}.bin', 'wb').write(stream); bad += 1
        print('ACCEPTED invalid', n, 'len', len(stream), len(p.stdout))
    elif not ok and b'ZstdError' not in p.stderr and p.returncode != 3:
        bad += 1; print('ODD rejection', n, p.returncode, p.stderr[:200])
print('done', count, 'bad', bad)
