"""Exact V11 global packing ON/OFF, CPU0, serial policy. Holds exclusive lock."""
import argparse,fcntl,hashlib,importlib.util,json,os,shutil,subprocess,tempfile
from pathlib import Path
scratch=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('cold',scratch/'benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
import sys
sys.path.insert(0,str(scratch/'incremental_reporting'))
from lane import candidate_environment

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def native_summary(capture):
    commands=[json.loads(p.read_text()) for p in sorted((capture/'commands').glob('*.json'))]
    grouped={}
    for c in commands:
        args=c['argv'][1:]
        kind='unit' if '-c' in args and any(v['bitcode'] for v in c['inputs']) else 'helper' if '-c' in args else 'link' if 'output' in c else 'probe'
        c['kind']=kind;g=grouped.setdefault(kind,{'count':0,'wall_s':0,'cpu_s':0,'input_bytes':0,'bitcode_bytes':0,'capture_s':0})
        g['count']+=1;g['wall_s']+=c['native_wall_s'];g['cpu_s']+=c['user_s']+c['sys_s'];g['input_bytes']+=sum(v['bytes'] for v in c['inputs']);g['bitcode_bytes']+=sum(v['bytes'] for v in c['inputs'] if v['bitcode']);g['capture_s']+=c['capture_before_native_s']
        assert c['cpus']==[0] and c['exit_code']==0,c
    return {'categories':grouped,'commands':commands}

parser=argparse.ArgumentParser();parser.add_argument('--reuse-sources',type=Path);options=parser.parse_args()
lock=open(scratch/'performance.lock','a');fcntl.flock(lock,fcntl.LOCK_EX)
os.sched_setaffinity(0,{0});assert os.sched_getaffinity(0)=={0}
root=Path(tempfile.mkdtemp(prefix='v11-native-packing-',dir=scratch/'benchmarks'))
source_root=options.reuse_sources or root
revisions=json.loads((source_root/'metadata.json').read_text())['revisions'] if options.reuse_sources else {'silk':bench.snapshot(Path('/workspace/silk-baseline'),root/'silk'),'nonstd':bench.snapshot(Path('/workspace/nonstd'),root/'nonstd')}
assert revisions=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}
binary=scratch/'frontier-shared-graphs-v11';wrapper=scratch/'llvm-promotion-experiment/capture-clang.py';clang=scratch/'llvm-22.1.8/bin/clang'
meta={'binary':str(binary),'sha256':digest(binary),'compiler_source':'044087bc4dc1ebdab1668a8afd8c441680739e21','revisions':revisions,'source_root':str(source_root),'cpus':[0],'worker_policy':'serial','wrapper':str(wrapper),'wrapper_sha256':digest(wrapper),'clang':str(clang),'clang_sha256':digest(clang),'requested_calls':8,'note':'Same binary and source; only global packing switch changes. No intervening unchanged call. Python wrapper adds per-invocation overhead, so total cold time is diagnostic-only; native child CPU/wall excludes Python startup. All writers settle before advancing.'}
(root/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps({'root':str(root),'metadata':meta}),flush=True)
results=[]
for workload in ['compiler','harfrust']:
    source=source_root/('silk' if workload=='compiler' else 'nonstd');cache=source/'build';cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
    edited=source/'compiler/src/main.silk' if workload=='compiler' else cwd/'src/main.silk';original=edited.read_bytes()
    needle=b'Create a package or a workspace\\n' if workload=='compiler' else b'Usage: hr_shape FONT TEXT'
    replacement=b'Create a package or a workspace (revision one)\\n' if workload=='compiler' else b'Usage: hr_shape FONT TEXT (revision one)'
    assert original.count(needle)==1
    modes=['off','on'] if workload=='compiler' else ['on','off']
    for mode in modes:
        edited.write_bytes(original);shutil.rmtree(cache,ignore_errors=True);previous={}
        for stage in ['cold','first-edit']:
            if stage=='first-edit':edited.write_bytes(original.replace(needle,replacement))
            tag=workload+'-'+mode+'-'+stage;capture=root/(tag+'-capture');capture.mkdir()
            env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_','SILK_PROFILE_','SILK_PROMOTION_')) and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']}
            env=candidate_environment(env,{'SILK_RETAINED_CACHE':'1','SILK_FRONTIER_EPHEMERAL':'1'},'serial','candidate','build')
            if mode=='off':env.pop('SILK_EXPERIMENT_DEV_PACKS',None)
            env.update(SILK_CLANG=str(wrapper),SILK_PROMOTION_CLANG=str(clang),SILK_PROMOTION_CAPTURE=str(capture),SILK_PROMOTION_CAPTURE_FILES='none' if stage=='cold' else 'bitcode')
            config=wrapper.with_name('capture-clang.config.json');pending=config.with_suffix('.json.pending')
            pending.write_text(json.dumps({'capture':str(capture),'clang':str(clang),'mode':'none' if stage=='cold' else 'bitcode'})+'\n');os.replace(pending,config)
            assert ('SILK_EXPERIMENT_DEV_PACKS' in env)==(mode=='on') and 'SILK_EXPERIMENT_FRONTIER' not in env
            command=[str(binary),'build']+(['--package','silk-compiler'] if workload=='compiler' else [])+['--stdlib',str(source_root/'silk/stdlib'),'--progress','plain','--timings']
            row={'workload':workload,'packing':mode,'stage':stage,'cpus':[0],'worker_policy':'serial','command':command,'environment':{k:v for k,v in env.items() if k.startswith('SILK_')},'source_sha256':hashlib.sha256(edited.read_bytes()).hexdigest(),**bench.measure(command,cwd,env,root/(tag+'.log'))}
            assert row['exit_code']==0 and all(r['exit_code']==0 for r in row['detached']),row
            output=cache/'llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if workload=='compiler' else 'font-shape-cli')
            smoke=subprocess.run([str(output),'--help'],capture_output=True);helptext=smoke.stdout+smoke.stderr
            assert smoke.returncode==0 and ((b'revision one' in helptext)==(stage=='first-edit'))
            (root/(tag+'.help')).write_bytes(helptext)
            objects={str(p.relative_to(output.parent)): {'bytes':p.stat().st_size,'sha256':digest(p)} for p in output.with_name(output.name+'.units').glob('*.o')}
            row['objects']=len(objects);row['new_objects']=[dict(path=k,**v) for k,v in objects.items() if k not in previous];row['changed_existing_objects']=[k for k,v in objects.items() if k in previous and v['sha256']!=previous[k]['sha256']];previous=objects
            row['native']=native_summary(capture);row['binary_sha256']=digest(output)
            trace=(root/(tag+'.log')).read_text();assert 'frontier split' not in trace and 'frontier accepted' not in trace
            row['diagnostics']=[l for l in trace.splitlines() if ': error[' in l or ': warning[' in l]
            (root/(tag+'.objects.json')).write_text(json.dumps(objects,indent=2)+'\n');results.append(row);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
            print(json.dumps({k:v for k,v in row.items() if k not in ['native','environment','diagnostics','new_objects']} | {'native_categories':row['native']['categories'],'new_object_count':len(row['new_objects']),'new_object_bytes':sum(v['bytes'] for v in row['new_objects'])}),flush=True)
        shutil.rmtree(cache,ignore_errors=True)
    edited.write_bytes(original)
    print('CHECKPOINT '+workload+' '+str(root),flush=True)
(root/'restored.json').write_text(json.dumps({'sources_restored':True,'calls':len(results)})+'\n')
print('COMPLETE '+str(root),flush=True)
