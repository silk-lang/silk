import tempfile
import unittest
from pathlib import Path

from closure_component_sequence import common_environment, validate_trace, compare_artifacts


class ClosureComponentPolicyTests(unittest.TestCase):
    def test_identical_policy_ignores_inherited_toggle_contamination(self):
        dirty = {'PATH':'/bin','SILK_FRONTIER_REUSE_COMPLETED':'1',
                 'SILK_NATIVE_BUILD_PIPELINE':'0','SILK_RETAINED_CACHE':'0',
                 'SILK_FRONTIER_WORKERS':'87','SILK_ARTIFACT_FAULT':'1'}
        for operation in ('check','build'):
            reference=common_environment(dirty,operation,'reference')
            candidate=common_environment({'PATH':'/bin'},operation,'reference')
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
            with self.assertRaises(AssertionError):validate_trace(dict(row),'build',[0,1,2,3],'reference')
            path.write_text(trace+'\nfrontier native cache completed')
            validate_trace(dict(row),'build',[0,1,2,3],'reference')
            row['supervisor_affinity']=[0]
            path.write_text('')
            with self.assertRaises(AssertionError):validate_trace(dict(row),'check',[0],'reference')
            path.write_text('host capacity refused')
            validate_trace(dict(row),'check',[0],'reference')


class ClosureSelectionTests(unittest.TestCase):
    def test_only_closure_differs_and_stale_diagnostic_flags_are_scrubbed(self):
        dirty={'PATH':'/bin','SILK_EXECUTABLE_TRACE':'1','SILK_QUERY_RUN_CENSUS':'1','SILK_EXECUTABLE_CLOSURE':'0','SILK_SHARED_TYPED_BODIES':'1','SILK_EXPERIMENT_THREADS':'1','LD_PRELOAD':'bad'}
        for operation in ('check','build'):
            left=common_environment(dirty,operation,'reference');right=common_environment(dirty,operation,'candidate')
            self.assertEqual(left['SILK_EXECUTABLE_SPECIALIZATION'],'1')
            self.assertEqual(right.pop('SILK_EXECUTABLE_CLOSURE'),'1');self.assertEqual(left,right)
            for key in ('SILK_EXECUTABLE_TRACE','SILK_QUERY_RUN_CENSUS','SILK_SHARED_TYPED_BODIES','SILK_EXPERIMENT_THREADS','LD_PRELOAD'):self.assertNotIn(key,left)
    def test_positive_candidate_pruning_and_complete_native_proof_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'trace';row=dict(log=str(path),stage='cold',supervisor_affinity=[0,1,2,3],exit_code=0,detached=[])
            lines=['frontier accepted','frontier artifact proved ms=1 a=2 b=100','frontier artifact emitted ms=2 a=60 b=0','frontier artifact accepted','frontier native coordinator started','frontier native cache checkpoint','frontier native objects published','frontier native cache completed']
            path.write_text('\n'.join(lines));checked=dict(row);validate_trace(checked,'build',[0,1,2,3],'candidate');self.assertEqual(checked['closure_selection']['pruned_definitions'],40)
            for bad in [lines[:-1],lines+[lines[1]],[x.replace('a=60','a=100') for x in lines],lines+['frontier executable closure refused'],lines+['frontier artifact refused']]:
                path.write_text('\n'.join(bad))
                with self.assertRaises(AssertionError):validate_trace(dict(row),'build',[0,1,2,3],'candidate')

if __name__=='__main__':unittest.main()
