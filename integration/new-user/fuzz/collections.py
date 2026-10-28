# Differential test of HashMap<Word, i64>, HashSet<Word> and List<i64> against a Python model.
import random, sys
seed=int(sys.argv[1]); out=sys.argv[2]; exp=sys.argv[3]
r=random.Random(seed)
lines=[]; expect=[]
m={}; s=set(); l=[]
keyspace=r.choice([8, 64, 2000])
def opt(v): return 'none' if v is None else str(v)
n=r.randint(200, 1500)
for i in range(n):
    op=r.random()
    k=r.randrange(keyspace); v=r.randrange(-10**12, 10**12)
    if op<0.30:
        old=m.get(k); m[k]=v
        lines.append(f'  run show(opt(run map.insert(Hash.word({k}), {v})))')
        expect.append(opt(old))
    elif op<0.42:
        old=m.pop(k, None)
        lines.append(f'  run show(opt(map.remove(Hash.word({k}))))'); expect.append(opt(old))
    elif op<0.52:
        lines.append(f'  run show(opt(map.get(Hash.word({k}))))'); expect.append(opt(m.get(k)))
    elif op<0.58:
        lines.append(f'  run showLen(map.length())'); expect.append(str(len(m)))
    elif op<0.66:
        had=k in s; s.add(k)
        lines.append(f'  run showBool(run set.insert(Hash.word({k})))'); expect.append('true' if had else 'false')
    elif op<0.70:
        lines.append(f'  run showBool(set.contains(Hash.word({k})))'); expect.append('true' if k in s else 'false')
    elif op<0.82:
        l.append(v); lines.append(f'  run list.append({v})'); 
    elif op<0.86:
        p=l.pop() if l else None
        lines.append(f'  run show(opt(list.pop()))'); expect.append(opt(p))
    elif op<0.89 and l:
        j=r.randrange(len(l)); x=l.pop(j)
        lines.append(f'  run show(list.remove({j}))'); expect.append(str(x))
    elif op<0.92 and l:
        j=r.randrange(len(l)+1); l.insert(j, v)
        lines.append(f'  run list.insert({j}, {v})')
    elif op<0.94:
        l.sort(); lines.append('  run list.sort()')
    elif op<0.97 and l:
        j=r.randrange(len(l)); lines.append(f'  run show(list.get({j}))'); expect.append(str(l[j]))
    else:
        lines.append(f'  run showLen(list.length())'); expect.append(str(len(l)))
# final dump: list in order, map sum
lines.append('  run dumpList(&list)')
expect.extend(str(x) for x in l)
lines.append('  run showLen(map.length())'); expect.append(str(len(m)))
src=f'''import silk.mem.allocator {{ Allocator, OutOfMemoryError }}
import silk.core.effect {{ Effect }}
import silk.collections.hash {{ Hash, Word }}
import silk.collections.hash_map {{ HashMap }}
import silk.collections.hash_set {{ HashSet }}
import silk.collections.list {{ List }}
import silk.io.logger {{ LogError, Logger }}
import silk.option {{ Option }}
import silk.io.logger_native {{ StdoutLogger }}

fn opt(value: Option<i64>) -> i64 {{
  return match move value {{
    Option.Some {{ value: found }} => found
    Option.None => -999999999999999
  }}
}}

effect fn show(value: i64) -> () ! LogError ? &mut Logger {{
  if value == -999999999999999 {{
    run Effect.log("none\\n", &())
    return ()
  }}
  run Effect.log("{{value}}\\n", &.{{ value: value }})
}}

effect fn showLen(value: usize) -> () ! LogError ? &mut Logger {{
  run Effect.log("{{value}}\\n", &.{{ value: value }})
}}

effect fn showBool(value: bool) -> () ! LogError ? &mut Logger {{
  run Effect.log("{{value}}\\n", &.{{ value: value }})
}}

effect fn dumpList(list: &List<i64>) -> () ! LogError ? &mut Logger {{
  let mut index: usize = 0
  while index < list.length() {{
    run show(list.get(index))
    index = index + 1
  }}
}}

effect fn body() -> () ! LogError | OutOfMemoryError ? &mut Logger | &mut Allocator {{
  let mut map = HashMap<Word, i64>.make(Hash.seed({seed}))
  let mut set = HashSet<Word>.make(Hash.seed({seed + 1}))
  let mut list = List<i64>.make()
{chr(10).join(lines)}
}}

pub effect fn main() -> () ! LogError | OutOfMemoryError {{
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut logger = StdoutLogger.make()
  run body() |> Effect.provideMut<Logger>(&mut logger) |> Effect.provideMut<Allocator>(&mut allocator)
}}
'''
open(out,'w').write(src); open(exp,'w').write('\n'.join(expect)+'\n')
