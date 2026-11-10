from pathlib import Path
import gzip,hashlib,importlib.util,json,os,shutil,subprocess
s=Path('/workspace/silk/.scratch');tree=s/'storage-artifact-proof-repair';builder=s/'ci-n1-4a1fa332/N1';assert shutil.disk_usage(s).free>=900*1024*1024
spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_NATIVE_','SILK_PROFILE_')) and k not in ['LD_PRELOAD','LLVM_PROFILE_FILE']};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang');revision=subprocess.check_output(['git','-C',str(tree),'rev-parse','HEAD'],text=True).strip();assert not subprocess.check_output(['git','-C',str(tree),'status','--porcelain']);rows=[]
for case in ['ArtifactGraphCases','DefinitionFragmentsCases']:
 assert shutil.disk_usage(s).free>=900*1024*1024,case
 command=[str(builder),'test',str(tree/f'compiler/src/semantic/{case}.silk'),'--stdlib',str(tree/'stdlib'),'--optimization','none','--debug','false','--no-cache','--output',str(s/('storage-proof-'+case))]
 result=b.measure(command,tree/'compiler',env,s/('storage-proof-'+case+'.log'));rows.append({'source':revision,'command':command,'builder_sha256':hashlib.sha256(builder.read_bytes()).hexdigest(),'result':result});(s/'storage-artifact-proof-validation.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(rows[-1]),flush=True);assert result['exit_code']==0 and all(x['exit_code']==0 for x in result['detached']),case
 output=s/('storage-proof-'+case);digest=hashlib.sha256(output.read_bytes()).hexdigest();size=output.stat().st_size
 with output.open('rb') as src,gzip.open(str(output)+'.gz','wb',compresslevel=1) as dst:shutil.copyfileobj(src,dst)
 with gzip.open(str(output)+'.gz','rb') as src:assert hashlib.sha256(src.read()).hexdigest()==digest
 units=Path(str(output)+'.units');files=[]
 for f in units.rglob('*'):
  if f.is_file():files.append({'path':str(f.relative_to(units)),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
 with gzip.open(str(output)+'.cleanup.json.gz','wt') as dst:json.dump({'source':revision,'output_sha256':digest,'output_bytes':size,'unit_files':files},dst)
 output.unlink();shutil.rmtree(units,ignore_errors=True)

