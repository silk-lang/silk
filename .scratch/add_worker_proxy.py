from pathlib import Path
p=Path('/workspace/silk/.scratch/worker-forks/compiler/src/semantic/Semantic.silk');s=p.read_text()
s=s.replace('CompareExchange<u64>.Exchanged {..}', 'CompareExchange<u64>.Exchanged').replace('CompareExchange<u64>.Unchanged {value}', 'CompareExchange<u64>.Observed {value}')
s=s.replace(r'SILK_FRONTIER_FORK_PRIVATE\\0',r'SILK_FRONTIER_FORK_PRIVATE\0')
needle='  effect fn serveFrontier(self: &mut Self, context: &mut Request)'
insert='''  // The original worker remains the addressable owner of its descendant. Every extension
  // request reaches both retained stores; exact digest closure still decides what can be used.
  effect fn frontierExtendChildren(self: &mut Self, context: &mut Request, keys: &[ContentHash]) -> Option<BuildRecord.Record>
  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError ? &mut Allocator | &mut Types {
    let mut command = run Bytes.copy(&[2])
    run RuntimeEncoding.word(&mut command, usize.toU64(keys.length))
    let mut at = usize.ZERO
    while at < keys.length {
      run RuntimeEncoding.word(&mut command, keys[at].high)
      run RuntimeEncoding.word(&mut command, keys[at].low)
      at = at + usize.ONE
    }
    let children = List<CheckWorker>.asSlice(&self.frontierChildren)
    at = usize.ZERO
    while at < children.length {
      if !frontierSend(children[at].control, Bytes.asSlice(&command)) { return Option<BuildRecord.Record>.none() }
      at = at + usize.ONE
    }
    if let Option<[*]mut u64>.Some {value: control} = &self.frontierForkControl {
      if !acquireFrontierLease(control, false) { return Option<BuildRecord.Record>.none() }
    }
    let attempted = run Effect.result(Semantic.frontierExtend(&mut self.*, &mut context.*, keys))
    if let Option<[*]mut u64>.Some {value: control} = &self.frontierForkControl { releaseFrontierLease(control) }
    let own = match move attempted {
      Result<Option<BuildRecord.Record>, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} => move value
      Result<Option<BuildRecord.Record>, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Failure {error} => { fail move error }
    }
    let mut records = List<BuildRecord.Record>.make()
    if let Option<BuildRecord.Record>.Some {value} = move own { run List<BuildRecord.Record>.append(&mut records, move value) }
    else { return Option<BuildRecord.Record>.none() }
    let held = List<CheckWorker>.asSlice(&self.frontierChildren)
    at = usize.ZERO
    while at < held.length {
      let mut status: [u8; 1] = [0]
      if !frontierRead(held[at].control, &mut status) || status[0] != 1 { return Option<BuildRecord.Record>.none() }
      let mut header: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 0]
      if !frontierRead(held[at].control, &mut header) { return Option<BuildRecord.Record>.none() }
      let mut fields = StableKey.reader()
      let length = StableKey.readWord(&header, &mut fields)
      if length > 536870912 { return Option<BuildRecord.Record>.none() }
      let mut encoded = run Bytes.zeroed(u64.toUsize(length))
      if !frontierRead(held[at].control, Bytes.asMutSlice(&mut encoded)) { return Option<BuildRecord.Record>.none() }
      let record = match move run BuildRecord.decode(Bytes.asSlice(&encoded)) {
        Option<BuildRecord.Record>.Some {value} => move value
        Option<BuildRecord.Record>.None => { return Option<BuildRecord.Record>.none() }
      }
      run List<BuildRecord.Record>.append(&mut records, move record)
      at = at + usize.ONE
    }
    return run WalkFragments.mergeOpen(List<BuildRecord.Record>.asSlice(&records))
  }

'''
s=s.replace(needle,insert+needle)
s=s.replace('Semantic.frontierExtend(&mut self.*, &mut context.*, List<ContentHash>.asSlice(&requested))','Semantic.frontierExtendChildren(&mut self.*, &mut context.*, List<ContentHash>.asSlice(&requested))')
p.write_text(s)
