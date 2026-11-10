import unittest
from report import summarize, render

def row(mode,seq,stage,time,settled=None,round=0):
 return dict(mode=mode,operation='check',workload='compiler',sequence=seq,stage=stage,round=round,
  wall_s=time,settled_wall_s=settled or time,exit_code=0,detached=[],frontier_fallback=False)
class Reporting(unittest.TestCase):
 def test_direct_refill_not_hidden_by_priming(self):
  rows=[row(m,s,t,v) for s,t,vs in [('edits','cold',[30,10]),('edits','first-edit',[1,7]),('primed-edits','first-edit',[1,1])] for m,v in zip(['baseline','candidate'],vs)]
  out=summarize(rows);self.assertEqual(len(out),3)
  direct=next(r for r in out if r['sequence']=='edits' and r['stage']=='first-edit');self.assertTrue(direct['regression'])
  primed=next(r for r in out if r['sequence']=='primed-edits');self.assertFalse(primed['regression'])
  text=render({},rows,out,1.05);self.assertIn('DIRECT:',text);self.assertIn('PRIMED:',text);self.assertIn('REGRESSIONS: 1',text)
 def test_settled_regression_independent_from_foreground(self):
  out=summarize([row('baseline','edits','first-edit',2,2.1),row('candidate','edits','first-edit',1,5)])[0]
  self.assertEqual(out['foreground_speedup'],2);self.assertTrue(out['regression']);self.assertEqual(out['writer_tail_s'],4)
 def test_requires_same_round_baseline(self):
  out=summarize([row('baseline','edits','cold',3,round=0),row('candidate','edits','cold',1,round=1)])[0]
  self.assertEqual(out['paired'],0);self.assertIn('missing same-round baseline',out['issues'])
 def test_failed_writer_not_a_speedup(self):
  b=row('baseline','edits','cold',3);c=row('candidate','edits','cold',1);c['detached']=[dict(exit_code=1)]
  self.assertEqual(summarize([b,c])[0]['paired'],0)
if __name__=='__main__':unittest.main()

class CpuLanes(unittest.TestCase):
 def test_never_pairs_one_core_with_four_core(self):
  b=row('baseline','edits','cold',20);b.update(cpu_lane='cpus=0',worker_policy='serial')
  c=row('candidate','edits','cold',5);c.update(cpu_lane='cpus=0,1,2,3',worker_policy='serial')
  self.assertEqual(summarize([b,c])[0]['paired'],0)
 def test_same_stage_keeps_two_distinct_cpu_lane_ratios(self):
  rows=[]
  for cpu,values in [('cpus=0',(20,22)),('cpus=0,1,2,3',(20,7))]:
   for mode,elapsed in zip(['baseline','candidate'],values):
    r=row(mode,'edits','cold',elapsed);r.update(cpu_lane=cpu,worker_policy='parallel');rows.append(r)
  out=summarize(rows);self.assertEqual(len(out),2);self.assertEqual({r['cpu_lane'] for r in out},{'cpus=0','cpus=0,1,2,3'})
 def test_worker_policies_never_pair(self):
  b=row('baseline','edits','cold',20);b.update(cpu_lane='cpus=0',worker_policy='serial')
  c=row('candidate','edits','cold',5);c.update(cpu_lane='cpus=0',worker_policy='default')
  self.assertEqual(summarize([b,c])[0]['paired'],0)
