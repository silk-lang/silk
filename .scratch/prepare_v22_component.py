"""Pins only; never launches a compiler or benchmark."""
import hashlib,json
from pathlib import Path
base=Path('/workspace/silk/.scratch');pins={}
expected={'reference':('frontier-native-checkpoint-completed-v19','b0f222d1cddb807bc0aa2bd66965ee7b68e518be','V19 completion barrier'),
          'candidate':('frontier-native-work-v22','85ba82efe750a4682cc21192ad5dcb37d7bbd981','V22 native proof and forwarding')}
for mode,(name,source,label) in expected.items():
 construction=base/(name+'-build.json');m=json.loads(construction.read_text())
 assert m['source']==source
 with (base/name).open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==m['sha256']
 pins[mode]={'label':label,'binary':str(base/name),'source':source,'sha256':m['sha256'],'construction':str(construction)}
p=base/'v22-component-pins.json';p.write_text(json.dumps(pins,indent=2)+'\n')
print(json.dumps(pins,indent=2))
