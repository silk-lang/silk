import unittest
from cpu_regressions import compare,change
class CPUCostTests(unittest.TestCase):
 def test_cpu_regression_is_visible_even_when_wall_improves(self):
  left=dict(stage='first-edit',wall_s=3,settled_wall_s=4,process_tree=dict(user_s=2,sys_s=1),detached=[dict(user_s=.2,sys_s=.1)])
  right=dict(stage='first-edit',wall_s=2,settled_wall_s=3,process_tree=dict(user_s=3,sys_s=1),detached=[dict(user_s=.4,sys_s=.1)])
  rows=[dict(operation='build',workload='compiler',round=0,mode=mode,validated=True,all_supervisors_reaped=True,invocations=[row]) for mode,row in [('reference',left),('candidate',right)]]
  result=compare(rows)[0]
  self.assertFalse(result['foreground']['increased']);self.assertTrue(result['total_cpu']['regression_gt5pct']);self.assertTrue(result['detached_writer_cpu']['increased'])
 def test_any_increase_is_visible_and_new_writer_cost_does_not_divide_by_zero(self):
  self.assertTrue(change(1,1.001)['increased']);self.assertFalse(change(1,1.001)['regression_gt5pct'])
  result=change(0,.1);self.assertIsNone(result['ratio']);self.assertTrue(result['increased'])
if __name__=='__main__':unittest.main()
