"""Synthetic overlap and settled sequencing; no compiler or timing thresholds."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from edit_sequence import run_cohort, STAGES


class EditSequenceTests(unittest.TestCase):
    def check_sequence(self, sequence):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';output=root/'artifact';script=root/'fake.py'
            script.write_text('''import os,pathlib,sys,time,json
root=pathlib.Path(sys.argv[1]);policy=sys.argv[2];counter=root/'counter'
index=int(counter.read_text())+1 if counter.exists() else 0;counter.write_text(str(index))
source=root/'source';(root/f'input-{index}').write_text(json.dumps({'text':source.read_text(),'mtime':source.stat().st_mtime_ns}))
(root/f'entered-{index}').write_text(str(os.getpid()))
staged=root/f'output-{index}';staged.write_text(str(index));os.replace(staged,root/'artifact')
pid=os.fork()
if pid==0:
 (root/f'writer-{index}').write_text(str(os.getpid()))
 if index<3 and policy=='immediate':
  deadline=time.monotonic()+5
  while not (root/f'entered-{index+1}').exists():
   if time.monotonic()>deadline:os._exit(97)
   time.sleep(.001)
 os._exit(0)
while not (root/f'writer-{index}').exists():time.sleep(.001)
os._exit(0)
''')
            c=run_cohort([sys.executable,str(script),str(root),sequence],root,dict(os.environ),source,
                         [b'0',b'1',b'2',b'2'],root,'proof',output,sequence=sequence)
            self.assertIsNone(c['failure']);self.assertTrue(c['all_supervisors_reaped'])
            self.assertEqual(c['supervisor_exit_codes'],[0]*4)
            self.assertEqual([r['stage'] for r in c['invocations']],list(STAGES))
            self.assertEqual(json.loads((root/'input-2').read_text()),json.loads((root/'input-3').read_text()))
            self.assertFalse(c['invocations'][3]['source_mutated'])
            for index,row in enumerate(c['invocations']):
                self.assertEqual(row['exit_code'],0);self.assertEqual(len(row['detached']),1)
                self.assertEqual(row['detached'][0]['pid'],int((root/f'writer-{index}').read_text()))
                self.assertEqual(row['detached'][0]['exit_code'],0)
                self.assertEqual(Path(row['retained_artifact']).read_text(),str(index))
                if index:
                    previous=c['invocations'][index-1]
                    if sequence=='immediate':
                        self.assertIn(previous['stage'],row['prior_invocations_not_observed_settled_at_start'])
                    else:
                        self.assertGreaterEqual(row['started_ns'],previous['settled_ns'])
                        self.assertEqual(row['prior_invocations_not_observed_settled_at_start'],[])
            self.assertEqual(len({r['supervisor_pid'] for r in c['invocations']}),4)

    def test_immediate_fourth_command_overlaps_without_source_rewrite(self):
        self.check_sequence('immediate')

    def test_settled_policy_waits_each_writer_without_source_rewrite(self):
        self.check_sequence('settled')


if __name__=='__main__':unittest.main()
