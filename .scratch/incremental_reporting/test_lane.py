import os,subprocess,sys,unittest
from lane import cpus,candidate_environment,expect_no_pool
class LanePolicy(unittest.TestCase):
 def test_affinity_parser(self):
  self.assertEqual(cpus('0'),[0]);self.assertEqual(cpus('0-3,2'),[0,1,2,3])
  for value in ['', '-1','3-0']:
   with self.assertRaises(ValueError):cpus(value)
 def test_explicit_serial_unsets_presence_flag_and_retains_other_policies(self):
  features={'SILK_RETAINED_CACHE':'1','SILK_FRONTIER_EPHEMERAL':'1'}
  parallel=candidate_environment({},features,'parallel','candidate','build')
  serial=candidate_environment({},features,'serial','candidate','build')
  self.assertEqual({k:v for k,v in parallel.items() if k!='SILK_EXPERIMENT_FRONTIER'},serial)
  self.assertNotIn('SILK_EXPERIMENT_FRONTIER',serial)
 def test_default_has_no_injected_overrides_and_one_core_requires_no_pool(self):
  self.assertEqual(candidate_environment({}, {},'default','candidate','build'),{})
  self.assertTrue(expect_no_pool('default',[0]));self.assertFalse(expect_no_pool('default',[0,1,2,3]))
 def test_affinity_is_inherited_by_child_and_grandchild(self):
  selected=min(os.sched_getaffinity(0))
  inner='import os; print(sorted(os.sched_getaffinity(0)))'
  outer='import os,subprocess,sys; os.sched_setaffinity(0,{'+str(selected)+'}); print(sorted(os.sched_getaffinity(0)),flush=True); subprocess.run([sys.executable,"-c",'+repr(inner)+'],check=True)'
  output=subprocess.check_output([sys.executable,'-c',outer],text=True).splitlines()
  self.assertEqual(output,[str([selected]),str([selected])])
