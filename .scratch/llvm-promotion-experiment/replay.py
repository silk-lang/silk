#!/usr/bin/env python3
"""Replay captured binary packs, optionally opt then the IDENTICAL Clang O0 flags.
Run under the exclusive performance lock. Capture and correctness validation are
separate; this reports the native backend only, not full-language build speed.
"""
import argparse, concurrent.futures, hashlib, json, os, subprocess, time
from pathlib import Path

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def digest_command(command):
    return hashlib.sha256(json.dumps(command, separators=(',', ':')).encode()).hexdigest()

def invoke(command, log, cwd):
    start = time.monotonic()
    with log.open('wb') as error:
        process = subprocess.Popen(command, cwd=cwd, stdout=error, stderr=subprocess.STDOUT)
        _, status, usage = os.wait4(process.pid, 0)
        process.returncode = os.waitstatus_to_exitcode(status)
    result = dict(command=command, command_sha256=digest_command(command), exit_code=process.returncode,
                  wall=time.monotonic()-start, user=usage.ru_utime, system=usage.ru_stime,
                  max_individual_rss_kib=usage.ru_maxrss, log=str(log))
    if process.returncode:
        raise RuntimeError(json.dumps(result))
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('capture', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--mode', choices=['baseline', 'mem2reg', 'sroa', 'plugin-mem2reg', 'plugin-sroa'], required=True)
    parser.add_argument('--opt', type=Path, default=Path('/workspace/silk/.scratch/llvm-22.1.8/bin/opt'))
    parser.add_argument('--layout-json', type=Path, required=True,
                        help='Untimed Clang-probed {triple,data_layout,probe_command,clang_sha256}')
    parser.add_argument('--plugin-build',type=Path,help='build-plugin.py build.json; required for plugin modes')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    records = [json.loads(p.read_text()) for p in sorted((args.capture/'commands').glob('*.json'))]
    assert records and all(r['exit_code'] == 0 for r in records)
    packs = []
    for record in records:
        command = record['argv']
        if '-c' not in command or '-x' not in command or command[command.index('-x')+1] != 'ir':
            continue
        assert '-O0' in command and '-g' in command, command
        assert not any(x.startswith('@') for x in command), 'Response files need explicit snapshotting'
        inputs = [x for x in record['inputs'] if Path(x['saved']).read_bytes()[:4] == b'BC\xc0\xde']
        assert len(inputs) == 1, record
        packs.append((record, inputs[0]))
    assert packs, 'No captured bitcode packs'
    links = [r for r in records if '-c' not in r['argv'] and '-shared' not in r['argv'] and 'output' in r]
    assert len(links) == 1, 'Select one captured final executable build'
    link = links[0]
    clang = packs[0][0]['argv'][0]
    layout = json.loads(args.layout_json.read_text())
    if 'cpus' in layout:
        os.sched_setaffinity(0,set(layout['cpus']))
        assert args.workers <= len(layout['cpus']), 'Worker count exceeds captured CPU lane'
        assert all(r.get('cpus') == layout['cpus'] for r,_ in packs)
    assert sha(clang) == layout['clang_sha256']
    assert all('--target='+layout['triple'] in r['argv'] for r,_ in packs)
    plugin = None
    plugin_meta = None
    if args.mode.startswith('plugin-'):
        assert args.plugin_build, 'Plugin build manifest required'
        plugin_meta = json.loads(args.plugin_build.read_text())
        assert plugin_meta['mode'] == args.mode[len('plugin-'):]
        assert plugin_meta['clang_sha256'] == sha(clang)
        plugin = args.plugin_build.resolve().parent/('promotion-'+plugin_meta['mode']+'.so')
        assert sha(plugin) == plugin_meta['plugin_sha256']
    # Every persisted input is authenticated before measured work.
    for record in [*(r for r,_ in packs), link]:
        for item in record['inputs']:
            assert sha(item['saved']) == item['sha256']
    manifest = dict(mode=args.mode, workers=args.workers, clang_sha256=sha(clang), opt_sha256=sha(args.opt),
                    plugin=plugin_meta, layout=layout, cpus=sorted(os.sched_getaffinity(0)), inputs=[{'sha256': i['sha256'], 'bytes':i['bytes'],
                    'original_command_sha256':r['argv_sha256']} for r,i in packs])
    (args.output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    # Largest inputs first, same queue for all modes; transformations are inside
    # each worker, so the extra process/read/write costs count in total time.
    packs.sort(key=lambda pair: (-pair[1]['bytes'], pair[1]['sha256']))
    def compile_one(index_pair):
        index,(record,item) = index_pair
        command = record['argv'].copy()
        command[item['index']+1] = item['saved']
        output = args.output/f'{index}.o'
        command[command.index('-o')+1] = str(output)
        stages=[]
        if args.mode in ['mem2reg','sroa']:
            promoted = args.output/f'{index}.bc'
            transform = [str(args.opt), '-passes=function('+('sroa<preserve-cfg>' if args.mode == 'sroa' else args.mode)+')',
                         '-mtriple='+layout['triple'], '-data-layout='+layout['data_layout'],
                         item['saved'], '-o', str(promoted)]
            stages.append(invoke(transform,args.output/f'{index}-opt.log',record['cwd']))
            command[item['index']+1] = str(promoted)
        if plugin is not None:
            command.insert(1,'-fpass-plugin='+str(plugin))
        stages.append(invoke(command,args.output/f'{index}-clang.log',record['cwd']))
        # File removal remains part of the measured pipeline as in normal native compilation.
        if args.mode in ['mem2reg','sroa']:
            promoted.unlink()
        return dict(original_output=record['output'], output=str(output), stages=stages)
    start=time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs=list(pool.map(compile_one,enumerate(packs)))
    compile_wall=time.monotonic()-start
    replacement={}
    for job in jobs:
        original=job['original_output']
        replacement[original]=job['output']
        if original.endswith('.partial'):
            replacement[original[:-len('.partial')]]=job['output']
    command=link['argv'].copy()
    used=set()
    for item in link['inputs']:
        original=item['original']
        if original in replacement:
            used.add(original)
        command[item['index']+1]=item['prefix']+replacement.get(original,item['saved'])
    assert len(used)==len(jobs), (len(used),len(jobs))
    binary=args.output/'compiler'
    command[command.index('-o')+1]=str(binary)
    linked=invoke(command,args.output/'link.log',link['cwd'])
    elapsed=time.monotonic()-start
    stages=[stage for job in jobs for stage in job['stages']]+[linked]
    result=dict(mode=args.mode, wall=elapsed, compile_wall=compile_wall,
                cpu=sum(s['user']+s['system'] for s in stages),
                max_individual_rss_kib=max(s['max_individual_rss_kib'] for s in stages),
                jobs=jobs,link=linked,binary_sha256=sha(binary),pack_count=len(jobs))
    (args.output/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['jobs','link']}),flush=True)

if __name__ == '__main__':
    main()
