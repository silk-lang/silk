from pathlib import Path
p=Path('/workspace/silk/.scratch/parallel-check-experiment/compiler/src/semantic/Semantic.silk');s=p.read_text()
pos=s.index('  effect fn frontierAdmissions(')
method='''  effect fn frontierComplete(self: &Self, record: &mut BuildRecord.Record, fragments: &mut List<BuildRecord.Record>, workers: &[CheckWorker]) -> bool
  ! OutOfMemoryError ? &mut Allocator {
    let mut round = usize.ZERO
    while round < 128 {
      let missing = run WalkFragments.missingBodies(&record.*)
      let keys = List<ContentHash>.asSlice(&missing)
      run frontierTrace(b"missing bodies", self.frontierSplit, round, keys.length)
      if keys.length == usize.ZERO { return WalkFragments.finiteClosed(&record.*) }
      if List<BuildRecord.Entry>.length(&record.entries) > 500000 { return false }
      let before = frontierFullEntries(&record.*)
      let mut request = run Bytes.copy(&[2])
      run RuntimeEncoding.word(&mut request, usize.toU64(keys.length))
      let mut at = usize.ZERO
      while at < keys.length {
        run RuntimeEncoding.word(&mut request, keys[at].high)
        run RuntimeEncoding.word(&mut request, keys[at].low)
        at = at + usize.ONE
      }
      let mut shard = usize.ZERO
      while shard < workers.length {
        if !frontierSend(workers[shard].control, Bytes.asSlice(&request)) { return false }
        shard = shard + usize.ONE
      }
      shard = usize.ZERO
      while shard < workers.length {
        let mut status: [u8; 1] = [0]
        if !frontierRead(workers[shard].control, &mut status) || status[0] != 1 { return false }
        let mut header: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 0]
        if !frontierRead(workers[shard].control, &mut header) { return false }
        let mut fields = StableKey.reader()
        let length = StableKey.readWord(&header, &mut fields)
        if length > 536870912 { return false }
        let mut encoded = run Bytes.zeroed(u64.toUsize(length))
        if !frontierRead(workers[shard].control, Bytes.asMutSlice(&mut encoded)) { return false }
        let fragment = match move run BuildRecord.decode(Bytes.asSlice(&encoded)) {
          Option<BuildRecord.Record>.Some {value} => move value
          Option<BuildRecord.Record>.None => { return false }
        }
        run frontierTrace(b"extension fragment", self.frontierSplit, shard, List<BuildRecord.Entry>.length(&fragment.entries))
        run List<BuildRecord.Record>.append(&mut fragments.*, move fragment)
        shard = shard + usize.ONE
      }
      let merged = match move run WalkFragments.mergeOpen(List<BuildRecord.Record>.asSlice(&fragments.*)) {
        Option<BuildRecord.Record>.Some {value} => move value
        Option<BuildRecord.Record>.None => { return false }
      }
      let completed = frontierFullEntries(&merged)
      run frontierTrace(b"extended graph", self.frontierSplit, completed, List<BuildRecord.Entry>.length(&merged.entries))
      record.* = move merged
      if completed <= before { return false }
      round = round + usize.ONE
    }
    return false
  }

'''
s=s[:pos]+method+s[pos:]
pos=s.index('struct CheckWorker {')
helper='''fn frontierFullEntries(record: &BuildRecord.Record) -> usize {
  let entries = List<BuildRecord.Entry>.asSlice(&record.entries)
  let mut count = usize.ZERO
  let mut at = usize.ZERO
  while at < entries.length {
    if entries[at].leaf == 0 { count = count + usize.ONE }
    at = at + usize.ONE
  }
  return count
}

'''
s=s[:pos]+helper+s[pos:]
a=s.index('  effect fn joinFrontier(');b=s.index('\n  effect fn ',a+10);section=s[a:b]
section=section.replace('WalkFragments.merge(List<BuildRecord.Record>.asSlice(&records))','WalkFragments.mergeOpen(List<BuildRecord.Record>.asSlice(&records))',1)
needle='''    if let Option<BuildRecord.Record>.Some {value} = move combined {
      if sharedFrontier() && !(run Semantic.frontierAdmissions(&self.*, &value, List<BuildRecord.Record>.asSlice(&records), List<WalkFragments.Boundary>.asSlice(&boundaries), workers)) {
        drop unsafe write(2, Pointer.fromSlice<u8>(b"frontier admission proof refused\\n"), 33)
        return false
      }'''
replacement='''    if let Option<BuildRecord.Record>.Some {value: initial} = move combined {
      let mut value = move initial
      if !(run Semantic.frontierComplete(&self.*, &mut value, &mut records, workers)) {
        run frontierTrace(b"finite graph proof refused", self.frontierSplit, usize.ZERO, usize.ZERO)
        return false
      }'''
assert needle in section;section=section.replace(needle,replacement,1)
s=s[:a]+section+s[b:]
needle='''      facts.application = run Admission.applicationIdentity(&application)
      facts.flags = u64.bitOr(facts.flags, BuildRecord.FACT_RUNTIME_APPLICATION)'''
replacement=needle+'''
      if Admission.closed(&application) { facts.flags = u64.bitOr(facts.flags, WalkFragments.FACT_CLOSED) }'''
assert needle in s;s=s.replace(needle,replacement,1)
p.write_text(s)
