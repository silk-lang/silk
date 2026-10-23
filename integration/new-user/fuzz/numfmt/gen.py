# Format-spec differential: the same placeholders and values printed by Silk and by Rust's format!.
import random, struct, sys
seed=int(sys.argv[1]); silk_out=sys.argv[2]; rust_out=sys.argv[3]
r=random.Random(seed)
INTS={'i64':(-2**63,2**63-1),'u64':(0,2**64-1),'i32':(-2**31,2**31-1),'u8':(0,255),'i8':(-128,127),'u32':(0,2**32-1)}
def intval(t):
    lo,hi=INTS[t]
    return r.choice([lo,hi,0,1,-1 if lo<0 else 2,r.randint(lo,hi),r.randint(max(lo,-1000),min(hi,1000))])
def floatval():
    k=r.random()
    if k<0.15: return r.choice([0.0,-0.0,1.0,-1.0,0.1,0.5,2.5,1e300,-1e-300,5e-324,1.7976931348623157e308,123456789.0,1e15,1e16,1e21,1e-7,0.3])
    if k<0.5: return round(r.uniform(-1000,1000), r.randint(0,6))
    b=r.getrandbits(64)
    v=struct.unpack('d',struct.pack('Q',b))[0]
    if v!=v or v in (float('inf'),float('-inf')): return 1.25
    return v
def spec(kind):
    s=''
    if r.random()<0.3:
        fill=r.choice(['','*','-','0','x','é'])
        s+=fill+r.choice(['<','>','^'])
    if r.random()<0.25 and kind!='str': s+=r.choice(['+'])
    if r.random()<0.2 and kind=='int': s+='#'
    if r.random()<0.2 and kind!='str' and not any(c in s for c in '<>^'): s+='0'
    if r.random()<0.5: s+=str(r.randint(1,30))
    if kind=='float' and r.random()<0.5: s+='.'+str(r.randint(0,12))
    if kind=='str' and r.random()<0.3: s+='.'+str(r.randint(0,5))
    if kind=='int' and r.random()<0.4: s+=r.choice(['x','X','o','b'])
    if kind=='float' and r.random()<0.25: s+=r.choice(['e','E'])
    return s
def flit(v):
    t=repr(v)
    if t=='-0.0': return '-0.0'
    if 'e' in t or 'E' in t:
        m,e=t.split('e'); 
        if '.' not in m: m+='.0'
        return m+'e'+e
    if '.' not in t: t+='.0'
    return t
silk=[]; rust=[]
for i in range(r.randint(150,400)):
    k=r.random()
    if k<0.5:
        t=r.choice(list(INTS)); v=intval(t); sp=spec('int')
        silk.append(f'  let v{i}: {t} = {v}\n  run Effect.log("[{{v:{sp}}}]\\n", &.{{ v: v{i} }})')
        rust.append(f'    let v{i}: {t} = {v}_{t};\n    println!("[{{v:{sp}}}]", v = v{i});')
    elif k<0.85:
        v=floatval(); sp=spec('float')
        # Silk's shortest form switches to an exponent for very large and very small values, Rust's
        # never does; compare those only with a precision or an exponent type.
        if '.' not in sp and 'e' not in sp.lower() and v != 0 and not (1e-5 <= abs(v) < 1e16): sp += '.3'
        lit=flit(v)
        silk.append(f'  let v{i}: f64 = {lit}\n  run Effect.log("[{{v:{sp}}}]\\n", &.{{ v: v{i} }})')
        rust.append(f'    let v{i}: f64 = {lit};\n    println!("[{{v:{sp}}}]", v = v{i});')
    else:
        txt=r.choice(['','a','hello','héllo wörld','日本語','😀x','tab\\there'])
        sp=spec('str')
        silk.append(f'  let v{i}: string<\'static> = "{txt}"\n  run Effect.log("[{{v:{sp}}}]\\n", &.{{ v: v{i} }})')
        rust.append(f'    let v{i}: &str = "{txt}";\n    println!("[{{v:{sp}}}]", v = v{i});')
open(silk_out,'w').write('import silk.effect { Effect }\nimport silk.logger { LogError, Logger }\nimport silk.os_logger { StdoutLogger }\n\neffect fn body() -> () ! LogError ? &mut Logger {\n'+'\n'.join(silk)+'\n}\n\npub effect fn main() -> () ! LogError {\n  let mut logger = StdoutLogger.make()\n  run body() |> Effect.provideMut<Logger>(&mut logger)\n}\n')
open(rust_out,'w').write('#![allow(unused)]\nfn main() {\n'+'\n'.join(rust)+'\n}\n')
