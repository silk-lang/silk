import tempfile
import unittest
from pathlib import Path

from component_edits import common_environment, validate_trace, compare_artifacts


class ComponentPolicyTests(unittest.TestCase):
    def test_identical_policy_ignores_inherited_toggle_contamination(self):
        dirty = {'PATH':'/bin','SILK_FRONTIER_REUSE_COMPLETED':'1',
                 'SILK_NATIVE_BUILD_PIPELINE':'0','SILK_RETAINED_CACHE':'0',
                 'SILK_FRONTIER_WORKERS':'87','SILK_ARTIFACT_FAULT':'1'}
        for operation in ('check','build'):
            reference=common_environment(dirty,operation)
            candidate=common_environment({'PATH':'/bin'},operation)
            self.assertEqual(reference,candidate)
            self.assertEqual(reference['SILK_RETAINED_CACHE'],'1')
            self.assertNotIn('SILK_FRONTIER_REUSE_COMPLETED',reference)
            self.assertEqual('SILK_NATIVE_BUILD_PIPELINE' in reference,operation=='build')

    def test_runtime_policy_does_not_relax_exact_artifact_policy(self):
        left = {'artifact_sha256':'left','runtime':[{'stdout_sha256':'same'}]}
        right = {'artifact_sha256':'right','runtime':[{'stdout_sha256':'same'}]}
        with self.assertRaises(AssertionError):compare_artifacts(left,right,'exact')
        compare_artifacts(left,right,'runtime')
        right['runtime']=[{'stdout_sha256':'different'}]
        with self.assertRaises(AssertionError):compare_artifacts(left,right,'runtime')

    def test_completion_barrier_and_cpu0_refusal_are_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'trace'
            row=dict(log=str(path),stage='cold',supervisor_affinity=[0,1,2,3],exit_code=0,detached=[])
            trace='\n'.join(['frontier accepted','frontier artifact accepted',
                'frontier native coordinator started','frontier native cache checkpoint',
                'frontier native objects published'])
            path.write_text(trace)
            with self.assertRaises(AssertionError):validate_trace(dict(row),'build',[0,1,2,3])
            path.write_text(trace+'\nfrontier native cache completed')
            validate_trace(dict(row),'build',[0,1,2,3])
            row['supervisor_affinity']=[0]
            path.write_text('')
            with self.assertRaises(AssertionError):validate_trace(dict(row),'check',[0])
            path.write_text('host capacity refused')
            validate_trace(dict(row),'check',[0])


if __name__=='__main__':unittest.main()
