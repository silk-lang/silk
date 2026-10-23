# Path differential: Path.fromBytes, joinBytes, resolve and parent against a model of the
# documented rules, on random byte strings.
import random, subprocess, sys
binary, seed, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
r = random.Random(seed)
def valid_abs(s):
    if not s.startswith(b'/') or b'\0' in s: return False
    if s == b'/': return True
    return not s.endswith(b'/') and all(c not in (b'', b'.', b'..') for c in s[1:].split(b'/'))
def make(s): return s if valid_abs(s) else None
def join(base, frag):
    if not frag or frag.startswith(b'/') or frag.endswith(b'/') or b'\0' in frag: return None
    if any(c in (b'', b'.', b'..') for c in frag.split(b'/')): return None
    return (b'' if base == b'/' else base) + b'/' + frag
def resolve(base, rel):
    if rel == b'': return base
    if rel.startswith(b'/') or b'\0' in rel: return None
    if rel.endswith(b'/'): rel = rel[:-1]  # Silk accepts one trailing slash
    if rel == b'': return None
    parts = [c for c in base.split(b'/') if c]
    for c in rel.split(b'/'):
        if c == b'': return None
        if c == b'.': continue
        if c == b'..':
            if not parts: return None
            parts.pop()
        else: parts.append(c)
    return b'/' + b'/'.join(parts)
def parent(s):
    if s == b'/': return 'none'
    return s.rsplit(b'/', 1)[0] or b'/'
ATOMS = [b'a', b'bc', b'.', b'..', b'/', b'//', b'\xc3\xa9', b'\0', b' ', b'...', b'.a', b'\xff', b'\r', b'\\']
def piece(lead):
    s = (b'/' if lead and r.random() < 0.85 else b'') + b''.join(r.choice(ATOMS) for _ in range(r.randint(0, 6)))
    return s.replace(b'\n', b'').replace(b'\t', b'')
lines, expected = [], []
for _ in range(count):
    op = r.choice('MJRP')
    a = piece(True)
    if op == 'M':
        lines.append(b'M\t' + a); m = make(a); expected.append(b'ok ' + m if m is not None else b'err')
    elif op == 'P':
        lines.append(b'P\t' + a); m = make(a)
        expected.append(b'err' if m is None else (b'none' if parent(m) == 'none' else b'ok ' + parent(m)))
    else:
        b = piece(False); lines.append(op.encode() + b'\t' + a + b'\t' + b); m = make(a)
        if m is None: expected.append(b'base'); continue
        if op == 'J': res = join(m, b)
        else:
            try: b.decode('utf-8')
            except UnicodeDecodeError: expected.append(b'utf8'); continue
            res = resolve(m, b)
        expected.append(b'ok ' + res if res is not None else b'err')
p = subprocess.run([binary], input=b'\n'.join(lines) + b'\n', capture_output=True, timeout=120)
got = p.stdout.split(b'\n')[:-1]
bad = 0
for line, e, g in zip(lines, expected, got):
    if e != g:
        bad += 1
        if bad <= 15: print('MISMATCH', repr(line), 'expected', repr(e), 'got', repr(g))
print('done', len(lines), 'answers', len(got), 'status', p.returncode, 'bad', bad, p.stderr[:200])
