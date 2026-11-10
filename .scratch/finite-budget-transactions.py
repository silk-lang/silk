from pathlib import Path
p=Path('compiler/src/semantic/FiniteBudget.silk');s=p.read_text()
pos=s.index('pub struct Budget {')
s=s[:pos]+'''// Only maxima changed on existing definitions need an undo entry. Newly appended definitions
// and bodies are removed by their saved lengths when a speculative walk is abandoned.
struct Update {definition: usize, bytes: usize, references: usize}

/// A nested speculative accounting boundary. Commit only a replay that proves the current graph.
pub struct Checkpoint {
  definitions: usize, bodies: usize, updates: usize, references: usize, bytes: usize,
  failed: bool, failure: usize, depth: usize,
}

'''+s[pos:]
s=s.replace('  failed: bool,\n  failure: usize,','  failed: bool,\n  failure: usize,\n  updates: List<Update>,\n  depth: usize,')
s=s.replace('failed: false, failure: usize.ZERO}', 'failed: false, failure: usize.ZERO, updates: List<Update>.make(), depth: usize.ZERO}')
pos=s.index('  fn refuse(')
s=s[:pos]+'''  /// Begins accounting that may be discarded without copying the already accepted graph.
  pub fn checkpoint(self: &mut Self) -> Checkpoint {
    let saved = Checkpoint {definitions: List<Definition>.length(&self.definitions), bodies: List<DeclarationId>.length(&self.bodies),
      updates: List<Update>.length(&self.updates), references: self.references, bytes: self.bytes,
      failed: self.failed, failure: self.failure, depth: self.depth}
    self.depth = self.depth + usize.ONE
    return saved
  }
  /// Keeps the observations of a completed replay. An outer transaction can still undo them.
  pub fn commit(self: &mut Self, saved: Checkpoint) -> () {
    self.depth = saved.depth
    if self.depth == usize.ZERO { List<Update>.clear(&mut self.updates) }
  }
  /// Discards observations of an unproved replay so the live walk retains its own refusal site.
  pub effect fn rollback(self: &mut Self, saved: Checkpoint) -> () ! OutOfMemoryError ? &mut Allocator {
    while List<Update>.length(&self.updates) > saved.updates {
      let update = List<Update>.remove(&mut self.updates, List<Update>.length(&self.updates) - usize.ONE)
      let entries = List<Definition>.asMutSlice(&mut self.definitions)
      entries[update.definition].bytes = update.bytes
      entries[update.definition].references = update.references
    }
    let rebuildDefinitions = List<Definition>.length(&self.definitions) != saved.definitions
    let rebuildBodies = List<DeclarationId>.length(&self.bodies) != saved.bodies
    while List<Definition>.length(&self.definitions) > saved.definitions {
      let removed = List<Definition>.remove(&mut self.definitions, List<Definition>.length(&self.definitions) - usize.ONE)
      if removed.body != usize.MAX {
        List<usize>.set(&mut self.bodyCounts, removed.body, List<usize>.get(&self.bodyCounts, removed.body) - usize.ONE)
      }
    }
    List<DeclarationId>.truncate(&mut self.bodies, saved.bodies)
    List<usize>.truncate(&mut self.bodyCounts, saved.bodies)
    self.references = saved.references
    self.bytes = saved.bytes
    self.failed = saved.failed
    self.failure = saved.failure
    self.depth = saved.depth
    // A successful replay never rebuilds indexes. Only an abandoned extension needs relinking.
    if rebuildDefinitions {
      self.definitionLookup = InternIndex.make()
      let entries = List<Definition>.asSlice(&self.definitions)
      let mut at = usize.ZERO
      while at < entries.length {
        run InternIndex.record(&mut self.definitionLookup, Hash.combine(entries[at].key.high, entries[at].key.low))
        at = at + usize.ONE
      }
    }
    if rebuildBodies {
      self.bodyLookup = InternIndex.make()
      let bodies = List<DeclarationId>.asSlice(&self.bodies)
      let mut at = usize.ZERO
      while at < bodies.length {
        run InternIndex.record(&mut self.bodyLookup, DeclarationId.hash(&bodies[at]))
        at = at + usize.ONE
      }
    }
  }
'''+s[pos:]
s=s.replace('      self.bytes = self.bytes + extraBytes','''      if self.depth != usize.ZERO && (extraBytes != usize.ZERO || extraReferences != usize.ZERO) {
        run List<Update>.append(&mut self.updates, Update {definition: known, bytes: previous.bytes, references: previous.references})
      }
      self.bytes = self.bytes + extraBytes''')
p.write_text(s)
