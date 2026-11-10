from pathlib import Path
import subprocess,json,os
root=Path(os.environ['PARITY_ORIGIN']);base=Path('/workspace/nonstd');rows=[]
font=base/'ui/assets/assets/fonts/NotoSans-Regular.subset.ttf'
cases=[['--help'],['--version'],[str(font),'office affinity'],[str(font),'AVATAR','--features=kern,-liga'],[str(font),'abc مرحبا','--direction=rtl'],[str(font),'Hello','--direction=ttb'],[str(font),'Hello','--no-glyph-names','--show-flags'],[str(font),'Hello','--language=tr'],[str(font),'a\u0301e\u0301'],[str(font),'Hello','--unsupported']]
for args in cases:
 pair=[]
 for mode in ('off','packed'):
  r=subprocess.run([str(root/('harfrust-'+mode)),*args],cwd=base,capture_output=True,timeout=30)
  row={'args':args,'mode':mode,'exit_code':r.returncode,'stdout':r.stdout.decode(),'stderr':r.stderr.decode()};rows.append(row);pair.append(row)
 for field in ['exit_code','stdout','stderr']:
  assert pair[0][field]==pair[1][field],(args,field,pair)
(root/'packed-harf-parity.json').write_text(json.dumps(rows,indent=2));print('PASS 10 Harf runtime pairs')
