# Random Silk program generator with a Python reference result.
import random, sys

I64 = (-(1 << 63), (1 << 63) - 1)

class Overflow(Exception): pass

def chk(v):
    if v < I64[0] or v > I64[1]: raise Overflow()
    return v

def tdiv(a, b):
    if b == 0: raise Overflow()
    q = abs(a) // abs(b)
    q = q if (a >= 0) == (b >= 0) else -q
    return chk(q)

def trem(a, b):
    return chk(a - b * tdiv(a, b))

def lit(v):
    return str(v) if v >= 0 else f"-{-v}"

class Gen:
    def __init__(self, seed):
        self.r = random.Random(seed)
        self.env = {}        # name -> value
        self.lines = []
        self.funcs = []      # (name, params, body_fn, src)
        self.n = 0
        self.indent = 1

    def fresh(self, p='v'):
        self.n += 1
        return f"{p}{self.n}"

    def const(self):
        r = self.r.random()
        if r < 0.5: return self.r.randint(-20, 20)
        if r < 0.8: return self.r.randint(-100000, 100000)
        return self.r.randint(-(1 << 40), 1 << 40)

    # returns (src, value) or raises Overflow
    def expr(self, depth, env):
        r = self.r.random()
        if depth <= 0 or r < 0.25:
            if env and self.r.random() < 0.7:
                k = self.r.choice(list(env))
                return k, env[k]
            c = self.const()
            return f"k({lit(c)})", c
        if r < 0.75:
            op = self.r.choice(['+', '-', '*', '/', '%', '&', '|', '^'])
            a, av = self.expr(depth - 1, env)
            b, bv = self.expr(depth - 1, env)
            if op == '+': v = chk(av + bv)
            elif op == '-': v = chk(av - bv)
            elif op == '*': v = chk(av * bv)
            elif op == '/': v = tdiv(av, bv)
            elif op == '%': v = trem(av, bv)
            elif op == '&': v = av & bv
            elif op == '|': v = av | bv
            else: v = av ^ bv
            return f"({a} {op} {b})", v
        if r < 0.85 and self.funcs:
            name, params, fn, _ = self.r.choice(self.funcs)
            args = [self.expr(depth - 1, env) for _ in params]
            v = fn(*[x[1] for x in args])
            return f"{name}({', '.join(a for a, _ in args)})", v
        # if-expression via helper: use match on a bool-ish
        c, cv = self.cond(depth - 1, env)
        a, av = self.expr(depth - 1, env)
        b, bv = self.expr(depth - 1, env)
        return f"pick({c}, {a}, {b})", (av if cv else bv)

    def cond(self, depth, env):
        r = self.r.random()
        if depth <= 0 or r < 0.6:
            op = self.r.choice(['<', '<=', '>', '>=', '==', '!='])
            a, av = self.expr(depth - 1, env)
            b, bv = self.expr(depth - 1, env)
            v = {'<': av < bv, '<=': av <= bv, '>': av > bv, '>=': av >= bv, '==': av == bv, '!=': av != bv}[op]
            # finding 29: `a < b ... c > (d)` misparses, so emit > and >= with swapped operands
            if op in ('>', '>='):
                return f"({b} {'<' if op == '>' else '<='} {a})", v
            return f"({a} {op} {b})", v
        if r < 0.8:
            a, av = self.cond(depth - 1, env)
            b, bv = self.cond(depth - 1, env)
            op = self.r.choice(['&&', '||'])
            # both sides are evaluated by python, but overflow in a short-circuited side must not matter:
            # we only generate non-overflowing sides anyway.
            return f"({a} {op} {b})", (av and bv) if op == '&&' else (av or bv)
        a, av = self.cond(depth - 1, env)
        return f"!{a}", not av

    def try_(self, f, tries=30):
        for _ in range(tries):
            try: return f()
            except Overflow: pass
        return None

    def emit(self, s):
        self.lines.append('  ' * self.indent + s)

    def make_func(self):
        name = self.fresh('f')
        params = ['a', 'b']
        # build body expression over symbolic a, b, evaluate lazily by re-evaluating source with python
        g = Gen(self.r.random())
        g.funcs = list(self.funcs)
        probe = {'a': 0, 'b': 0}
        for _ in range(20):
            try:
                src, _ = g.expr(3, {'a': 7, 'b': -3})
                break
            except Overflow:
                src = None
        if src is None: return
        def fn(a, b, src=src):
            return evaluate(src, {'a': a, 'b': b}, self.funcs)
        self.funcs.append((name, params, fn, f"fn {name}(a: i64, b: i64) -> i64 {{\n  return {src}\n}}\n"))

    def stmt(self, depth=0):
        r = self.r.random()
        if r < 0.08:
            c = self.const()
            name = self.fresh()
            self.emit(f"let mut {name}: i64 = {lit(c)}")
            self.env[name] = c
        elif r < 0.35 or not self.env:
            res = self.try_(lambda: self.expr(3, self.env))
            if res is None: return
            name = self.fresh()
            self.emit(f"let mut {name}: i64 = {res[0]}")
            self.env[name] = res[1]
        elif r < 0.6:
            name = self.r.choice(list(self.env))
            res = self.try_(lambda: self.expr(3, self.env))
            if res is None: return
            self.emit(f"{name} = {res[0]}")
            self.env[name] = res[1]
        elif r < 0.75 and depth < 2:
            c = self.try_(lambda: self.cond(2, self.env))
            if c is None: return
            saved = dict(self.env)
            self.emit(f"if {c[0]} {{")
            self.indent += 1
            # then-branch
            then_env_before = dict(self.env)
            for _ in range(self.r.randint(1, 3)): self.assign_only()
            then_env = dict(self.env)
            self.indent -= 1
            self.emit("} else {")
            self.indent += 1
            self.env = dict(then_env_before)
            for _ in range(self.r.randint(1, 3)): self.assign_only()
            else_env = dict(self.env)
            self.indent -= 1
            self.emit("}")
            self.env = then_env if c[1] else else_env
        elif r < 0.9 and depth < 2:
            # bounded loop with accumulator
            counter = self.fresh('i')
            n = self.r.randint(0, 12)
            target = self.r.choice(list(self.env))
            step = self.try_(lambda: self.expr(2, {k: v for k, v in self.env.items() if k != target}))
            if step is None: return
            v = self.env[target]
            try:
                for i in range(n):
                    v = chk(v + step[1] + i)
            except Overflow:
                return
            self.emit(f"let mut {counter}: i64 = 0")
            self.emit(f"while {counter} < {n} {{")
            self.emit(f"  {target} = {target} + {step[0]} + {counter}")
            self.emit(f"  {counter} = {counter} + 1")
            self.emit("}")
            self.env[target] = v
        else:
            # array and struct round trip
            vals = []
            for _ in range(4):
                res = self.try_(lambda: self.expr(2, self.env))
                if res is None: return
                vals.append(res)
            arr = self.fresh('arr')
            idx = self.r.randint(0, 3)
            name = self.fresh()
            self.emit(f"let {arr}: [i64; 4] = [{', '.join(v[0] for v in vals)}]")
            self.emit(f"let {name}p = Pair {{ x: {arr}[{idx}], y: {arr}[{(idx + 1) % 4}] }}")
            try:
                val = chk(vals[idx][1] - vals[(idx + 1) % 4][1])
            except Overflow:
                val = None
            if val is None:
                self.emit(f"let mut {name}: i64 = {name}p.x")
                self.env[name] = vals[idx][1]
            else:
                self.emit(f"let mut {name}: i64 = {name}p.x - {name}p.y")
                self.env[name] = val

    def assign_only(self):
        if not self.env: return
        name = self.r.choice(list(self.env))
        res = self.try_(lambda: self.expr(3, self.env))
        if res is None: return
        self.emit(f"{name} = {res[0]}")
        self.env[name] = res[1]

