"""Small process-isolation proof; no compiler or timing thresholds."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from immediate_edits import run_cohort


class ImmediateEdits(unittest.TestCase):
    def check_mode(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'source'
            output = root/'artifact'
            script = root/'fake.py'
            # Each first/second writer waits for the NEXT invocation to enter.
            # A harness that settles before editing deadlocks, so the outer
            # validation caller should impose a short process timeout.
            script.write_text('''import os, pathlib, sys, time
root=pathlib.Path(sys.argv[1])
stage=int((root/'source').read_text())
mode=sys.argv[2]
(root/f'entered-{stage}').write_text(str(os.getpid()))
(root/f'affinity-{stage}').write_text(','.join(map(str,sorted(os.sched_getaffinity(0)))))
staged=root/f'output-{stage}'
staged.write_text('#!/bin/sh\\necho stage-'+str(stage)+'\\n')
staged.chmod(0o755)
os.replace(staged,root/'artifact')
pid=os.fork()
if pid==0:
 (root/f'writer-{stage}').write_text(str(os.getpid()))
 if stage<2 and mode=='detach':
  deadline=time.monotonic()+5
  while not (root/f'entered-{stage+1}').exists():
   if time.monotonic()>deadline:os._exit(97)
   time.sleep(.001)
 os._exit(0)
while not (root/f'writer-{stage}').exists():time.sleep(.001)
if mode=='join':
 _,status=os.waitpid(pid,0)
 if os.waitstatus_to_exitcode(status)!=0:os._exit(98)
os._exit(0)
''')
            cohort = run_cohort([sys.executable,str(script),str(root),mode], root, dict(__import__('os').environ),
                                source, [b'0',b'1',b'2'], root, 'proof', output)
            self.assertIsNone(cohort['failure'])
            self.assertTrue(cohort['all_supervisors_reaped'])
            self.assertEqual(cohort['supervisor_exit_codes'], [0,0,0])
            rows = cohort['invocations']
            self.assertEqual(len(rows),3)
            supervisors = {row['supervisor_pid'] for row in rows}
            self.assertEqual(len(supervisors),3)
            for index,row in enumerate(rows):
                self.assertEqual(row['exit_code'],0)
                self.assertEqual(len(row['detached']),1 if mode=='detach' else 0)
                if mode=='detach':
                    self.assertEqual(row['detached'][0]['pid'],int((root/f'writer-{index}').read_text()))
                    self.assertEqual(row['detached'][0]['exit_code'],0)
                else:
                    self.assertEqual(row['process_tree'],row['primary'])
                    self.assertEqual(row['prior_descendants_observed_before_launch'],[])
                pinned = Path(row['retained_artifact'])
                self.assertEqual(subprocess.check_output([str(pinned)]).strip(),f'stage-{index}'.encode())
                if index and mode=='detach':
                    self.assertIn(rows[index-1]['stage'],row['prior_invocations_not_observed_settled_at_start'])
                    previous_writer = int((root/f'writer-{index-1}').read_text())
                    self.assertIn(previous_writer, [entry['pid'] for entry in row['prior_descendants_observed_before_launch'] if entry['state'] != 'Z'])
                self.assertEqual(row['supervisor_affinity'], list(map(int,(root/f'affinity-{index}').read_text().split(','))))
            self.assertEqual(len({row['artifact_inode'][1] for row in rows}),3)

    def test_detached_writers_keep_separate_supervisors_and_stage_artifacts(self):
        self.check_mode('detach')

    def test_parent_joined_writers_are_not_counted_again_as_detached(self):
        self.check_mode('join')


if __name__=='__main__':
    unittest.main()
