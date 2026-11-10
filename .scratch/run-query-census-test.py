import ctypes,hashlib,json,os,pathlib,shutil,subprocess,time
s=pathlib.Path('/workspace/silk/.scratch'); tree=s/'performance-attribution-v24-source'; dst=s/'query-census-focused'; src=dst/'src';(src/'semantic').mkdir(parents=True,exist_ok=True)
(dst/'silk.toml').write_text('[package]\nname = "query-census-focused"\nversion = "0.0.0"\nsilk-version = "0.0.0"\n')
(src/'main.silk').write_text('import semantic.QueryRunCensus\nfn main() -> i32 { return 0 }\n')
files=['semantic/QueryRunCensus.silk','semantic/FrontierHost.silk','semantic/InternIndex.silk','CompilerBug.silk']
for f in files:shutil.copy2(tree/'compiler/src'/f,src/f)
rev=subprocess.check_output(['git','-C',str(tree),'rev-parse','HEAD'],text=True).strip();assert rev=='fe11b2fee39ec0c1aad9246970bd160156b399c6'
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
cmd=[str(s/'ci-n1-4a1fa332/N1'),'test','--manifest-path',str(dst/'silk.toml'),'--file','src/semantic/QueryRunCensus.silk','--stdlib',str(tree/'stdlib'),'--filter','expensiveQueryCensusSeparatesWorkHitsAndProvenance']
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_')};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang');start=time.monotonic()
with (dst/'test.log').open('wb') as log:r=subprocess.run(cmd,cwd=dst,env=env,stdout=log,stderr=subprocess.STDOUT)
reaped=[]
while True:
 try:pid,status=os.waitpid(-1,0);reaped.append([pid,os.waitstatus_to_exitcode(status)])
 except ChildProcessError:break
receipt={'source':rev,'command':cmd,'exit':r.returncode,'elapsed':time.monotonic()-start,'reaped':reaped,'inputs':{f:hashlib.sha256((src/f).read_bytes()).hexdigest() for f in files}}
(dst/'receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt));raise SystemExit(r.returncode)
