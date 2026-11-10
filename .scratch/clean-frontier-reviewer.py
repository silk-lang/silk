from pathlib import Path
import sys,re
sys.path.insert(0,'/workspace/silk/.scratch');from silk_edit_helpers import extract,remove
p=Path('compiler/src/semantic/WalkFragments.silk');s=p.read_text()
# Preserve all finite/escape tests, excising assertions about the removed heuristic.
fragment=extract(s,r'^effect fn fragmentClaims\(')
a=fragment.index('    let applications =');b=fragment.index('    run Testing.expect(run escapeFree',a);fragment=fragment[:a]+fragment[b:]
final=extract(s,r'^effect fn finalCalleeClaims\(')
finite=extract(s,r'^effect fn finiteClosureClaims\(').replace('run witnessExample(&[10, 10], &[10, 20])','run finiteExample(2)').replace('run witnessExample(&[10], &[10])','run finiteExample(1)')
finite=re.sub(r'^  run Testing.expect\(!run admissionFree[^\n]+\n','',finite,flags=re.M)
examples=extract(s,r'^fn exampleKey\(')+'\n\n'+extract(s,r'^effect fn exampleEntry\(')
finiteExample='''effect fn finiteExample(count: usize) -> BuildRecord.Record ! OutOfMemoryError ? &mut Allocator {
  let mut record = BuildRecord.make(false, false)
  run List<ContentHash>.append(&mut record.roots, exampleKey(1))
  let mut at = usize.ZERO
  while at < count {
    let mut entry = run exampleEntry(usize.toU64(at + usize.ONE), 0, &[])
    entry.facts.flags = u64.bitOr(entry.facts.flags, BuildRecord.FACT_APPLICATION)
    if at + usize.ONE < count {
      run List<BuildRecord.Reference>.append(&mut entry.references, BuildRecord.Reference {target: at + usize.ONE, edge: exampleKey(0)})
      run List<usize>.append(&mut entry.facts.callees, 0)
    }
    run List<BuildRecord.Entry>.append(&mut record.entries, move entry)
    at = at + usize.ONE
  }
  return move record
}'''
closure='''effect fn closureBodyClaims() -> () ! OutOfMemoryError | AssertionError<'static> ? &mut Allocator {
  let mut original = BuildRecord.make(false, false)
  run List<ContentHash>.append(&mut original.roots, exampleKey(1))
  run List<BuildRecord.Entry>.append(&mut original.entries, run exampleEntry(1, 0, &[1, 1]))
  run List<BuildRecord.Entry>.append(&mut original.entries, run exampleEntry(2, BuildRecord.LEFT, &[]))
  let missing = run missingBodies(&original)
  run Testing.expect(List<ContentHash>.length(&missing) == 1
    && ContentHash.equals(List<ContentHash>.get(&missing, 0), exampleKey(2)),
    "repeated references to an omitted body produce one closure request")
  run Testing.expect(!run finiteClosed(&original), "an omitted body is not a complete finite graph")
  let mut extension = BuildRecord.make(false, false)
  run List<ContentHash>.append(&mut extension.roots, exampleKey(2))
  run List<BuildRecord.Entry>.append(&mut extension.entries, run exampleEntry(2, 0, &[1]))
  run List<BuildRecord.Entry>.append(&mut extension.entries, run exampleEntry(3, 0, &[]))
  let mut fragments = List<BuildRecord.Record>.make()
  run List<BuildRecord.Record>.append(&mut fragments, move original)
  run List<BuildRecord.Record>.append(&mut fragments, move extension)
  if let Option<BuildRecord.Record>.Some {value: joined} = move run merge(List<BuildRecord.Record>.asSlice(&fragments)) {
    let remaining = run missingBodies(&joined)
    run Testing.expect(List<ContentHash>.length(&remaining) == 0 && (run finiteClosed(&joined)),
      "a checked extension resolves the omitted body and its reachable successors")
  } else { run Testing.expect(false, "the extension resolves the previously omitted body") }
}'''
# Actual graph implementation preceding tests.
s=s[:s.index('fn exampleKey(')]
a=s.index('/// This external target');b=s.index('/// A malformed capture',a);s=s[:a]+s[b:]
a=s.index('/// An exact pair');b=s.index('struct Source',a);s=s[:a]+s[b:]
s=re.sub(r'^struct Admission(?:Visit|Frame)[^\n]+\n','',s,flags=re.M)
a=s.index('/// Proves every admission edge');b=s.index('/// Proves that no access callback',a);s=s[:a]+s[b:]
a=s.index('    let witnessed = List<usize>.asSlice(&entry.facts.witnesses)');b=s.index('    at = at + usize.ONE',a);s=s[:a]+s[b:]
s=s.replace('//! Scratch composition of independently checked escape-walk frontiers.','//! Composes independently checked worker fragments into a complete finite graph.').replace('import silk.num.isize\n','')
s+='\n\n'.join([examples,fragment,final,finiteExample,closure,finite])+'\n\n'
for test,body,extra in [('frontierFiniteGraphsRetainClosureAndSemanticObligations','finiteClosureClaims','InvalidModulePath | '),('frontierGraphExtensionRequiresCompleteBodies','closureBodyClaims',''),('frontierFragmentsRemapCyclesAndFindCrossWorkerEscapes','fragmentClaims','')]:
 s+=f"test effect fn {test}() -> () ! {extra}OutOfMemoryError | AssertionError<'static> {{\n  let mut allocator = Allocator.systemAllocatorProvider()\n  run {body}() |> Effect.provideMut<Allocator>(&mut allocator)\n"
 if body=='fragmentClaims':s+='  run finalCalleeClaims() |> Effect.provideMut<Allocator>(&mut allocator)\n'
 s+='}\n\n'
p.write_text(s)
p=Path('compiler/src/semantic/Semantic.silk');s=p.read_text();s=re.sub(r'^\s*BuildCapture.flag\(&mut capture\.\*, reached, WalkFragments.ADMITTED\)\n','\n',s,flags=re.M)
s=re.sub(r'^\s*if admittedApplication \{\n\s*BuildCapture.flag\(&mut capture\.\*, (?:reached|entry), if leave \{ WalkFragments.ENTERED \} else \{ WalkFragments.REUSED \}\)\n\s*\}\n','\n',s,flags=re.M)
s=re.sub(r'^\s*let mut admittedApplication = false\n|^\s*admittedApplication = true\n','\n',s,flags=re.M);p.write_text(s)
