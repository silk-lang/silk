"""Generate throwaway first-reason instrumentation: SOURCE_SNAPSHOT SCRATCH_DEST.

Recorded against 20327d2eae9a11cdef9ded50b583a33023df7c1e. This only changes
reporting categories; it does not implement the proposed St4 contract checks.
"""

from pathlib import Path
import shutil,json,sys
base=Path(sys.argv[1]);dest=Path(sys.argv[2]);shutil.copytree(base,dest,dirs_exist_ok=True)
ops=[('ExecutionFromAllocation','storage-execution-from-allocation'),('ExecutionDrive','storage-execution-drive'),('ExecutionNotify','storage-execution-notify'),('ExecutionCurrent','storage-execution-current'),('Relinquish','storage-relinquish'),('SlotAddress','storage-slot-address')]
p=dest/'compiler/src/semantic/TypedBody.silk';s=p.read_text();start=s.index('pub enum BorrowStatus {');end=s.index('\n}',start);s=s[:end]+''.join('\n  Probe'+op+',' for op,name in ops)+s[end:]
needle='  return 5\n}\n\n/// The position';assert needle in s;s=s.replace(needle,f'  return {5+len(ops)}\n}}\n\n/// The position')
s=s.replace('    BorrowStatus.Imprecise => 4','    BorrowStatus.Imprecise => 4\n'+''.join(f'    BorrowStatus.Probe{op} => {i+5}\n' for i,(op,name) in enumerate(ops)).rstrip())
s=s.replace('  return "imprecise"\n}', '  if position == 4 { return "imprecise" }\n'+''.join(f'  if position == {i+5} {{ return "{name}" }}\n' for i,(op,name) in enumerate(ops[:-1]))+f'  return "{ops[-1][1]}"\n}}');p.write_text(s)
p=dest/'compiler/src/semantic/BorrowCheck.silk';s=p.read_text();needle='      return Shape.Outside {reason: BorrowStatus.Storage}';assert s.count(needle)==1
s=s.replace(needle,'      let reason = match operation {\n'+''.join(f'        StorageOperation.{op} => BorrowStatus.Probe{op}\n' for op,name in ops)+'        _ => BorrowStatus.Storage\n      }\n      return Shape.Outside {reason: reason}');p.write_text(s)
print('Census probe generated',dest)
