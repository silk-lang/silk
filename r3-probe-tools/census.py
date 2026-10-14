"""Join PROBE R3 receipts: kind2 key->mask, kind3 encoding->key, kind4 emitted encoding. Per program."""
import collections, re, sys, json
NAMES = {1:'crossed',2:'typesOpen',4:'contents',8:'provStatic',16:'approxLoan',32:'outsideParamRel',64:'outsideLocalRel',
 128:'invocationRel',256:'suppliedRel',512:'meetRel',1024:'missingLoan',2048:'ambiguousLoan',4096:'inclusionFail',8192:'noLoans',
 16384:'T.outsideParam',32768:'T.outsideLocal',65536:'T.invocation',131072:'T.supplied',262144:'T.meet',1048576:'walked'}
groups = collections.defaultdict(lambda: {'maps': collections.defaultdict(set), 'inc': collections.defaultdict(set), 'emit': []})
for path in sys.argv[1:]:
  for line in open(path, errors='replace'):
    m = re.search(r'^R3_PROGRAM=(\S+)', line)
    g = groups[m[1] if m else 'self-build']
    p = re.search(r'; PROBE R3 (\d+) (\d+) (\d+) (\d+)\s*$', line)
    if not p: continue
    k, a, b, c = map(int, p.groups())
    if k == 2: g['maps'][a].add(c)
    elif k == 3: g['inc'][a].add(b)
    elif k == 4: g['emit'].append(a)
bits = collections.Counter(); masks = collections.Counter(); total = 0; missing = 0
perprog = {}
for prog, g in groups.items():
  n = 0
  for e in g['emit']:
    mk = 0; found = False
    for key in g['inc'].get(e, ()):
      for m in g['maps'].get(key, ()):
        mk |= m; found = True
    if not found: missing += 1
    total += 1; n += 1
    masks[mk & ~1048576] += 1
    for b in NAMES:
      if mk & b: bits[NAMES[b]] += 1
  perprog[prog] = n
print('total', total, 'missing', missing, 'programs', len(groups))
for k, v in bits.most_common(): print(f'{k:18} {v}')
print('top masks')
for m, v in masks.most_common(40):
  print(v, m, '+'.join(NAMES[b] for b in NAMES if m & b))
