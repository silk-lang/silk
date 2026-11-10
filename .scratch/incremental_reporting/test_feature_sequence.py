"""Same-binary timing guards; synthetic only, no compiler invocation."""
import copy
import tempfile
import unittest
from pathlib import Path
from feature_sequence import (FEATURE_FLAGS, DIAGNOSTIC_FLAGS, WORKLOAD_PROFILE_FLAGS,
                              common_environment, validate_construction, validate_trace, compare_artifacts)

class FeatureSequenceTests(unittest.TestCase):
    def test_only_named_feature_changes_even_with_inherited_tracing(self):
        dirty = dict(PATH='/bin', SILK_FRONTIER_REUSE_COMPLETED='1', SILK_ARTIFACT_TRACE='1',
                     SILK_NATIVE_BUILD_PIPELINE_FAIL='1', SILK_FRONTIER_WORKERS='99')
        dirty.update({flag:'0' for flag in (*FEATURE_FLAGS.values(), *DIAGNOSTIC_FLAGS, *WORKLOAD_PROFILE_FLAGS)})
        for feature, flag in FEATURE_FLAGS.items():
            for operation in ('check', 'build'):
                with self.subTest(feature=feature, operation=operation):
                    off = common_environment(dirty, operation, feature, 'reference')
                    on = common_environment(dirty, operation, feature, 'candidate')
                    self.assertEqual(off, common_environment({'PATH':'/bin'}, operation, feature, 'reference'))
                    self.assertEqual(on, {**off, flag:'1'})
                    self.assertEqual(off['SILK_RETAINED_CACHE'], '1')
                    self.assertEqual('SILK_NATIVE_BUILD_PIPELINE' in off, operation=='build')
                    for forbidden in (*DIAGNOSTIC_FLAGS, *WORKLOAD_PROFILE_FLAGS, 'SILK_FRONTIER_REUSE_COMPLETED'):
                        self.assertNotIn(forbidden, on)

    def pins(self):
        pin=dict(binary='/frozen/compiler', source='a'*40, sha256='b'*64, construction='/receipt.json')
        record=dict(source=pin['source'],sha256=pin['sha256'],builder_sha256='c'*64,
                    clang_sha256='d'*64,optimization='speed',debug=False,codegen_units=4,profile_use=None)
        return {mode:dict(pin) for mode in ('reference','candidate')}, {mode:dict(record) for mode in ('reference','candidate')}

    def test_construction_requires_claimed_profile_not_just_equal_profiles(self):
        pins, records=self.pins();validate_construction(pins,records)
        for field,value in [('optimization','none'),('debug',True),('codegen_units',1),('profile_use','training.profdata')]:
            with self.subTest(field=field):
                bad=copy.deepcopy(records)
                for record in bad.values():record[field]=value
                with self.assertRaises(AssertionError):validate_construction(pins,bad)
        bad=copy.deepcopy(pins);bad['candidate']['source']='f'*40
        with self.assertRaises(AssertionError):validate_construction(bad,records)
        bad=copy.deepcopy(records);bad['candidate']['sha256']='e'*64
        with self.assertRaises(AssertionError):validate_construction(pins,bad)

    def test_runtime_policy_still_requires_outputs_and_exact_policy_requires_hash(self):
        left=dict(artifact_sha256='one',runtime=[dict(stdout_sha256='same')])
        right=dict(artifact_sha256='two',runtime=[dict(stdout_sha256='same')])
        with self.assertRaises(AssertionError):compare_artifacts(left,right,'exact')
        compare_artifacts(left,right,'runtime')
        right['runtime']=[dict(stdout_sha256='wrong')]
        with self.assertRaises(AssertionError):compare_artifacts(left,right,'runtime')

    def test_cpu_lanes_warm_no_pool_and_writer_failure_are_not_silently_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'trace';row=dict(log=str(path),stage='cold',supervisor_affinity=[0],exit_code=0,detached=[])
            path.write_text('host capacity refused')
            validate_trace(dict(row),'build',[0])
            path.write_text('')
            with self.assertRaises(AssertionError):validate_trace(dict(row),'build',[0])
            row.update(stage='first-edit',supervisor_affinity=[0,1,2,3],prior_descendants_observed_before_launch=[])
            validate_trace(dict(row),'build',[0,1,2,3])
            path.write_text('frontier split\nfrontier accepted')
            with self.assertRaises(AssertionError):validate_trace(dict(row),'build',[0,1,2,3])
            path.write_text('');row['detached']=[dict(exit_code=7)]
            with self.assertRaises(AssertionError):validate_trace(dict(row),'check',[0,1,2,3])

if __name__=='__main__':unittest.main()
