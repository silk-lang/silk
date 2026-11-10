import json,re,collections,pathlib,gzip
P=pathlib.Path('/workspace/silk/.scratch/benchmarks/v24-cpu-build-3ebpgyqm')
S=pathlib.Path('/workspace/silk/.scratch/frontier-performance-attribution-v24.symbols')
def evidence(name):
 p=P/name
 return p.open() if p.exists() else gzip.open(str(p)+'.gz','rt')
names={a:c for a,b,c in (x.rstrip('\n').split('\t',2) for x in S.open())}
roles=json.loads((P/'query-coverage.json').read_text())['roles']; roles['323296']='observer'
events=[]
for line in (P/'native-phases.log').open():
 m=re.fullmatch(r'cpu0-cache (\S+) at_ns=(\d+) pid=(\d+) tid=(\d+) ns=(\d+) a=(\d+) b=(\d+) c=(\d+)\n?',line)
 if m: events.append(dict(zip(['label','at','pid','tid','ns','a','b','c'],[m[1],*map(int,m.groups()[1:])])) )
starts={}; spans=[]; unmatched=[]
for e in events:
 if e['label'].endswith('-begin'):
  key=(e['label'][:-6],e['pid'],e['tid'],e['a'] if e['label'].startswith(('native-job-','native-bitcode-','native-write-','native-clang-','native-debug-info-','query-census-')) else 0); starts[key]=e
 elif e['label'].endswith('-end'):
  key=(e['label'][:-4],e['pid'],e['tid'],e['a'] if e['label'].startswith(('native-job-','native-bitcode-','native-write-','native-clang-','native-debug-info-','query-census-')) else 0); start=starts.pop(key,None)
  if start: spans.append(dict(label=key[0],pid=e['pid'],tid=e['tid'],a=e['a'],start=start['at'],end=e['at'],seconds=(e['at']-start['at'])/1e9))
  else: unmatched.append(e)
dumps=[s for s in spans if s['label']=='query-census-dump']
arrival=[json.loads(x) for x in (P/'trace-arrival.jsonl').open()]
markers=[(json.loads((P/'launch.json').read_text())['start_ns'],'load/prewarm')]
for pattern,label in [('frontier split ','semantic checking'),('frontier accepted','check finalization'),('  check ','artifact discovery'),('artifact discovered','artifact global proof'),('artifact proved','artifact emission'),('artifact emitted','artifact preparation'),('artifact prepared','native setup/cache assembly'),('native coordinator started','native active/cache assembly'),('check cache assembled','artifact cache import'),('artifact cache imported','artifact replay'),('artifact replay captured','artifact acceptance'),('artifact accepted','checkpoint/native active'),('native cache checkpoint','native wait'),('native objects published','final link/cache join')]:
 found=[x for x in arrival if pattern in x['line']]
 if found: markers.append((found[0]['ns'],label))
markers.sort()
def stage(at):
 for t,n in reversed(markers):
  if at>=t:return n
 return 'prelaunch'
def diag(pid,tid,at):return any(s['pid']==pid and s['tid']==tid and s['start']<=at<=s['end'] for s in dumps)
leaf=collections.Counter(); rolecpu=collections.Counter(); stages=collections.defaultdict(collections.Counter); module=collections.defaultdict(collections.Counter); leafrole=collections.defaultdict(collections.Counter); periodtotal=0; samples=[]
pat=re.compile(r'^\s*(\S+)\s+(\d+)/(\d+)\s+([\d.]+):\s+(\d+)\s+cpu-clock:u:\s+(\S+)\s+(.+)\s+\((.*)\)$')
for line in evidence('samples.txt'):
 m=pat.match(line)
 if not m:continue
 comm,pid,tid,t,period,ip,sym,dso=m.groups();pid=int(pid);tid=int(tid);at=round(float(t)*1e9); sec=int(period)/1e9
 role=roles.get(str(pid),'UNKNOWN:'+comm);name=names.get(sym,sym);originalrole=role
 if diag(pid,tid,at):role='diagnostic-dump'
 rolecpu[role]+=sec;stages[stage(at)][role]+=sec;leaf[(role,name)]+=sec;leafrole[role][name]+=sec
 mod=name.split('::')[0];module[role][mod]+=sec;periodtotal+=sec;samples.append((pid,tid,at,sec,role,name))
head=re.compile(r'^\s*(\S+)\s+(\d+)/(\d+)\s+([\d.]+):\s+(\d+)\s+cpu-clock:u:\s*$'); frame=re.compile(r'^\s+[0-9a-f]+ (.+) \((.*)\)$')
inclusive=collections.defaultdict(collections.Counter); union=collections.defaultdict(collections.Counter); chaincpu=collections.defaultdict(collections.Counter); depths=collections.defaultdict(collections.Counter); callerleaf=collections.defaultdict(collections.Counter);state=None;frames=[]
providers=['resolveBody','resolveBodyFacts','resolveSignatureUnder','resolveEmissionInputs','lowerMir','resolveMir','mir']
def flush():
 if not state:return
 pid,tid,at,sec=state;role=roles.get(str(pid),'observer' if pid==323296 else 'unknown')
 if diag(pid,tid,at):role='diagnostic-dump'
 depths[role][str(len(frames))]+=sec
 found=[]
 for raw in frames:
  name=names.get(raw,raw)
  if ':semantic/Semantic.silk::' in name and name.rsplit('::',1)[-1] in providers: found.append(name.rsplit('::',1)[-1])
 for f in set(found):inclusive[role][f]+=sec
 if 'resolveBody' in found:union[role]['any Body']+=sec
 if any(f in found for f in ['resolveBody','resolveBodyFacts','resolveSignatureUnder']):union[role]['Body/BodyFacts/Signature union']+=sec
 category=found[0] if found else 'unassigned (partial/no provider chain)'
 chaincpu[role][category]+=sec
 if frames:callerleaf[role+'/'+category][names.get(frames[0],frames[0])]+=sec
for line in evidence('stack-samples.txt'):
 m=head.match(line)
 if m:
  flush();state=(int(m[2]),int(m[3]),round(float(m[4])*1e9),int(m[5])/1e9);frames=[]
 else:
  m=frame.match(line)
  if m:frames.append(m[1])
flush()
spanstats={}
for label in sorted({s['label'] for s in spans}):
 ss=[s for s in spans if s['label']==label];spanstats[label]=dict(count=len(ss),sum_wall=sum(s['seconds'] for s in ss),max_wall=max(s['seconds'] for s in ss),first=min(s['start'] for s in ss),last=max(s['end'] for s in ss))
result=dict(sampled_user_seconds=periodtotal,roles=rolecpu,markers=markers,stage_sampled_cpu=stages,top_leaf_by_role={k:v.most_common(35) for k,v in leafrole.items()},top_module_by_role={k:v.most_common(25) for k,v in module.items()},nearest_provider_chain_cpu=chaincpu,inclusive_provider_chain_cpu=inclusive,provider_unions=union,chain_depth_cpu=depths,provider_leaf={k:v.most_common(20) for k,v in callerleaf.items()},spanstats=spanstats,spans=spans,unmatched_end=unmatched,unmatched_begin=list(starts.values()),limitations=['99Hz user samples; excludes kernel CPU and unrecorded diagnostic counter overhead','Nearest visible selected provider in partial DWARF chains; unassigned is not evidence of no provider','Span sums are overlapping wall durations, not CPU','Census encoding samples explicitly bucketed; same-binary diagnostic perturbation remains'])
(P/'cpu-analysis.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:result[k] for k in ['sampled_user_seconds','roles','nearest_provider_chain_cpu','spanstats']},indent=2))
