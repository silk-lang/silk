import unittest
from diagnostic_blocks import diagnostic_blocks


class DiagnosticBlocksTests(unittest.TestCase):
    def test_complete_notes_locations_excerpts_and_order_survive(self):
        trace='''Compiling package
/work/run/src/main.silk:2:8: warning[TEST1] a message
  note: first note
  note: /work/run/src/other.silk:9:3: related location
  2 | a source excerpt
    |        ^~~
continuation text
/work/run/src/main.silk:4:2: warning[TEST2] second message
  note: last note
  link     clang 0.19s
  Semantic work (own time, inclusive time, runs)
  1.2ms  3.4ms  5 Body
Finished package in 1.2s
'''
        result=diagnostic_blocks(trace,'/work/run')
        self.assertEqual(len(result),2)
        self.assertIn('<workload>/src/other.silk:9:3: related location',result[0])
        self.assertIn('^~~\ncontinuation text',result[0])
        self.assertTrue(result[1].endswith('  note: last note'))
        self.assertNotEqual(result,diagnostic_blocks(trace.replace('9:3: related','9:4: related'),'/work/run'))
        self.assertNotEqual(result,diagnostic_blocks(trace.replace('first note','changed note'),'/work/run'))
        self.assertEqual(result,diagnostic_blocks(trace.replace('/work/run','/other/run'),'/other/run'))

    def test_orphan_note_is_not_silently_dropped(self):
        with self.assertRaises(AssertionError):diagnostic_blocks('  note: missing header')


if __name__=='__main__':unittest.main()
