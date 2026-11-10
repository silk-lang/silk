from pathlib import Path
p=Path('compiler/src/semantic/InternIndex.silk');s=p.read_text();needle='''    let entry = List<u64>.length(&self.hashes)

    // All allocations precede publication: a failed record must leave ordinal chains intact.''';start=s.index(needle);stop=s.index('    run List<u64>.append(&mut self.hashes, hash)',start)
prepare=s[start:stop].replace('      width = grown\n','')
s=s[:start]+'''    run InternIndex.reserveNext(&mut self.*)
    let entry = List<u64>.length(&self.hashes)
    let width = List<u32>.length(&self.heads)
'''+s[stop:]
pos=s.rfind('\n}')
s=s[:pos]+'''
  /// Reserves the next entry's storage without publishing an ordinal or changing any chain.
  /// A following `record` needs no allocation unless another entry is recorded first.
  pub effect fn reserveNext(self: &mut Self) -> () ! OutOfMemoryError ? &mut Allocator {
'''+prepare+'''  }
  /// Removes newer ordinals and relinks the retained entries in existing storage. Allocates nothing.
  pub fn truncate(self: &mut Self, length: usize) -> () {
    if length >= List<u64>.length(&self.hashes) { return () }
    List<u64>.truncate(&mut self.hashes, length)
    List<u32>.truncate(&mut self.successors, length)
    let width = List<u32>.length(&self.heads)
    let mut at = usize.ZERO
    while at < width {
      List<u32>.set(&mut self.heads, at, 0)
      List<u32>.set(&mut self.tails, at, 0)
      at = at + usize.ONE
    }
    at = usize.ZERO
    while at < length {
      List<u32>.set(&mut self.successors, at, u32.MAX)
      link(&mut self.*, at, width)
      at = at + usize.ONE
    }
  }
'''+s[pos:];p.write_text(s)
p=Path('compiler/src/semantic/FiniteBudget.silk');s=p.read_text();s=s.replace('pub effect fn rollback(self: &mut Self, saved: Checkpoint) -> () ! OutOfMemoryError ? &mut Allocator', 'pub fn rollback(self: &mut Self, saved: Checkpoint) -> ()')
start=s.index('    // A successful replay never rebuilds indexes.')
stop=s.index('\n  fn refuse(',start)
s=s[:start]+'''    // A successful replay never relinks indexes; abandoned extensions reuse their existing storage.
    if rebuildDefinitions { InternIndex.truncate(&mut self.definitionLookup, saved.definitions) }
    if rebuildBodies { InternIndex.truncate(&mut self.bodyLookup, saved.bodies) }
  }
'''+s[stop:]
# Find identity before mutations, reserve every storage layer, then publish atomically.
start=s.index('      if selectedBody == usize.MAX {\n        selectedBody = declared.length')
stop=s.index('    run List<Definition>.append(&mut self.definitions',start)
s=s[:start]+'''    }
    run List<Definition>.reserve(&mut self.definitions, usize.ONE)
    run InternIndex.reserveNext(&mut self.definitionLookup)
    if let Option<&DeclarationId>.Some {value} = &body {
      if selectedBody == usize.MAX {
        run List<DeclarationId>.reserve(&mut self.bodies, usize.ONE)
        run List<usize>.reserve(&mut self.bodyCounts, usize.ONE)
        run InternIndex.reserveNext(&mut self.bodyLookup)
      }
      // All allocations completed before any body count or ordinal is published.
      if selectedBody == usize.MAX {
        selectedBody = List<DeclarationId>.length(&self.bodies)
        run List<DeclarationId>.append(&mut self.bodies, DeclarationId.copy(value))
        run List<usize>.append(&mut self.bodyCounts, usize.ZERO)
        run InternIndex.record(&mut self.bodyLookup, DeclarationId.hash(value))
      }
      let count = List<usize>.get(&self.bodyCounts, selectedBody)
      List<usize>.set(&mut self.bodyCounts, selectedBody, count + usize.ONE)
    }
'''+s[stop:]
s=s.replace('run Budget.rollback(', 'Budget.rollback(')
p.write_text(s)
for name in ['Semantic','WalkFragments']:
 p=Path('compiler/src/semantic')/(name+'.silk');s=p.read_text().replace('run SpecializationBudget.rollback(', 'SpecializationBudget.rollback(').replace('run Budget.rollback(', 'Budget.rollback(');p.write_text(s)
