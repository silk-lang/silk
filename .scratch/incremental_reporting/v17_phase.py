#!/usr/bin/env python3
"""Explicit V17 performance phases; no phase launches a later phase automatically.

Only execute after root releases exclusive performance ownership. --print-command
is source-only preparation. Option screens and immediate edits own their locks;
settled baseline matrices use flock around the unchanged compare.py harness.
"""
import argparse
import json
import os
from pathlib import Path
import shlex

SCRATCH=Path('/workspace/silk/.scratch')
HERE=Path(__file__).resolve().parent
SOURCE='060ec3a13d06eeb4517739fe740598a7561e7c40'
SHA='79b8f4b494f3b443a989c8ea8dfd7fc33f5c92c2fa26569d84968f5f2331e0c4'
BINARY=SCRATCH/'frontier-performance-v17'
CONSTRUCTION=SCRATCH/'frontier-performance-v17.json'
PREFIXES=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_',
          'SILK_FINITE_','SILK_NATIVE_BUILD_PIPELINE','SILK_ARTIFACT_')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase',choices=('pipeline','registry','baseline','immediate'))
    parser.add_argument('--pipeline',choices=('off','on'))
    parser.add_argument('--registry',choices=('off','on'))
    parser.add_argument('--cpus',choices=('0','0,1,2,3'),default='0,1,2,3')
    parser.add_argument('--rounds',type=int)
    parser.add_argument('--print-command',action='store_true')
    args=parser.parse_args()
    metadata=json.loads(CONSTRUCTION.read_text())
    assert metadata['source']==SOURCE and metadata['sha256']==SHA and Path(metadata['binary'])==BINARY
    if args.phase in ('registry','baseline','immediate') and args.pipeline is None:
        parser.error('--pipeline must name the measured selected policy')
    if args.phase in ('baseline','immediate') and args.registry is None:
        parser.error('--registry must name the measured selected policy')
    if args.phase in ('pipeline','registry'):
        assert args.cpus=='0,1,2,3', 'Controls are four-core before final CPU lanes'
        command=['python3',str(HERE/'option_screen.py'),'--candidate',str(BINARY),
                 '--source',SOURCE,'--expected-sha256',SHA,'--construction',str(CONSTRUCTION),
                 '--toggle',args.phase,'--fixed-pipeline',args.pipeline or 'off',
                 '--rounds',str(args.rounds or 2),'--minimum-free-mib','1024','--wait-for-disk']
        assert args.registry is None, 'The screen controls registry selection itself'
    else:
        features=['--feature','SILK_RETAINED_CACHE=1','--feature','SILK_FRONTIER_EPHEMERAL=1']
        if args.pipeline=='on':features+=['--feature','SILK_NATIVE_BUILD_PIPELINE=1']
        if args.registry=='on':features+=['--feature','SILK_FRONTIER_REUSE_COMPLETED=1']
        common=['--baseline',str(SCRATCH/'N0-one'),
                '--baseline-source-revision','a63f612150a0b91a118c8111b910b12c3e124b50',
                '--candidate',str(BINARY),'--candidate-source-revision',SOURCE,
                '--cpus',args.cpus,'--worker-policy','parallel','--operations','check,build',
                '--workloads','compiler,harfrust','--rounds',str(args.rounds or 1),*features]
        if args.cpus=='0':common+=['--require-host-capacity-refusal']
        if args.phase=='baseline':
            command=['flock','-x',str(SCRATCH/'performance.lock'),'python3',str(HERE/'compare.py'),
                     *common,'--modes','baseline,candidate','--sequences','edits,unchanged',
                     '--first-edit-regression-limit','0','--minimum-free-mib','1024','--wait-for-disk']
        else:
            command=['python3',str(HERE/'immediate_edits.py'),*common,'--delay-ms','0',
                     '--minimum-free-mib','1536']
    if args.print_command:
        print(json.dumps(dict(phase=args.phase,source=SOURCE,sha256=SHA,command=command,
                              shell=shlex.join(command),explicit_release_required=True),indent=2))
        return
    environment={key:value for key,value in os.environ.items() if not key.startswith(PREFIXES)}
    # compare.py does not strip the new pipeline namespace itself; sanitizing
    # here keeps every baseline invocation free of candidate opt-in switches.
    os.execvpe(command[0],command,environment)


if __name__=='__main__':main()
