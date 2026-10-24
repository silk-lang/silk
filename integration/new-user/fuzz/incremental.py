# Random edits to a multi-module package, rebuilt incrementally after each one, compared with a
# Python model of what the program prints. Every few steps a clean copy is built too, and its output
# must match. Edits: constants, function bodies, a struct field added or removed (read across a
# module boundary), the import graph, renames with their callers, whitespace, comments, rewriting a
# file unchanged, and a type error that the next step fixes.
#
# python3 -I fuzz/incremental.py <empty dir> <seed> <steps> [modules]
# Runs the `silk` on PATH. Prints one line per step and MISMATCH or BUILD-FAILED on a problem.
import os, random, shutil, subprocess, sys, time

out, seed, steps = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
K = int(sys.argv[4]) if len(sys.argv) > 4 else 6
r = random.Random(seed)
pkg = os.path.join(out, 'inc')
clean = os.path.join(out, 'clean')

mods = [{'c': r.randint(1, 50), 'k': r.randint(1, 9), 'field': False, 'dep': i - 1, 'name': f'f{i}', 'pad': 0, 'note': 0}
        for i in range(K)]

def value(i, x):
    m = mods[i]
    s = x + m['c'] + (m['k'] if m['field'] else 0)
    return x * m['k'] + m['c'] + s + (value(m['dep'], x) if m['dep'] >= 0 else 0)

def total(i, x):
    m = mods[i]
    return x + m['c'] + (m['k'] if m['field'] else 0)

def module(i, broken=False):
    m = mods[i]
    dep = m['dep']
    lines = []
    if dep >= 0:
        lines.append(f'import gen.m{dep} as D\n')
    lines.append('\n' * m['pad'])
    if m['note']:
        lines.append(f'// note {m["note"]}\n')
    lines.append(f'pub const C: i64 = {m["c"]}\n\n')
    field = '  pub c: i64,\n' if m['field'] else ''
    lines.append(f'pub struct S {{\n  pub a: i64,\n  pub b: i64,\n{field}}}\n\n')
    init = f', c: {m["k"]}' if m['field'] else ''
    lines.append(f'pub fn mk(x: i64) -> S {{\n  return S {{ a: x, b: C{init} }}\n}}\n\n')
    extra = ' + s.c' if m['field'] else ''
    lines.append(f'pub fn total(s: &S) -> i64 {{\n  return s.a + s.b{extra}\n}}\n\n')
    call = f' + D.{mods[dep]["name"]}(x)' if dep >= 0 else ''
    ret = '"oops"' if broken else f'x * {m["k"]} + C + total(&s){call}'
    lines.append(f'pub fn {m["name"]}(x: i64) -> i64 {{\n  let s = mk(x)\n  return {ret}\n}}\n')
    return ''.join(lines)

def main_module():
    imports = ''.join(f'import gen.m{i} as M{i}\n' for i in range(K))
    body = ''
    for i in range(K):
        body += f'  run show(M{i}.{mods[i]["name"]}(3))\n'
        body += f'  let s{i} = M{i}.mk(5)\n  run show(M{i}.total(&s{i}))\n'
    return f'''import silk.effect {{ Effect }}
import silk.logger {{ LogError, Logger }}
import silk.os_logger {{ StdoutLogger }}
{imports}
effect fn show(v: i64) -> () ! LogError ? &mut Logger {{
  run Effect.log("{{v}}\\n", &.{{ v: v }})
}}

pub effect fn main() -> () ! LogError {{
  let mut logger = StdoutLogger.make()
  run body() |> Effect.provideMut<Logger>(&mut logger)
}}

effect fn body() -> () ! LogError ? &mut Logger {{
{body}}}
'''

def expected():
    return ''.join(f'{value(i, 3)}\n{total(i, 5)}\n' for i in range(K))

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)

def write_all(root):
    for i in range(K):
        write(os.path.join(root, f'src/gen/m{i}.silk'), module(i))
    write(os.path.join(root, 'src/main.silk'), main_module())

def build_and_run(root):
    start = time.time()
    b = subprocess.run(['silk', 'build'], cwd=root, capture_output=True, text=True)
    seconds = time.time() - start
    if b.returncode != 0:
        return None, b.stderr, seconds
    binary = os.path.join(root, 'build/llvm/x86_64-unknown-linux-gnu/debug/inc')
    p = subprocess.run([binary], capture_output=True, text=True)
    return p.stdout, b.stderr, seconds

subprocess.run(['silk', 'init', 'inc'], cwd=out, capture_output=True, check=True)
write_all(pkg)
got, err, secs = build_and_run(pkg)
if got != expected():
    print('MISMATCH at start', err[-2000:]); sys.exit(1)
print(f'start: {secs:.2f} s')

problems = 0
pending_fix = None
for step in range(1, steps + 1):
    i = r.randrange(K)
    m = mods[i]
    kind = r.choice(['const', 'mult', 'field', 'field', 'dep', 'rename', 'pad', 'note', 'touch', 'broken'])
    if pending_fix is not None:
        kind = 'fix'
        i = pending_fix
        pending_fix = None
    if kind == 'const': m['c'] = r.randint(1, 50)
    elif kind == 'mult': m['k'] = r.randint(1, 9)
    elif kind == 'field': m['field'] = not m['field']
    elif kind == 'dep': m['dep'] = r.randrange(-1, i) if i > 0 else -1
    elif kind == 'rename':
        m['name'] = f'f{i}v{step}'
        for j in range(K):
            if mods[j]['dep'] == i:
                write(os.path.join(pkg, f'src/gen/m{j}.silk'), module(j))
        write(os.path.join(pkg, 'src/main.silk'), main_module())
    elif kind == 'pad': m['pad'] = r.randint(0, 3)
    elif kind == 'note': m['note'] = step
    path = os.path.join(pkg, f'src/gen/m{i}.silk')
    if kind == 'broken':
        write(path, module(i, broken=True))
        got, err, secs = build_and_run(pkg)
        ok = got is None and 'SEM0129' in err
        print(f'step {step}: broken m{i}: {"refused" if ok else "NOT REFUSED"} {secs:.2f} s')
        if not ok:
            problems += 1
            print(err[-1500:])
        pending_fix = i
        continue
    write(path, module(i))
    got, err, secs = build_and_run(pkg)
    want = expected()
    status = 'ok'
    if got is None:
        status = 'BUILD-FAILED'
    elif got != want:
        status = 'MISMATCH'
    codegen = next((l.strip() for l in err.splitlines() if l.strip().startswith('codegen')), '')
    print(f'step {step}: {kind} m{i}: {status} {secs:.2f} s {codegen}')
    if status != 'ok':
        problems += 1
        print(err[-2000:])
        if got is not None:
            print('got', got.split(), 'want', want.split())
        break
    if step % 10 == 0:
        if os.path.exists(clean):
            shutil.rmtree(clean)
        shutil.copytree(pkg, clean, ignore=shutil.ignore_patterns('build'))
        fresh, ferr, _ = build_and_run(clean)
        if fresh != got:
            problems += 1
            print(f'step {step}: CLEAN BUILD DIFFERS', ferr[-1500:])
            break
print(f'done: {problems} problems')
sys.exit(1 if problems else 0)
