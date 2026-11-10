import collections,importlib.util,itertools,json,pathlib,sys
spec=importlib.util.spec_from_file_location('census',pathlib.Path(__file__).with_name('query-run-census.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
initial={};final={};logical={};total=collections.defaultdict(collections.Counter);excluded=collections.defaultdict(collections.Counter)
for path in map(pathlib.Path,sys.argv[1:]):
 d=m.read(path);pid=d['pid'];logical[pid]=d['worker'];rows={}
 for fam,unit,reason,key,v in d['rows']:
  if fam!=36:continue
  total[(pid,d['phase'])].update(starts=v[0])
  if reason:excluded[(pid,d['phase'])].update(starts=v[0]);continue
  rows[(d['stamp'],key)]=v[0]
 if d['phase']==0:initial[pid]=rows
 elif d['phase']==1:final[pid]=rows
initial_producers=collections.defaultdict(set)
for pid,rows in initial.items():
 for key,n in rows.items():
  if n:initial_producers[key].add(pid)
result=[];eligible_pairs=collections.Counter();categories=collections.defaultdict(collections.Counter)
for pid,rows in final.items():
 before=initial[pid];early=sum(before.values());late=sum(rows.values())-early;overlap=0;new=0
 for key,n in rows.items():
  delta=n-before.get(key,0)
  if not delta:continue
  others=initial_producers[key]-{pid}
  if others:
   overlap+=delta
   for supplier in others:eligible_pairs[(logical[supplier],logical[pid])]+=delta
  else:new+=delta
 kind='original' if logical[pid]<4 else 'private'
 categories[kind].update(initial_supported_starts=early,late_supported_starts=late,late_already_completed_elsewhere=overlap,late_unavailable_at_boundary=new)
 result.append(dict(pid=pid,worker=logical[pid],kind=kind,initial_all_starts=total[pid,0]['starts'],final_all_starts=total[pid,1]['starts'],initial_supported_starts=early,late_supported_starts=late,late_already_completed_elsewhere=overlap,late_unavailable_at_boundary=new,initial_excluded=excluded[pid,0]['starts'],final_excluded=excluded[pid,1]['starts']))
initial_repeat_categories=collections.Counter()
for key,producers in initial_producers.items():
 if len(producers)>1:
  kinds=tuple(sorted({'original' if logical[p]<4 else 'private' for p in producers}))
  initial_repeat_categories['+'.join(kinds)]+=len(producers)-1
print(json.dumps(dict(workers=sorted(result,key=lambda r:r['worker']),categories=dict(categories),initial_repeat_categories=dict(initial_repeat_categories),eligible_supplier_consumer_pairs={f'{a}->{b}':n for (a,b),n in eligible_pairs.most_common()},pair_counts_not_additive='One late consumer can have several suppliers; unique eligible late starts are in workers/categories.'),indent=2))
