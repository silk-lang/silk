#!/usr/bin/env python3
import collections,importlib.util,itertools,json,pathlib,struct,sys
spec=importlib.util.spec_from_file_location('census',pathlib.Path(__file__).with_name('query-run-census.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def declaration(data):
 at=0
 def word():
  nonlocal at
  n=struct.unpack_from('>Q',data,at)[0];at+=8;return n
 def field():
  nonlocal at
  n=word();b=data[at:at+n];at+=n;return b.decode(errors='replace')
 module=[field() for _ in range(3)];names=[]
 for _ in range(word()):
  kind=word();name=field() if word() else '<unnamed>';occurrence=word();names.append(f'{kind}:{name}#{occurrence}')
 assert at==len(data)
 return '/'.join(names)
def keyparts(data):
 at=0
 def word():
  nonlocal at
  n=struct.unpack_from('>Q',data,at)[0];at+=8;return n
 def field():
  nonlocal at
  n=word();b=data[at:at+n];at+=n;return b
 def module():return tuple(field().decode(errors='replace') for _ in range(3))
 family=word();application=module() if word() else None;profile=word()
 if profile==2:field()
 mod=module();decl=declaration(field()) if word() else None
 if family==36:
  name=word();external=word();selected=word()
  if selected:field()
  assert at==len(data)
  return dict(module=mod,declaration=decl,selected=bool(selected))
 return dict(module=mod,declaration=decl)
initial=collections.Counter();initial_by_pid=collections.Counter();latest={};byphase=collections.defaultdict(collections.Counter);excluded=collections.defaultdict(collections.Counter)
for path in map(pathlib.Path,sys.argv[1:]):
 d=m.read(path)
 for family,unit,reason,identity,values in d['rows']:
  byphase[d['phase']][family]+=values[0]
  if d['phase'] in (0,2) and family==36 and reason==0:
   initial[(d['stamp'],identity)]+=values[0];initial_by_pid[(d['pid'],identity)]+=values[0]
 if d['pid'] not in latest or d['phase']>latest[d['pid']]['phase']:latest[d['pid']]=d
body={}
for d in latest.values():
 for family,unit,reason,identity,values in d['rows']:
  if reason:excluded[family][m.REASONS.get(reason,str(reason))]+=values[0]
  elif family==36 and values[0]:
   k=(d['stamp'],identity);body.setdefault(k,[keyparts(identity),collections.Counter()])[1][d['pid']]+=values[0]
stages=collections.Counter();pairs=collections.Counter();multiplicity=collections.Counter();categories=collections.defaultdict(collections.Counter);modules=collections.defaultdict(collections.Counter);top=[]
for (_,identity),(parts,per_pid) in body.items():
 starts=sum(per_pid.values());repeat=starts-1;multiplicity[starts]+=1
 for pair in itertools.combinations(sorted(per_pid),2):pairs[pair]+=1
 early=initial[(_,identity)];late=starts-early
 stages['early_starts']+=early;stages['late_starts']+=late
 stages['early_repeats']+=max(0,early-1)
 if early:stages['late_starts_already_completed_before_transport_elsewhere']+=late
 else:stages['late_new_keys']+=1;stages['late_repeats_without_initial_provider']+=max(0,late-1)
 kind='selected' if parts['selected'] else 'ordinary'
 categories[kind].update(starts=starts,unique=1,repeats=repeat)
 mod=':'.join(parts['module']);modules[mod].update(starts=starts,unique=1,repeats=repeat)
 if repeat:top.append(dict(declaration=parts['declaration'],module=mod,kind=kind,starts=starts,processes=dict(per_pid)))
print(json.dumps(dict(provider_starts_by_phase=dict(byphase),excluded_starts_by_family=dict(excluded),body_categories=dict(categories),body_stages=dict(stages),body_multiplicity=dict(multiplicity),body_worker_pairs={f'{a}/{b}':n for (a,b),n in pairs.most_common()},body_modules=sorted((dict(module=k,**v) for k,v in modules.items()),key=lambda x:-x['repeats'])[:30],body_top_repeated=sorted(top,key=lambda x:-x['starts'])[:30]),indent=2))
