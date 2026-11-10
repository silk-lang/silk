import importlib.util,sys,struct,re,collections
from pathlib import Path
spec=importlib.util.spec_from_file_location('codec','/workspace/silk/.scratch/parse-frontier-record.py');codec=importlib.util.module_from_spec(spec);spec.loader.exec_module(codec)
folder=Path(sys.argv[1]);data=codec.record((folder/'frontier-failure-0-0.oracle-record').read_bytes(),False,True);entries={entry['key']:entry for entry in data['entries']}
requests=sorted(folder.glob('*.oracle-request'),key=lambda p:int(p.name.split('-')[3].split('.')[0]))
for request in requests:
 raw=request.read_bytes();count=int.from_bytes(raw[1:9],'big');pairs=[(raw[9+32*i:25+32*i].hex(),raw[25+32*i:41+32*i].hex()) for i in range(count)]
 round=request.name.split('-')[3].split('.')[0];replies=[p.read_bytes() for p in folder.glob(f'frontier-failure-*-{round}.oracle-reply')]
 classes=[];decisions=[]
 for i in range(count):
  positive={r[2*i] for r in replies if r[2*i]};assert len(positive)<=1
  decisions.append(next(iter(positive),0));classes.append(min(r[2*i+1] for r in replies))
 print('round',round,'pairs',count,'decisions',dict(collections.Counter(decisions)),'classes',dict(collections.Counter(classes)))
 if request==requests[-1]:
  shown=collections.Counter()
  for pair,decision,kind in zip(pairs,decisions,classes):
   if shown[kind]>=8:continue
   shown[kind]+=1
   names=[]
   for key in pair:
    e=entries[key];names.append(' | '.join(x.decode('utf8','replace') for x in re.findall(rb'[A-Za-z0-9_./:@ -]{3,}',e['decl'])))
   print('case',kind,decision,pair,*names,sep='\t')
