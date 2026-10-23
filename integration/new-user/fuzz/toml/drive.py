# TOML differential: random valid and mutated documents through Silk's Toml.parse + TomlOutput.write,
# compared with Python's tomllib (TOML 1.0, so 1.1-only syntax is never generated in valid documents).
import random, re, subprocess, sys, tomllib
binary, seed, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
r = random.Random(seed)
def key():
    return r.choice(['a', 'b', 'name', 'x-y', 'k_1', '1234', '"quoted key"', "'lit'", '"é"', '""', 'true', 'inf'])
def integer():
    k = r.random()
    if k < 0.4: return str(r.randint(-10**6, 10**6))
    if k < 0.5: return r.choice(['0x', '0o', '0b']) + r.choice(['1f', '17', '101', 'DEAD_beef', '0'])
    if k < 0.6: return r.choice(['+', '-', '']) + '1_000_000'
    return r.choice(['9223372036854775807', '-9223372036854775808', '+0', '-0'])
def flt():
    return r.choice(['3.14', '-0.0', '+1.5', '5e+22', '1e06', '-2E-2', '6.626e-34', '224_617.445_991', 'inf', '-inf', '+nan', '0.1', '1.0'])
def dt():
    return r.choice(['1979-05-27T07:32:00Z', '1979-05-27T00:32:00.999999-07:00', '1979-05-27 07:32:00Z', '1979-05-27T07:32:00', '1979-05-27', '07:32:00', '00:32:00.999999', '2000-02-29'])
def string():
    k = r.random()
    body = ''.join(r.choice(['a', 'b', ' ', 'é', '😀', '\\n', '\\t', '\\"', '\\\\', '\\u00e9', '\\U0001F600']) for _ in range(r.randint(0, 8)))
    if k < 0.5: return '"' + body + '"'
    lit = ''.join(r.choice(['a', ' ', '\\', '"', 'é']) for _ in range(r.randint(0, 8)))
    if k < 0.7: return "'" + lit + "'"
    if k < 0.85: return '"""\n' + body + '\\\n   more"""'
    return "'''" + lit + "\nline'''"
def value(d):
    k = r.random()
    if d <= 0 or k < 0.6:
        return r.choice([integer, flt, dt, string, lambda: r.choice(['true', 'false'])])()
    if k < 0.8:
        return '[' + ', '.join(value(d - 1) for _ in range(r.randint(0, 4))) + r.choice(['', ',']) + ']'
    keys = r.sample(['p', 'q', 'r.s', '"t u"'], r.randint(0, 3))
    return '{' + ', '.join(f'{k} = {value(d - 1)}' for k in keys) + '}'
def document():
    lines = []
    for _ in range(r.randint(0, 4)): lines.append(f'{key()} = {value(3)}')
    for t in range(r.randint(0, 3)):
        lines.append(r.choice([f'[t{t}]', f'[t{t}.sub]', f'[[arr]]', f'["q{t}".x]']) + r.choice(['', '  # comment']))
        for _ in range(r.randint(0, 3)): lines.append(f'{key()} = {value(2)}')
    return '\n'.join(lines) + r.choice(['', '\n', '\r\n'])
def mutate(s):
    k = r.random(); i = r.randrange(len(s) + 1)
    if k < 0.35 and s: return s[:i] + s[i + 1:]
    if k < 0.8: return s[:i] + r.choice(list('[]{}=,."\'#\n 0123456789:-+TZe_') + ['\x00', '\x7f', 'nan', '\\x41', '\\e', '00', '1979-13-01', '24:00:00']) + s[i:]
    return s + '\n' + s
def canon(v):
    if isinstance(v, dict): return {k: canon(x) for k, x in v.items()}
    if isinstance(v, list): return [canon(x) for x in v]
    if isinstance(v, float) and v != v: return 'nan'
    return v
bad = 0; valid = 0
for n in range(count):
    doc = document()
    mutated = r.random() < 0.5
    if mutated: doc = mutate(doc)
    data = doc.encode()
    try: expected = canon(tomllib.loads(doc)); ok = True; valid += 1
    except tomllib.TOMLDecodeError: ok = False
    p = subprocess.run([binary], input=data, capture_output=True, timeout=30)
    if ok:
        try: got = canon(tomllib.loads(p.stdout.decode()))
        except Exception as e: got = ('unparseable', str(e)[:80])
        if p.returncode != 0 or got != expected:
            bad += 1; print('MISMATCH valid', repr(doc)[:400], '\n  ->', p.returncode, repr(p.stdout[:300]), p.stderr[:150])
    elif p.returncode == 0:
        print('ACCEPTED-INVALID', repr(doc)[:300])
    elif p.returncode != 1 or b'TomlError' not in p.stderr:
        bad += 1; print('ODD rejection', repr(doc)[:200], p.returncode, p.stderr[:200])
print('done', count, 'valid', valid, 'bad', bad)
