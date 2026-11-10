import re,hashlib,struct,pathlib,subprocess,sys
binary=pathlib.Path(sys.argv[1]);data=pathlib.Path(str(binary)+'.inputs').read_bytes()
ids=sorted(set(re.findall(rb'project:[a-zA-Z0-9_/]+/function=[a-zA-Z0-9_]+#0',data)));h=hashlib.sha256()
for i,x in enumerate(ids):h.update(struct.pack('<QQ',i,len(x))+x)
plan=pathlib.Path(str(binary)+'.selected.plan');plan.write_bytes((b'SLKTPLN1'+struct.pack('<II',1,2)+bytes(32)+h.digest()+struct.pack('<Q',len(ids))).ljust(256,b'\0'))
failed=False
for test in sys.argv[2:]:
 p=subprocess.run([str(binary),'--filter',test,'--silk-test-plan',str(plan),'--silk-test-result',str(binary)+'.'+test+'.receipt'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=90)
 print(test,'exit',p.returncode,flush=True);print(p.stdout.decode(),flush=True);failed=failed or p.returncode!=0
raise SystemExit(1 if failed else 0)
