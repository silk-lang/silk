import os,tempfile,unittest
from pathlib import Path
import cache_segments_sequence as sequence
from cache_segments_maintenance import physical_inventory,prove_cycle,bounded_maintenance,correctness_schedule
class Cases(unittest.TestCase):
 def test_presence_policy_samebinary_and_source_controls(self):
  base=dict(PATH='/usr/bin',SILK_CACHE_SEGMENTS='0',SILK_RUNTIME_PLAN_CENSUS='1',SILK_EXPERIMENT_THREADS='1',SILK_EXECUTABLE_TRACE='1',LD_PRELOAD='bad')
  for op in ('check','build'):
   off=sequence.common_environment(base,op,'reference','feature');on=sequence.common_environment(base,op,'candidate','feature')
   self.assertEqual(on,{**off,'SILK_CACHE_SEGMENTS':'1'})
   self.assertEqual(on,sequence.common_environment(base,op,'reference','source'))
   self.assertEqual(off,sequence.common_environment({'PATH':'/usr/bin'},op,'reference','feature'))
 def test_physical_inventory_deduplicates_hardlinks_and_refuses_symlink(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'a').write_bytes(b'x'*8192);os.link(p/'a',p/'b');r=physical_inventory(p)
   self.assertEqual(r['logical_bytes'],8192);self.assertEqual(len(r['files']),1)
   (p/'outside').symlink_to('/tmp')
   with self.assertRaises(AssertionError):physical_inventory(p)
 def receipts(self):
  return [dict(kind='mixed-compaction-completed',evidence='raw:1',input_generation='old',output_generation='new',copied_payload_bytes=10,mixed_segments_rewritten=1,publication_committed=True,writers_reaped=True,monotonic_ns=10),dict(kind='physical-reclamation-completed',evidence='raw:2',retained_generation='new',retired_generations=['old'],pins_released=True,writers_reaped=True,reclaimed_allocated_bytes=4096,removed_objects=['object'],monotonic_ns=20)]
 def test_coarse_or_threshold_not_a_cycle_and_real_completion_binds_generation(self):
  self.assertIsNone(prove_cycle([dict(kind='compaction-due',evidence='raw:0')]))
  self.assertIsNone(prove_cycle(self.receipts()[:1]));self.assertIsNotNone(prove_cycle(self.receipts()))
  bad=self.receipts();bad[1]['retained_generation']='unrelated';self.assertIsNone(prove_cycle(bad))
  bad=self.receipts();bad[1]['pins_released']=False
  with self.assertRaises(AssertionError):prove_cycle(bad)
 def test_bounded_schedule_stops_without_false_success_and_unchanged_follows_cycle(self):
  def stage(name,index):return dict(stage=name,edit_index=index,all_children_reaped=True,source_mutated=name!='unchanged-after-cycle')
  r=bounded_maintenance(stage,lambda row:[],2);self.assertEqual(r['status'],'cycle-not-reached');self.assertFalse(r['accepted'])
  r=bounded_maintenance(stage,lambda row:self.receipts() if row['edit_index']==2 else [],4)
  self.assertEqual(r['edits'],2);self.assertEqual(r['matched_baseline_schedule'],[('cold',0),('edit',1),('edit',2),('unchanged-after-cycle',2)])
 def test_toggle_preserves_directory_and_selected_pack_sequence(self):
  s=correctness_schedule();self.assertEqual(len(s),9)
  self.assertEqual([(r['mode'],r['operation']) for r in s],[ (m,o) for m in ('off','on','off') for o in ('build','check','build')])
if __name__=='__main__':unittest.main()
