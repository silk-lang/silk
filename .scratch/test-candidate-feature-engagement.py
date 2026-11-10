import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).with_name('candidate-feature-engagement.py')
spec=importlib.util.spec_from_file_location('engagement',p);e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)

def record(label,a,b):return f'frontier {label} ms=1 a={a} b={b}'
def snapshot(worker,phase,avoided,value):
 return [record('body-share '+phase+' avoided',worker,avoided),*[record('body-share '+metric,worker,value) for metric in e.SHARED_METRICS],record('body-share codec-depth',worker,value)]

class ParserTests(unittest.TestCase):
 def test_count_events_are_not_deduplicated_by_store_local_id(self):
  rows=[record('executable count certified',7,0)]*3+[record('executable count text emitted',7,0),record('executable count text reused',7,0)]
  result=e.parse_feature('\n'.join(rows),'executables')
  self.assertTrue(result['engaged']);self.assertEqual(result['event_counts']['executable count certified'],3)
  self.assertEqual(len(result['raw_records']),5)
 def test_count_requires_certification_and_emission(self):
  self.assertFalse(e.parse_feature(record('executable count certified',7,0),'executables')['engaged'])
  with self.assertRaises(AssertionError):e.parse_feature('frontier executable count certified truncated','executables')
 def test_schema_combines_kinds_and_requires_actual_mir_template_reuse(self):
  rows=[record('executable schema certified',51,0),record('executable schema certified',51,0),
        record('executable schema text emitted',96,0),record('executable schema text reused',96,0)]
  before=e.parse_feature('\n'.join(rows),'executables')
  self.assertFalse(before['engaged'])
  rows.append(record('executable mir template reused',51,0))
  result=e.parse_feature('\n'.join(rows),'executables')
  self.assertTrue(result['engaged']);self.assertEqual(result['trace_protocol'],'schema-template')
  self.assertEqual(result['event_counts']['executable schema certified'],2)
  self.assertEqual(result['event_counts']['executable mir template reused'],1)
  self.assertIn('Count and Resize',result['template_kind_note'])
  self.assertEqual(len(result['raw_records']),5)
  no_text_reuse=[row for row in rows if 'schema text reused' not in row]
  self.assertFalse(e.parse_feature('\n'.join(no_text_reuse),'executables')['engaged'])
 def test_new_schema_rejects_truncation_and_stitched_legacy_protocol(self):
  for text in ['frontier executable schema certified truncated','frontier executable mir template reused truncated',
               record('executable count certified',1,0)+'\n'+record('executable schema certified',1,0)]:
   with self.subTest(text=text),self.assertRaises(AssertionError):e.parse_feature(text,'executables')
 def test_shared_snapshots_supersede_and_global_arena_is_max(self):
  a=snapshot(0,'initial',2,3);b=snapshot(4,'initial',1,5)
  rows=[item for pair in zip(a,b) for item in pair]
  rows+=snapshot(0,'final',6,9)+[record('worker-transport',0,4),record('worker-transport',4,2)]
  result=e.parse_feature('\n'.join(rows),'shared-bodies')
  self.assertTrue(result['engaged']);self.assertEqual(result['totals']['avoided'],7)
  self.assertEqual(result['totals']['eligible'],14);self.assertEqual(result['arena_bytes_max'],9)
  self.assertEqual(result['totals']['codec-depth'],14)
  self.assertEqual(result['selected_workers']['4']['selected_phase'],'initial')
 def test_shared_refuses_missing_worker_incomplete_or_nonmonotonic_snapshot(self):
  a=snapshot(0,'initial',2,3)
  for rows in [a+[record('worker-transport',4,0)],a[:-1]+a+[record('worker-transport',0,0)],a+snapshot(0,'final',1,4)+[record('worker-transport',0,0)],a[:2]+[record('worker-transport',0,0)]]:
   with self.subTest(rows=rows),self.assertRaises(AssertionError):e.parse_feature('\n'.join(rows),'shared-bodies')
 def test_native_completion_and_no_fallback_are_required(self):
  lines=['frontier accepted','frontier artifact proved','frontier artifact emitted','frontier artifact accepted','frontier native coordinator started','frontier native cache checkpoint','frontier native objects published','frontier native cache completed']
  e.validate_proof('\n'.join(lines))
  for bad in [lines[:-1],lines+['host capacity refused'],lines[:-2]+list(reversed(lines[-2:])),lines+[lines[-1]]]:
   with self.assertRaises(AssertionError):e.validate_proof('\n'.join(bad))