def evaluate(src, env, funcs):
    # evaluate generated source with python semantics (truncating / %, overflow checks)
    import re
    fmap = {name: fn for name, _, fn, _ in funcs}
    py = src.replace('&&', ' and ').replace('||', ' or ')
    py = re.sub(r'!(?!=)', ' not ', py)
    class N(int): pass
    # use a tiny evaluator via python ast with custom ops
    import ast
    tree = ast.parse(py, mode='eval')
    def ev(n):
        if isinstance(n, ast.Expression): return ev(n.body)
        if isinstance(n, ast.Constant): return n.value
        if isinstance(n, ast.Name): return env[n.id]
        if isinstance(n, ast.BinOp):
            a, b = ev(n.left), ev(n.right)
            t = type(n.op)
            if t is ast.Add: return chk(a + b)
            if t is ast.Sub: return chk(a - b)
            if t is ast.Mult: return chk(a * b)
            if t is ast.Div: return tdiv(a, b)
            if t is ast.Mod: return trem(a, b)
            if t is ast.BitAnd: return a & b
            if t is ast.BitOr: return a | b
            if t is ast.BitXor: return a ^ b
        if isinstance(n, ast.Compare):
            a, b = ev(n.left), ev(n.comparators[0])
            t = type(n.ops[0])
            return {ast.Lt: a < b, ast.LtE: a <= b, ast.Gt: a > b, ast.GtE: a >= b, ast.Eq: a == b, ast.NotEq: a != b}[t]
        if isinstance(n, ast.BoolOp):
            if isinstance(n.op, ast.And):
                return all(ev(v) for v in n.values)
            return any(ev(v) for v in n.values)
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not): return not ev(n.operand)
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub): return chk(-ev(n.operand))
        if isinstance(n, ast.Call):
            name = n.func.id
            if name == 'k':
                return ev(n.args[0])
            if name == 'pick':
                c, a, b = ev(n.args[0]), ev(n.args[1]), ev(n.args[2])
                return a if c else b
            return fmap[name](*[ev(a) for a in n.args])
        raise ValueError(ast.dump(n))
    return ev(tree)

def program(seed, nstmts=40):
    g = Gen(seed)
    for _ in range(g.r.randint(0, 4)): g.make_func()
    for _ in range(nstmts): g.stmt()
    out = []
    out.append("import silk.core.effect { Effect }\nimport silk.io.logger { LogError }\nimport silk.io.logger_native { StdoutLogger }\n")
    out.append("struct Pair {\n  x: i64\n  y: i64\n}\n")
    out.append("fn k(v: i64) -> i64 {\n  return v\n}\n")
    out.append("fn pick(c: bool, a: i64, b: i64) -> i64 {\n  if c {\n    return a\n  }\n  return b\n}\n")
    for f in g.funcs: out.append(f[3])
    out.append("pub effect fn main() -> () ! LogError {\n  let mut logger = StdoutLogger.make()")
    out.extend(g.lines)
    expected = []
    for name, v in g.env.items():
        out.append(f'  run Effect.log("{name}={{v}}\\n", &.{{ v: {name} }}) |> Effect.provideMut(&mut logger)')
        expected.append(f"{name}={v}")
    out.append("}\n")
    return "\n".join(out), "\n".join(expected) + ("\n" if expected else "")

if __name__ == '__main__':
    seed = int(sys.argv[1])
    src, exp = program(seed)
    open(sys.argv[2], 'w').write(src)
    open(sys.argv[3], 'w').write(exp)
