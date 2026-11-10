import tempfile,unittest
from pathlib import Path
from thread_component_sequence import common_environment,validate_trace

def thread_lines():
    return [f'frontier thread initial {metric} ms=1 a={i} b={value}' for i in range(4) for metric,value in [('tasks',2),('body avoided',1),('body published',2),('body eligible',4),('body refused',1),('mir owned',10),('mir skipped',8)]]
class ThreadControlTests(unittest.TestCase):
    def test_both_modes_request_threads_and_scrub_other_features(self):
        dirty={'PATH':'/bin','SILK_EXECUTABLE_CLOSURE':'1','SILK_EXECUTABLE_SPECIALIZATION':'1','SILK_QUERY_RUN_CENSUS':'1','SILK_SHARED_TYPED_BODIES':'1','LD_PRELOAD':'bad'}
        for op in ('check','build'):
            left=common_environment(dirty,op,'reference');right=common_environment(dirty,op,'candidate')
            self.assertEqual(left,right);self.assertEqual(right['SILK_EXPERIMENT_THREADS'],'1')
            for key in dirty:
                if key!='PATH':self.assertNotIn(key,right)
    def test_thread_joined_build_requires_actual_lane_and_no_coordinator(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'log';row=dict(log=str(p),stage='cold',supervisor_affinity=[0,1,2,3],exit_code=0,detached=[])
            proof=['frontier accepted','frontier artifact proved ms=3 a=1 b=100','frontier artifact emitted ms=4 a=100 b=0','frontier threads joined','frontier artifact accepted ms=5 a=0 b=0']
            good=thread_lines()+proof;p.write_text('\n'.join(good));validate_trace(dict(row),'build',[0,1,2,3],'candidate')
            for bad in [good[:-1],[x for x in good if x!='frontier threads joined'],good+['frontier native coordinator started'],good+['frontier threads joined']]:
                p.write_text('\n'.join(bad))
                with self.assertRaises(AssertionError):validate_trace(dict(row),'build',[0,1,2,3],'candidate')
            p.write_text('\n'.join(good))
            with self.assertRaises(AssertionError):validate_trace(dict(row),'build',[0,1,2,3],'reference')
    def test_cpu0_and_warm_must_not_spawn_and_thread_writer_overlap_is_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'log';row=dict(log=str(p),stage='cold',supervisor_affinity=[0],exit_code=0,detached=[])
            p.write_text('host capacity refused');validate_trace(dict(row),'check',[0],'candidate')
            p.write_text('host capacity refused\nfrontier threads joined')
            with self.assertRaises(AssertionError):validate_trace(dict(row),'check',[0],'candidate')
            row.update(stage='first-edit',supervisor_affinity=[0,1,2,3],prior_descendants_observed_before_launch=[dict(pid=19,state='R')]);p.write_text('')
            checked=dict(row);validate_trace(checked,'build',[0,1,2,3],'candidate');self.assertTrue(checked['live_prior_descendants'])
            with self.assertRaises(AssertionError):validate_trace(dict(row),'build',[0,1,2,3],'reference')
if __name__=='__main__':unittest.main()
