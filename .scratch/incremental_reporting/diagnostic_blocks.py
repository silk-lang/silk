"""Capture complete human diagnostic blocks, not only their first lines.

Report.text emits a located severity header followed by ordered notes/related
locations. Human rendering has line/column positions but omits byte-span ends;
this parser cannot replace the separate full-JSON correctness gates.
"""
import re

HEADER = re.compile(r'^.+:(?:\d+|\?):(?:\d+|\?): (?:warning|error|unsupported|internal)\[[^\]]+\]')
BOUNDARY = re.compile(r'^(?:frontier(?: |$)|(?:Compiling|Checking|Finished|Building|Linking)(?: |$)|\[[^\]]+\]$|  (?:load|check|codegen|borrow|link)\s|  (?:Semantic work|Slowest modules|Slowest bodies))')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def diagnostic_blocks(trace, root=None):
    blocks=[];current=[]
    def finish():
        while current and not current[-1].strip():current.pop()
        if current:blocks.append('\n'.join(current))
        current.clear()
    for raw in trace.splitlines():
        line=ANSI.sub('',raw)
        if root is not None:line=line.replace(str(root).rstrip('/')+'/', '<workload>/')
        if HEADER.match(line):
            finish();current.append(line)
        elif BOUNDARY.match(line):
            finish()
        elif current:
            # Preserve all rendered continuation text, including notes, related
            # locations, multiline excerpts/carets if the renderer adds them.
            current.append(line)
        elif line.startswith('  note:'):
            raise AssertionError('Orphan diagnostic note: capture boundary is incomplete')
    finish()
    return blocks