def thread_initial(worker,avoided=2):
 values={'tasks':3,'body avoided':avoided,'body published':4,'body eligible':7,'body refused':1,'mir owned':20,'mir skipped':5}
 return [record('thread initial '+m,worker,v) for m,v in values.items()]
def thread_final(worker,delta):
 values={'body avoided':2+delta,'body published':4+delta,'body eligible':7+delta,'body refused':1+delta,'mir owned':20+delta,'mir skipped':5+delta}
 return [record('thread final '+m,worker,v) for m,v in values.items()]
def thread_rows():
 return [row for batch in zip(*(thread_initial(i) for i in range(4))) for row in batch]

class ThreadTests(unittest.TestCase):
 def test_thread_environment_preserves_normal_policy_but_scrubs_other_features(self):
  clean,env=e.engagement_environment({'PATH':'/usr/bin','SILK_SHARED_TYPED_BODIES':'1','SILK_EXECUTABLE_SPECIALIZATION':'1','SILK_EXECUTABLE_TRACE':'1','SILK_QUERY_RUN_CENSUS':'1','LD_PRELOAD':'bad','LLVM_PROFILE_FILE':'bad'},'threads')
  self.assertEqual(clean,{'PATH':'/usr/bin'})
  for flag in ('SILK_EXPERIMENT_THREADS','SILK_EXPERIMENT_FRONTIER','SILK_RETAINED_CACHE','SILK_NATIVE_BUILD_PIPELINE'):self.assertEqual(env[flag],'1')
  for flag in ('SILK_SHARED_TYPED_BODIES','SILK_EXECUTABLE_SPECIALIZATION','SILK_EXECUTABLE_TRACE','SILK_QUERY_RUN_CENSUS','LD_PRELOAD','LLVM_PROFILE_FILE'):self.assertNotIn(flag,env)
 def test_four_interleaved_initial_shards_and_repeated_final_use_latest(self):
  rows=thread_rows()+thread_final(1,3)+thread_final(1,7)
  result=e.parse_feature('\n'.join(rows),'threads')
  self.assertTrue(result['engaged']);self.assertEqual(result['initial_totals']['body avoided'],8)
  self.assertEqual(result['latest_totals']['body avoided'],15)
  self.assertEqual(len(result['workers']['1']['final']),2)
  self.assertEqual(result['selected_workers']['0']['phase'],'initial')
 def test_frontier_accepted_alone_is_not_thread_evidence(self):
  with self.assertRaises(AssertionError):e.parse_feature(record('accepted',0,0),'threads')
  rows=[row for batch in zip(*(thread_initial(i,0) for i in range(4))) for row in batch]
  self.assertFalse(e.parse_feature('\n'.join(rows),'threads')['engaged'])
 def test_missing_duplicate_or_extra_initial_shards_refused(self):
  good=thread_rows()
  for bad in [good[:-1],good+[good[0]],good+thread_initial(4),good+[record('worker-transport',0,1)]]:
   with self.subTest(bad=bad),self.assertRaises(AssertionError):e.parse_feature('\n'.join(bad),'threads')
 def test_final_partial_duplicate_and_nonmonotonic_refused(self):
  good=thread_rows()
  for suffix in [thread_final(0,1)[:-1],thread_final(0,2)+thread_final(0,1),thread_final(0,1)[:2]+thread_final(0,1)[1:], [record('thread final body refused',0,0)]]:
   with self.subTest(suffix=suffix),self.assertRaises(AssertionError):e.parse_feature('\n'.join(good+suffix),'threads')
 def test_malformed_thread_trace_refused(self):
  with self.assertRaises(AssertionError):e.parse_feature('\n'.join(thread_rows()+['frontier thread initial tasks truncated']),'threads')
 def test_joined_policy_requires_artifact_and_forbids_fake_coordinator(self):
  proof=['frontier accepted','frontier artifact proved','frontier artifact emitted','frontier artifact accepted']
  valid='\n'.join(thread_rows()+proof[:3]+['frontier threads joined']+proof[3:])
  self.assertEqual(e.validate_proof(valid,'thread-joined-before-native'),proof)
  for bad in ['\n'.join(thread_rows()+proof),valid+'\nfrontier threads joined',valid+'\n'+record('thread final body avoided',0,3),'\n'.join(thread_rows()+['frontier threads joined']+proof),'\n'.join(thread_rows()+proof[:-1]),valid+'\nfrontier native coordinator started',valid+'\nhost capacity refused','\n'.join(thread_rows()+list(reversed(proof))),valid+'\nfrontier artifact accepted']:
   with self.subTest(bad=bad),self.assertRaises(AssertionError):e.validate_proof(bad,'thread-joined-before-native')
  with self.assertRaises(AssertionError):e.validate_proof(valid) # ordinary lane still requires coordinator

