# Huge and malformed sources: builds each case and prints exit status, time and the first error.
# A compiler crash (signal, trap, "compiler bug") is flagged CRASH.
# Usage: python3 huge-sources.py <workdir> [case...]
import os, subprocess, sys, time, shutil
W=sys.argv[1]; only=sys.argv[2:]
HDR='import silk.core.effect { Effect }\nimport silk.io.logger { LogError }\nimport silk.io.logger_native { StdoutLogger }\n\n'
def prog(body, extra=''):
    return HDR+extra+'\npub effect fn main() -> () ! LogError {\n  let mut logger = StdoutLogger.make()\n'+body+'\n}\n'
def logv(e): return f'  let v = {e}\n  run Effect.log("{{v}}\\n", &.{{ v: v }}) |> Effect.provideMut(&mut logger)'
cases = {
 'empty': b'',
 'bom': ('﻿'+prog(logv('1'))).encode(),
 'crlf': prog(logv('1')).replace('\n','\r\n').encode(),
 'nul': prog(logv('1')).encode().replace(b'let v', b'let\x00v'),
 'invalid-utf8': prog(logv('1')).encode().replace(b'let v', b'let \xff\xfe v'),
 'binary': os.urandom(20000),
 'only-comment': b'// nothing here\n',
 'paren-depth-200': prog(logv('('*200+'1'+')'*200)).encode(),
 'paren-depth-5000': prog(logv('('*5000+'1'+')'*5000)).encode(),
 'add-chain-20000': prog(logv(' + '.join(['1']*20000))).encode(),
 'nested-blocks-2000': prog('  let v = 1\n'+'  {\n'*2000+'  }\n'*2000+'  run Effect.log("{v}\\n", &.{ v: v }) |> Effect.provideMut(&mut logger)').encode(),
 'nested-if-1000': prog('  let mut v = 0\n'+''.join(f'  if v < {i+1} {{\n' for i in range(1000))+'  v = 5\n'+'  }\n'*1000+'  run Effect.log("{v}\\n", &.{ v: v }) |> Effect.provideMut(&mut logger)').encode(),
 'many-lets-30000': prog(''.join(f'  let x{i}: i64 = {i}\n' for i in range(30000))+logv('x29999')).encode(),
 'many-fns-10000': prog(logv('f9999()'), ''.join(f'fn f{i}() -> i32 {{\n  return {i}\n}}\n' for i in range(10000))).encode(),
 'call-chain-3000': prog(logv('f2999()'), 'fn f0() -> i32 {\n  return 1\n}\n'+''.join(f'fn f{i}() -> i32 {{\n  return f{i-1}() + 1\n}}\n' for i in range(1,3000))).encode(),
 'string-1mb': prog(logv('"'+'a'*1000000+'"')).replace('let v = "', 'let v: string<\'static> = "').encode(),
 'long-ident-100k': prog(logv('1').replace('let v', 'let '+'v'*100000).replace('v: v', 'v: '+'v'*100000)).encode(),
 'array-20000': prog('  let a: [i32; 20000] = ['+', '.join(['7']*20000)+']\n'+logv('a[19999]')).encode(),
 'struct-2000-fields': prog(logv('s.f1999'), 'struct S {\n'+''.join(f'  f{i}: i32\n' for i in range(2000))+'}\n').replace('let v = s.f1999', 'let s = S { '+', '.join(f'f{i}: {i}' for i in range(2000))+' }\n  let v = s.f1999').encode(),
 'union-2000-variants': prog(logv('1'), 'union U {\n'+''.join(f'  V{i},\n' for i in range(2000))+'}\n').encode(),
 'generic-depth-200': prog(logv('w199(1)'), 'fn w0<T>(v: T) -> T {\n  return v\n}\n'+''.join(f'fn w{i}<T>(v: T) -> T {{\n  return w{i-1}<T>(move v)\n}}\n' for i in range(1,200))).encode(),
 'recursive-struct': prog(logv('1'), 'struct A {\n  b: B\n}\nstruct B {\n  a: A\n}\n').encode(),
 'self-import': ('import main { x }\n'+prog(logv('1'))).encode(),
 'unterminated-string': prog(logv('"abc')).encode(),
 'unterminated-comment': (prog(logv('1'))+'/* never closed\n').encode(),
 'deep-generic-type': prog(logv('1'), 'struct Box<T> {\n  v: T\n}\nfn deep(b: '+'Box<'*300+'i32'+'>'*300+') -> i32 {\n  return 0\n}\n').encode(),
 'infinite-generic': prog(logv('grow<i32>(1)'), 'struct W<T> {\n  v: T\n}\nfn grow<T>(v: T) -> i32 {\n  return grow<W<T>>(W<T> { v: move v })\n}\n').encode(),
}

for n in (50, 100, 120, 127, 128, 129, 140, 200, 300, 500, 1000):
    cases[f'add-chain-{n}'] = prog(logv(' + '.join(['1']*n))).encode()
for n in (30, 40, 45, 50, 60, 100, 200, 400):
    cases[f'nested-if-{n}'] = prog('  let mut v = 0\n'+''.join(f'  if v < {i+1} {{\n' for i in range(n))+'  v = 5\n'+'  }\n'*n+'  run Effect.log("{v}\\n", &.{ v: v }) |> Effect.provideMut(&mut logger)').encode()
for n in (50, 100, 150):
    cases[f'paren-depth-{n}'] = prog(logv('('*n+'1'+')'*n)).encode()
for name, data in cases.items():
    if only and name not in only: continue
    d=os.path.join(W,name); shutil.rmtree(d, ignore_errors=True); os.makedirs(d+'/src')
    open(d+'/silk.toml','w').write('[package]\nname = "h"\nversion = "0.1.0"\n')
    open(d+'/src/main.silk','wb').write(data)
    t=time.time()
    try:
        r=subprocess.run(['silk','run','--quiet'],cwd=d,capture_output=True,timeout=300)
        code=r.returncode; err=r.stderr.decode('utf8','replace'); out=r.stdout.decode('utf8','replace')
    except subprocess.TimeoutExpired:
        code='TIMEOUT'; err=''; out=''
    dt=time.time()-t
    diag=[l for l in err.splitlines() if 'error' in l.lower() or 'panic' in l.lower() or 'signal' in l.lower() or 'bug' in l.lower()]
    flag = 'CRASH' if (isinstance(code,int) and code<0) or code in (132,134,139) or 'compiler bug' in err.lower() or 'panic' in err.lower() else ''
    print(f"{flag:5} {name:22} exit={code} {dt:6.1f}s out={out.strip()[:30]!r} {(diag[:1] or [''])[0][:150]}", flush=True)
