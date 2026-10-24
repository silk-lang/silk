# Messes up the layout of a package's src/main.silk that runs, then checks that `silk format`
# repairs it: every comment survives, a second format changes nothing, and the formatted program
# prints what the original printed.
#
# python3 -I fuzz/format-mutate.py <package> <seed> <count> [file]
# [file] is the source to mess up, relative to the package (default src/main.silk); the package's
# program must still print the same.
# Mutations: a `// cN` comment at the end of a line or on its own line, blank lines, wrong
# indentation, trailing spaces, and extra or missing spaces around `(`, `)`, `,`, `=`, `{` and
# operators on lines without string literals. Prints one line per case and FAIL on a problem.
import os, random, re, subprocess, sys

pkg, seed, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
r = random.Random(seed)
target = sys.argv[4] if len(sys.argv) > 4 else 'src/main.silk'
main = os.path.join(pkg, target)
original = open(main).read()

def run():
    b = subprocess.run(['silk', 'run', '--quiet'], cwd=pkg, capture_output=True, text=True)
    return b.returncode, b.stdout, b.stderr

def fmt():
    return subprocess.run(['silk', 'format', target], cwd=pkg, capture_output=True, text=True)

base = run()
if base[0] != 0:
    print('the original does not run', base[2][-1000:]); sys.exit(2)

def mutate(text):
    lines = text.split('\n')
    marks = 0
    out = []
    for line in lines:
        k = r.random()
        code = line.strip()
        plain = '"' not in line and "'" not in line and not code.startswith('//')
        if plain and code and k < 0.3:
            # Spaces around punctuation: added or removed.
            def respace(m):
                c = m.group(0).strip()
                return r.choice([c, f' {c} ', f'{c} ', f' {c}'])
            line = re.sub(r'\s*(?:[(),]|(?<![=<>!+\-*/%&|^:])=(?![=>]))\s*', respace, line)
        if code and r.random() < 0.15:
            line = (' ' * r.randint(0, 9)) + line.lstrip()
        if code and r.random() < 0.1:
            line += ' ' * r.randint(1, 4)
        if code and not code.startswith('//') and r.random() < 0.12 and plain:
            marks += 1
            line += f' // c{marks}'
        out.append(line)
        if r.random() < 0.08:
            out.append('')
        if code.endswith('{') and r.random() < 0.1:
            marks += 1
            out.append(f'// c{marks}')
    return '\n'.join(out), marks

problems = 0
for case in range(1, count + 1):
    text, marks = mutate(original)
    with open(main, 'w') as f:
        f.write(text)
    checked = subprocess.run(['silk', 'check', '--quiet'], cwd=pkg, capture_output=True, text=True)
    if checked.returncode != 0:
        # A mutation that broke the program (a space inside `->` or `::`, say) is not the formatter's fault.
        print(f'case {case}: mutation does not check; skipped')
        continue
    first = fmt()
    once = open(main).read()
    second = fmt()
    twice = open(main).read()
    kept = sorted(re.findall(r'// c\d+', once))
    want = sorted(f'// c{i}' for i in range(1, marks + 1))
    status = []
    if first.returncode != 0: status.append('format failed: ' + first.stderr[-300:])
    if kept != want: status.append(f'comments lost: {sorted(set(want) - set(kept))}')
    if once != twice: status.append('second format changed the file')
    result = run()
    if result[:2] != base[:2]: status.append(f'program changed: exit {result[0]}, {result[2][-300:]}')
    if status:
        problems += 1
        bad = os.path.join(pkg, f'case-{seed}-{case}.silk')
        with open(bad, 'w') as f:
            f.write(text)
        print(f'case {case}: FAIL ' + '; '.join(status) + f' (input kept in {bad})')
    else:
        print(f'case {case}: ok ({marks} comments)')
with open(main, 'w') as f:
    f.write(original)
print(f'done: {problems} problems')
sys.exit(1 if problems else 0)