class ClosureTests(unittest.TestCase):
 def closure(self,full=100,selected=60):
  return [record(label,1,0) for label in e.SCHEMA_LABELS]+[record('artifact proved',2,full),record('artifact emitted',selected,0)]
 def test_retained_full_graph_and_selected_replies_prove_positive_pruning(self):
  result=e.parse_feature('\n'.join(self.closure()),'closure')
  self.assertTrue(result['engaged']);self.assertEqual(result['pruned_definitions'],40)
  self.assertFalse(e.parse_feature('\n'.join(self.closure(100,100)),'closure')['engaged'])
 def test_refusal_ambiguous_attempt_and_serial_counts_cannot_pass(self):
  for rows in [self.closure()+[record('executable closure refused',100,0)],self.closure()+[record('artifact proved',3,100)],self.closure(50,60),self.closure(100,0),list(reversed(self.closure())),[record('executable closure selected',100,60)]]:
   with self.subTest(rows=rows),self.assertRaises(AssertionError):e.parse_feature('\n'.join(rows),'closure')
 def test_root_snapshot_reports_separate_authorities_without_proving_pruning(self):
  rows=self.closure();rows.insert(-1,record('artifact closure roots',12,98))
  result=e.parse_feature('\n'.join(rows),'closure')
  self.assertEqual((result['executable_roots'],result['expanded_proof_roots']),(12,98))
  self.assertTrue(result['engaged'])
  rows=self.closure(100,100);rows.insert(-1,record('artifact closure roots',12,98))
  self.assertFalse(e.parse_feature('\n'.join(rows),'closure')['engaged'])
  for extra in [[record('artifact closure roots',12,98)]*2,[record('artifact closure roots',99,12)]]:
   with self.subTest(extra=extra),self.assertRaises(AssertionError):e.parse_feature('\n'.join(self.closure()[:-1]+extra+self.closure()[-1:]),'closure')
 def test_closure_enables_both_features_and_trace_only_for_engagement(self):
  clean,env=e.engagement_environment({'PATH':'/usr/bin','SILK_EXPERIMENT_THREADS':'1','SILK_SHARED_TYPED_BODIES':'1'},'closure')
  for flag in ('SILK_EXECUTABLE_SPECIALIZATION','SILK_EXECUTABLE_CLOSURE','SILK_EXECUTABLE_TRACE'):self.assertEqual(env[flag],'1')
  self.assertNotIn('SILK_EXPERIMENT_THREADS',env);self.assertNotIn('SILK_SHARED_TYPED_BODIES',env)

if __name__=='__main__':unittest.main()
