"""Source/focused validation only. Caller must own a root-scheduled shared performance lock."""
import argparse,hashlib,importlib.util,json,os,shutil,subprocess,sys
from pathlib import Path
s=Path('/workspace/silk/.scratch');tree=s/'shared-storage-helpers';builder=s/'ci-n1-4a1fa332/N1'
p=argparse.ArgumentParser();p.add_argument('--phase',choices=['source','focused','both'],default='both');a=p.parse_args()
assert shutil.disk_usage(s).free>=900*1024*1024,'Need900MiB before source/test staging; do not lower this bound'
revision=subprocess.check_output(['git','-C',str(tree),'rev-parse','HEAD'],text=True).strip()
assert not subprocess.check_output(['git','-C',str(tree),'status','--porcelain'],text=True),'Commit source corrections before validating'
sha=lambda path:hashlib.sha256(Path(path).read_bytes()).hexdigest()
assert sha(builder)=='d0c04d1a9b672e34fd6302ccaa9fc49b23a2ba1954c8d826dc73be626bc611db'
spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_','SILK_CACHE_WORK_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked) and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
shared=['--manifest-path',str(tree/'compiler/silk.toml'),'--stdlib',str(tree/'stdlib'),'--progress','plain']
commands={
 'source':[str(builder),'check',*shared],
 'focused':[str(builder),'test',str(tree/'compiler/src/SemanticRootCases.silk'),'--stdlib',str(tree/'stdlib'),'--filter','storageResizeHelpersShareOnlyPreparedLayout','--optimization','none','--debug','false','--no-cache','--output',str(s/'shared-storage-focused')],
}
rows=json.loads((s/'shared-storage-validation.json').read_text()) if a.phase=='focused' and (s/'shared-storage-validation.json').exists() else []
rows=[r for r in rows if r['phase']=='source' and r['source_revision']==revision]
for phase in ['source','focused'] if a.phase=='both' else [a.phase]:
 result=b.measure(commands[phase],tree/'compiler',env,s/f'shared-storage-{phase}.log')
 rows.append(dict(phase=phase,source_revision=revision,builder_sha256=sha(builder),command=commands[phase],result=result))
 (s/'shared-storage-validation.json').write_text(json.dumps(rows,indent=2)+'\n')
 print(json.dumps(rows[-1]),flush=True)
 assert result['exit_code']==0 and all(x['exit_code']==0 for x in result['detached']),phase
 assert subprocess.check_output(['git','-C',str(tree),'rev-parse','HEAD'],text=True).strip()==revision
 assert not subprocess.check_output(['git','-C',str(tree),'status','--porcelain'],text=True)
