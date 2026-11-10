import unittest
from option_screen import screen_environment


class EnvironmentIsolation(unittest.TestCase):
    def test_pipeline_toggle_excludes_registry_and_failure_injection(self):
        dirty={'PATH':'/bin','SILK_FRONTIER_REUSE_COMPLETED':'1',
               'SILK_NATIVE_BUILD_PIPELINE':'1','SILK_NATIVE_BUILD_PIPELINE_FAIL':'1',
               'SILK_EXPERIMENT_COMPLETE_MODULES':'1'}
        off,_,_=screen_environment(dirty,'pipeline','off','off','build')
        on,_,_=screen_environment(dirty,'pipeline','off','on','build')
        self.assertEqual({k:v for k,v in on.items() if off.get(k)!=v}, {'SILK_NATIVE_BUILD_PIPELINE':'1'})
        self.assertNotIn('SILK_FRONTIER_REUSE_COMPLETED',on)
        self.assertNotIn('SILK_NATIVE_BUILD_PIPELINE_FAIL',on)
        self.assertNotIn('SILK_EXPERIMENT_COMPLETE_MODULES',on)
        self.assertEqual(off['PATH'],'/bin')
        self.assertEqual(off['SILK_RETAINED_CACHE'],'1')
        self.assertEqual(off['SILK_EXPERIMENT_DEV_PACKS'],'1')

    def test_registry_toggle_holds_pipeline_choice_constant(self):
        for operation in ('check','build'):
            for fixed in ('off','on'):
                off,_,_=screen_environment({},'registry',fixed,'off',operation)
                on,_,_=screen_environment({},'registry',fixed,'on',operation)
                self.assertEqual({k:v for k,v in on.items() if off.get(k)!=v}, {'SILK_FRONTIER_REUSE_COMPLETED':'1'})
                self.assertEqual('SILK_NATIVE_BUILD_PIPELINE' in off, fixed=='on' and operation=='build')


if __name__=='__main__':unittest.main()
