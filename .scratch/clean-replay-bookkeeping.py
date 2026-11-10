import sys,re
from pathlib import Path
sys.path.insert(0,'/workspace/silk/.scratch')
from silk_edit_helpers import item_span
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/Semantic.silk');s=p.read_text()
def delete(pattern):
 global s
 a,b=item_span(s,pattern)
 while a>0:
  line=s.rfind('\n',0,a-1)+1
  if s[line:a].lstrip().startswith('//'):a=line
  else:break
 s=s[:a]+s[b:]
# Read-only path matching existed solely to reuse old ancestry decisions.
a=s.index('      let mut same = false\n',s.index('  effect fn rewalkBuild('));b=s.index('      run List<RewalkVisit>.append',a);s=s[:a]+s[b:]
a=s.index('            let kept = onPath');b=s.index('            run List<RewalkVisit>.append',a);s=s[:a]+s[b:]
a=s.index('          // The record\'s walk decided this edge');b=s.index('          run List<RewalkVisit>.append',a);s=s[:a]+s[b:]
a=s.index('              let mut kept = false\n',s.index('  effect fn rewalkBuild('));b=s.index('              run List<RewalkVisit>.append',a);s=s[:a]+s[b:]
# Preserve structural validation previously performed while constructing path hashes.
a=s.index('    // The admission path each entered entry\'s references');b=s.index('    let mut started = List<ContentHash>.make()',a)
s=s[:a]+'''    at = usize.ZERO
    while at < entries.length {
      let parent = entries[at].parent
      if entries[at].leaf == 0 && parent != usize.MAX {
        if parent >= at || entries[at].position >= List<BuildRecord.Reference>.length(&entries[parent].references) {
          return Option<EscapeReplay>.none()
        }
      }
      at = at + usize.ONE
    }
    // Roots retain their original order and must still lower without diagnostics.
    let recordedRoots = List<ContentHash>.asSlice(&record.roots)
'''+s[b:]
a=s.index('      // The path and cleanup root this body\'s references');b=s.index('      run InternIndex.record(&mut visitedLookup',a)
s=s[:a]+'      let node = List<EscapeNode>.length(&nodes)\n'+s[b:]
# No replay enters admission frames now.
for name in ['rewalkBuild','rewalkEscapes']:
 a,b=item_span(s,r'^  effect fn '+name+r'\(');part=s[a:b]
 part=re.sub(r'\btrusted: _trusted, same: onPath','',part)
 part=part.replace('leave, ','').replace(', path, cleanup, cleanupNode, edge','')
 part=re.sub(r'\s*if leave \{\s*continue\s*\}','',part)
 part=re.sub(r'\b(?:leave|trusted|same|path|cleanup|cleanupNode|edge): (?:false|same|onPath|kept|decided|none|rootEdge|path|cleanup|cleanupNode|edge|pathOut|cleanupOut|cleanupOutNode|usize\.MAX|references\[reference\]\.edge|List<ContentHash>\.asSlice\(&edges\)\[reference\])(?=[,}]),?\s*','',part)
 part=part.replace('requested: asked, }','requested: asked}')
 # The regex intentionally applies only to simple provenance field values, never edges lists/digests.
 s=s[:a]+part+s[b:]
# Remove provenance fields from their two pending-visit types and the stored escape node.
for name,fields in [('RewalkVisit',['leave','trusted','same']),('EscapeVisit',['leave','path','cleanup','cleanupNode','edge']),('EscapeNode',['cleanupNode'])]:
 a,b=item_span(s,r'^struct '+name+r'\b');part=s[a:b]
 for f in fields:part=re.sub(r'(?:  //[^\n]*\n)*  '+f+r': [^\n]+\n','',part)
 s=s[:a]+part+s[b:]
s=s.replace('      visit.path = ContentHash {high: 0, low: 0}\n','')
s=s.replace('    let mut visit = match move List<EscapeVisit>.pop(&mut reversed)', '    let visit = match move List<EscapeVisit>.pop(&mut reversed)')
for name in ['escapeEdge','escapePath','escapeCleanup','escapeDecision','streamDigest']:
 delete(r'^fn '+name+r'\(')
s=re.sub(r'// How the record\'s walk decided one edge:[\s\S]*?const ESCAPE_UNKNOWN: u64 = 2\n','',s)
s=s.replace('import semantic.ContentHash {ContentHash, Stream}','import semantic.ContentHash {ContentHash}')
s=s.replace('// entered it, if any; and what admission decides it from: the admission path (`escapePath`), the\n// cleanup root it inherits (`escapeCleanup`), and the digest of the edge that reaches it.','// entered it, if any, and the parent reference used to reconstruct a missing key.')
s=s.replace('// bodies callbacks reach that the walk left, each to be entered from no admission path, with the\n// cleanup root it was left with.','// bodies callbacks reach that the bounded walk left.')
s=re.sub(r'\n{3,}','\n\n',s)
p.write_text(s)
