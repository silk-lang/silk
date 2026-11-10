#!/usr/bin/env python3
"""Scheduled launcher only; no timing run during preparation."""
import hashlib,json,os,pathlib
r=pathlib.Path('/workspace/silk/.scratch')
spec=json.loads((r/'shared-bodies-cpu0-component-prepared.json').read_text())
pins=json.loads((r/'shared-bodies-cpu0-component-pins.json').read_text())
for mode,pin in pins.items():
 assert hashlib.sha256(pathlib.Path(pin['construction']).read_bytes()).hexdigest()==spec['construction_sha256'][mode]
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_') and k not in ('LD_PRELOAD','LLVM_PROFILE_FILE')}
env.update(spec['extra_environment'])
os.execvpe(spec['command'][0],spec['command'],env)
