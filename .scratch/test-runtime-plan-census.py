import importlib.util,pathlib,unittest
s=importlib.util.spec_from_file_location('census',pathlib.Path(__file__).with_name('runtime-plan-census.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def snapshot(phase,worker=0,scale=1):
 v=dict.fromkeys(m.METRICS,0);v.update(starts=10*scale,compact=6*scale,ordinary=5*scale,storage=scale,helpers=2*scale,oracle=3*scale,mir=4*scale,glue=2*scale,export=scale)
 return [f'frontier plan {phase} {k} ms=1 a={worker} b={v[k]}' for k in m.METRICS]
class Cases(unittest.TestCase):
 def test_latest_and_parent_separate_with_nonzero_oracles(self):
  rows=snapshot('coordinator')+snapshot('initial')+['frontier worker-transport ms=1 a=0 b=1']+snapshot('final',scale=2)
  r=m.parse('\n'.join(rows));self.assertTrue(r['engaged']);self.assertEqual(r['totals']['compact'],18);self.assertEqual(r['totals']['mir'],12)
 def test_retained_full_build_requires_final_service_accounting(self):
  rows=snapshot('coordinator')+snapshot('initial')+['frontier worker-transport ms=1 a=0 b=1']
  self.assertEqual(m.parse('\n'.join(rows))['missing_final_workers'],[0])
  with self.assertRaises(AssertionError):m.parse('\n'.join(rows),require_final=True)
  self.assertTrue(m.parse('\n'.join(rows+snapshot('final')),require_final=True)['engaged'])
 def test_explicit_preparation_schema_and_real_consumer_reuse(self):
  rows=snapshot('scalar')+[f'frontier plan scalar {k} ms=1 a=0 b={v}' for k,v in [('prepare-starts',7),('prepared',7),('plan-uses',6),('mir-uses',7)]]
  r=m.parse('\n'.join(rows),schema='preparation-v1');self.assertTrue(r['engaged']);self.assertEqual(r['totals']['prepared'],7)
  with self.assertRaises(AssertionError):m.parse('\n'.join(rows))
  with self.assertRaises(AssertionError):m.parse('\n'.join(snapshot('scalar')),schema='preparation-v1')
  no_reuse=rows[:-2]+['frontier plan scalar plan-uses ms=1 a=0 b=0','frontier plan scalar mir-uses ms=1 a=0 b=7']
  self.assertFalse(m.parse('\n'.join(no_reuse),schema='preparation-v1')['engaged'])
 def test_scalar_and_zero_actual_activity(self):
  self.assertTrue(m.parse('\n'.join(snapshot('scalar')))['engaged'])
  self.assertFalse(m.parse('\n'.join(snapshot('scalar',scale=0)))['engaged'])
 def test_refuse_missing_duplicate_nonmonotonic_or_incomplete(self):
  good=snapshot('coordinator')+snapshot('initial')+['frontier worker-transport ms=1 a=0 b=1']
  for rows in [good[:-1],good[:-2]+good[-1:],good+snapshot('initial'),good+snapshot('final',scale=0),snapshot('final'),snapshot('scalar')+snapshot('coordinator')]:
   with self.subTest(rows=rows),self.assertRaises(AssertionError):m.parse('\n'.join(rows))
if __name__=='__main__':unittest.main()
