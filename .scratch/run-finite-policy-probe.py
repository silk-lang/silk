import re,hashlib,struct,pathlib,subprocess,sys
r=pathlib.Path('/workspace/silk/.scratch'); data=(r/'finite-policy-probe.inputs').read_bytes()
ids=sorted(set(re.findall(rb'project:[a-zA-Z0-9_/]+/function=[a-zA-Z0-9_]+#0',data)))
print('catalog',len(ids),flush=True)
h=hashlib.sha256()
for i,x in enumerate(ids):h.update(struct.pack('<QQ',i,len(x))+x)
(r/'finite-policy-probe.plan').write_bytes((b'SLKTPLN1'+struct.pack('<II',1,2)+bytes(32)+h.digest()+struct.pack('<Q',len(ids))).ljust(256,b'\0'))
tests=sys.argv[1:] or ['growingSpecializationBuildReportsItsResourceLimit','cleanupReentryStaysWithinItsOwnedRoot','refusedStaticChainsRefuseTheBuild','specializationBudgetKeepsCrossModuleRequestSites','unclosedStaticChainsStayUnadmitted','localClosureReentryIsDeclarationRecursion','witnessEffectRecursionStillExpands']
for test in tests:
 p=subprocess.run([str(r/'finite-policy-probe'),'--filter',test,'--silk-test-plan',str(r/'finite-policy-probe.plan'),'--silk-test-result',str(r/('finite-policy-'+test+'.receipt'))],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45)
 (r/('finite-policy-'+test+'.log')).write_bytes(p.stdout)
 print(test,'exit',p.returncode,flush=True);print(p.stdout.decode(),flush=True)
