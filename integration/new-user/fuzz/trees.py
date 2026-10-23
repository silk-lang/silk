# Random expression trees in Box-based unions: evaluated by reference, by a closure-driven visitor,
# and by consuming the tree, compared with Python.
import random, sys
seed=int(sys.argv[1]); out=sys.argv[2]; exp=sys.argv[3]
r=random.Random(seed)
M=(1<<61)-1
def tree(d):
    k=r.random()
    if d==0 or k<0.25:
        v=r.randrange(-1000,1000); return (f'run num({v})', v % M, 1)
    if k<0.5:
        a=tree(d-1); b=tree(d-1); return (f'run add({a[0]}, {b[0]})', (a[1]+b[1])%M, a[2]+b[2]+1)
    if k<0.8:
        a=tree(d-1); b=tree(d-1); return (f'run mul({a[0]}, {b[0]})', (a[1]*b[1])%M, a[2]+b[2]+1)
    a=tree(d-1); return (f'run neg({a[0]})', (-a[1])%M, a[2]+1)
lines=[]; expect=[]
for i in range(r.randint(3,12)):
    src,val,count=tree(r.randint(1,7))
    lines.append(f'  let t{i} = {src}')
    lines.append(f'  run show(eval(&t{i}))'); expect.append(str(val))
    lines.append(f'  let mut seen{i}: i64 = 0')
    lines.append(f'  drop visit(&t{i}, fn() -> () {{ seen{i} = seen{i} + 1 }})'.replace('fn() -> () { seen','fn() -> () {\n    seen').replace(' + 1 }', ' + 1\n  }'))
    lines.append(f'  run show(seen{i})'); expect.append(str(count))
    lines.append(f'  run show(consume(move t{i}))'); expect.append(str(val))
body='\n'.join(lines)
src=f'''import silk.allocator {{ Allocator, OutOfMemoryError }}
import silk.box {{ Box }}
import silk.effect {{ Effect }}
import silk.logger {{ LogError, Logger }}
import silk.os_logger {{ StdoutLogger }}

const M: i64 = 2305843009213693951

union Expr {{
  Num {{ pub v: i64 }},
  Add {{ pub l: Box<Expr>, pub r: Box<Expr> }},
  Mul {{ pub l: Box<Expr>, pub r: Box<Expr> }},
  Neg {{ pub e: Box<Expr> }},
}}

fn md(v: i64) -> i64 {{
  let m = v % M
  if m < 0 {{
    return m + M
  }}
  return m
}}

// (a * b) mod M without overflow: double-and-add.
fn mulmod(a: i64, b: i64) -> i64 {{
  let mut result: i64 = 0
  let mut x = md(a)
  let mut y = md(b)
  while y > 0 {{
    if y % 2 == 1 {{
      result = md(result + x)
    }}
    x = md(x + x)
    y = y / 2
  }}
  return result
}}

effect fn num(v: i64) -> Expr ! OutOfMemoryError ? &mut Allocator {{
  return Expr.Num {{ v: md(v) }}
}}

effect fn add(l: Expr, r: Expr) -> Expr ! OutOfMemoryError ? &mut Allocator {{
  return Expr.Add {{ l: run Box<Expr>.make(move l), r: run Box<Expr>.make(move r) }}
}}

effect fn mul(l: Expr, r: Expr) -> Expr ! OutOfMemoryError ? &mut Allocator {{
  return Expr.Mul {{ l: run Box<Expr>.make(move l), r: run Box<Expr>.make(move r) }}
}}

effect fn neg(e: Expr) -> Expr ! OutOfMemoryError ? &mut Allocator {{
  return Expr.Neg {{ e: run Box<Expr>.make(move e) }}
}}

fn eval(e: &Expr) -> i64 {{
  return match &e.* {{
    Expr.Num {{ v }} => v
    Expr.Add {{ l, r }} => md(eval(&l.get()[0]) + eval(&r.get()[0]))
    Expr.Mul {{ l, r }} => mulmod(eval(&l.get()[0]), eval(&r.get()[0]))
    Expr.Neg {{ e: inner }} => md(0 - eval(&inner.get()[0]))
  }}
}}

fn visit<F: mut fn() -> ()>(e: &Expr, mut f: F) -> F {{
  f()
  return match &e.* {{
    Expr.Num {{ .. }} => move f
    Expr.Add {{ l, r }} => visit(&r.get()[0], visit(&l.get()[0], move f))
    Expr.Mul {{ l, r }} => visit(&r.get()[0], visit(&l.get()[0], move f))
    Expr.Neg {{ e: inner }} => visit(&inner.get()[0], move f)
  }}
}}

fn consume(e: Expr) -> i64 {{
  return match move e {{
    Expr.Num {{ v }} => v
    Expr.Add {{ l, r }} => md(consume(Box<Expr>.into(move l)) + consume(Box<Expr>.into(move r)))
    Expr.Mul {{ l, r }} => mulmod(consume(Box<Expr>.into(move l)), consume(Box<Expr>.into(move r)))
    Expr.Neg {{ e: inner }} => md(0 - consume(Box<Expr>.into(move inner)))
  }}
}}

effect fn show(v: i64) -> () ! LogError ? &mut Logger {{
  run Effect.log("{{v}}\\n", &.{{ v: v }})
}}

effect fn body() -> () ! LogError | OutOfMemoryError ? &mut Logger | &mut Allocator {{
{body}
}}

pub effect fn main() -> () ! LogError | OutOfMemoryError {{
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut logger = StdoutLogger.make()
  run body() |> Effect.provideMut<Logger>(&mut logger) |> Effect.provideMut<Allocator>(&mut allocator)
}}
'''
open(out,'w').write(src); open(exp,'w').write('\n'.join(expect)+'\n')
