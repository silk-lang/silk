import unittest
import checked_plan_component_sequence as c
class Cases(unittest.TestCase):
 def test_only_ordinary_policy_survives_and_modes_match(self):
  clean={'PATH':'/usr/bin'}
  polluted=dict(clean,SILK_RUNTIME_PLAN_CENSUS='1',SILK_CHECKED_RUNTIME_PLAN='1',SILK_EXECUTABLE_SPECIALIZATION='1',SILK_EXECUTABLE_CLOSURE='1',SILK_EXPERIMENT_THREADS='1',SILK_QUERY_RUN_CENSUS='1',SILK_CPU0_CACHE_TRACE='1',LD_PRELOAD='bad',LLVM_PROFILE_FILE='bad')
  for op in ('check','build'):
   expected=c.common_environment(clean,op,'reference')
   for mode in ('reference','candidate'):
    self.assertEqual(c.common_environment(polluted,op,mode),expected)
   for flag in ('SILK_RUNTIME_PLAN_CENSUS','SILK_CHECKED_RUNTIME_PLAN','SILK_EXECUTABLE_SPECIALIZATION','SILK_EXECUTABLE_CLOSURE','SILK_EXPERIMENT_THREADS','LD_PRELOAD','LLVM_PROFILE_FILE'):self.assertNotIn(flag,expected)
   self.assertEqual('SILK_NATIVE_BUILD_PIPELINE' in expected,op=='build')
 def test_immediate_sequence_has_no_preedit_unchanged(self):
  self.assertEqual(tuple(c.STAGES),('cold','first-edit','second-edit','unchanged'))
if __name__=='__main__':unittest.main()
