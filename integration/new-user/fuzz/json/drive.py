# JSON differential: random valid and mutated documents through Silk's Json.parse + Json.write,
# compared with Python's strict json (duplicate keys and depth > 64 rejected).
import json, random, subprocess, sys
binary, seed, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
r = random.Random(seed)
def num():
    k = r.random()
    if k < 0.3: return str(r.randint(-10**6, 10**6))
    if k < 0.5: return str(r.choice([0, -0, 2**63, -2**63, 2**64, 10**40]))
    s = r.choice(['', '-']) + r.choice(['0', str(r.randint(1, 99999))])
    if r.random() < 0.6: s += '.' + str(r.randint(0, 10**6)).zfill(r.randint(1, 7))
    if r.random() < 0.4: s += r.choice(['e', 'E']) + r.choice(['', '+', '-']) + str(r.randint(0, 400))
    return s
def string():
    out = '"'
    for _ in range(r.randint(0, 12)):
        k = r.random()
        if k < 0.6: out += r.choice('abcxyz 019_~/')
        elif k < 0.75: out += r.choice(['\\"', '\\\\', '\\/', '\\b', '\\f', '\\n', '\\r', '\\t'])
        elif k < 0.85: out += '\\u%04x' % r.choice([0, 0x1f, 0x7f, 0xe9, 0x4e2d, 0xfffd, r.randint(0x20, 0xd7ff)])
        elif k < 0.92: out += '\\ud83d\\ude00'
        else: out += r.choice(['é', '中', '😀', ' '])
    return out + '"'
def ws():
    return r.choice(['', '', '', ' ', '\n', '\t', '\r\n  '])
def value(d):
    k = r.random()
    if d <= 0 or k < 0.35:
        return r.choice([num, string, lambda: r.choice(['true', 'false', 'null'])])()
    if k < 0.65:
        return '[' + ws() + (',' + ws()).join(value(d - 1) for _ in range(r.randint(0, 5))) + ws() + ']'
    keys = r.sample(['a', 'b', 'c', 'id', 'name', 'é', 'x y', '', 'A', '\\u0061b'], r.randint(0, 5))
    return '{' + ws() + ','.join(ws() + '"' + k + '"' + ws() + ':' + ws() + value(d - 1) for k in keys) + ws() + '}'
def mutate(s):
    k = r.random(); i = r.randrange(len(s) + 1)
    if k < 0.3 and s: return s[:i] + s[i + 1:]
    if k < 0.6: return s[:i] + r.choice(list('{}[],:"\\0123456789eE+-.tfnu ') + ['\x00', '\x1f', '\x7f', 'NaN', 'Infinity', '01', '1.', '.5', '//c', '﻿']) + s[i:]
    if k < 0.7: return s.replace(']', ',]', 1) if ']' in s else s + ','
    if k < 0.8: return s + r.choice([' x', '{}', '1', ' ', '\n'])
    return '[' * r.randint(60, 70) + '1' + ']' * r.randint(60, 70)
class LoneSurrogate(Exception): pass
def strict(text):
    def pairs(items):
        keys = [k for k, _ in items]
        if len(keys) != len(set(keys)): raise ValueError('duplicate key')
        return dict(items)
    def constant(c): raise ValueError(c)
    v = json.loads(text, object_pairs_hook=pairs, parse_constant=constant, parse_float=str, parse_int=str)
    def depth(x):
        if isinstance(x, (list, dict)):
            return 1 + max([depth(y) for y in (x.values() if isinstance(x, dict) else x)] or [0])
        return 0
    if depth(v) > 64: raise ValueError('depth')
    import re
    if re.search('[\ud800-\udfff]', json.dumps(v, ensure_ascii=False)): raise LoneSurrogate()
    return v
bad = 0
for n in range(count):
    doc = value(r.randint(0, 6))
    if r.random() < 0.5: doc = mutate(doc)
    if r.random() < 0.3: doc = ws() + doc + ws()
    data = doc.encode('utf-8', 'surrogatepass')
    try: expected = strict(data.decode('utf-8')); ok = True
    except LoneSurrogate: continue
    except (ValueError, UnicodeDecodeError, RecursionError): ok = False
    p = subprocess.run([binary], input=data, capture_output=True, timeout=30)
    if ok:
        try: got = strict(p.stdout.decode('utf-8'))
        except Exception as e: got = ('unparseable', str(e)[:60])
        if p.returncode != 0 or got != expected:
            bad += 1; print('MISMATCH valid', repr(doc)[:300], '->', p.returncode, repr(p.stdout[:200]), p.stderr[:120])
    elif p.returncode == 0:
        bad += 1; print('MISMATCH accepted invalid', repr(doc)[:300], '->', repr(p.stdout[:200]))
    elif p.returncode != 1 or b'JsonError' not in p.stderr:
        bad += 1; print('ODD rejection', repr(doc)[:200], p.returncode, p.stderr[:200])
print('done', count, 'bad', bad)
