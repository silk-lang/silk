p='/workspace/silk-retained-build/compiler/src/semantic/Semantic.silk';s=open(p).read()
# Graph nodes are code definitions; request/reply retains exact selected semantic provenance.
s=s.replace('''  let exact = run instanceDigest(key)
  if BuildCapture.find(&capture.*, exact)''','''  let exact = run keyDigest(key, capture.patterns)
  if BuildCapture.find(&capture.*, exact)''',1)
marker='''  effect fn artifactRoots(self: &mut Self, payload: &[u8]) -> Bytes'''
method='''  // Select one complete checked semantic representative of a provider-sensitive definition.
  // The chosen key owns both this node's MIR references and its later emitted definition.
  effect fn artifactRepresentative(self: &mut Self, definition: ContentHash) -> Option<InstanceKey>
  ! OutOfMemoryError ? &mut Allocator {
    let known = DigestSet.find(&self.frontierKeyDigests, definition)
    if known == usize.MAX { return Option<InstanceKey>.none() }
    let key = InstanceKey.copy(&List<InstanceKey>.asSlice(&self.frontierKeys)[known])
    if !ContentHash.equals(run keyDigest(&key, false), definition) { return Option<InstanceKey>.none() }
    run Semantic.rememberArtifactKey(&mut self.*, &key)
    return Option<InstanceKey>.some(move key)
  }

'''
assert marker in s;s=s.replace(marker,method+marker,1)
s=s.replace('''  // Unlike the check walk, select exactly this region pattern before following any MIR edges.''','''  // Lower the selected checked representative, then follow exactly its own MIR edges.''',1)
s=s.replace('''    let mut capture = run BuildCapture.make(self.artifactObserving, List<BuildRoot>.asSlice(&roots))
    run BuildCapture.enter''','''    let mut capture = run BuildCapture.make(self.artifactObserving, List<BuildRoot>.asSlice(&roots))
    capture.patterns = false
    List<ContentHash>.clear(&mut capture.roots)
    run List<ContentHash>.append(&mut capture.roots, run keyDigest(key, false))
    run BuildCapture.enter''',1)
s=s.replace('''      run summaryDigest(&summary, function.observes, true))''','''      run summaryDigest(&summary, function.observes, false))''',1)
s=s.replace('''      let found = run Semantic.artifactKey(&mut self.*, exact, definition)
      match move found''','''      drop exact
      let found = run Semantic.artifactRepresentative(&mut self.*, definition)
      match move found''',1)
s=s.replace('''        Option<InstanceKey>.Some {value} => {
          self.artifactObservationRequired = false''','''        Option<InstanceKey>.Some {value} => {
          let chosen = run instanceDigest(&value)
          self.artifactObservationRequired = false''',1)
s=s.replace('''              run RuntimeEncoding.word(&mut output, 1)
              let encoded = run BuildRecord.encode(&node)''','''              run RuntimeEncoding.word(&mut output, 1)
              run RuntimeEncoding.word(&mut output, chosen.high)
              run RuntimeEncoding.word(&mut output, chosen.low)
              let encoded = run BuildRecord.encode(&node)''',1)
s=s.replace('''  if run DigestSet.add(&mut seen.*, exact) {''','''  if run DigestSet.add(&mut seen.*, definition) {''',1)
s=s.replace('''      if run DigestSet.add(&mut rootSet, exact) { run List<ContentHash>.append(&mut selectedRoots, exact) }''','''      if run DigestSet.add(&mut rootSet, definition) { run List<ContentHash>.append(&mut selectedRoots, definition) }''',1)
s=s.replace('''          } else if status == 1 {
            let encoded = StableKey.readField(bytes, &mut reader)''','''          } else if status == 1 {
            let chosen = ContentHash {high: StableKey.readWord(bytes, &mut reader), low: StableKey.readWord(bytes, &mut reader)}
            let encoded = StableKey.readField(bytes, &mut reader)''',1)
s=s.replace('''if entries.length == usize.ZERO || !ContentHash.equals(entries[usize.ZERO].exact, job.exact)
                  || !value.patterns''','''if entries.length == usize.ZERO || !ContentHash.equals(entries[usize.ZERO].exact, job.definition)
                  || !ContentHash.equals(entries[usize.ZERO].facts.definition, job.definition) || value.patterns''',1)
s=s.replace('''                  changed[positions[at]].done = true
                  let references''','''                  changed[positions[at]].done = true
                  changed[positions[at]].exact = chosen
                  let references''',1)
s=s.replace('''if run DigestSet.add(&mut rootSet, target.exact) { run List<ContentHash>.append(&mut selectedRoots, target.exact) }''','''if run DigestSet.add(&mut rootSet, target.definition) { run List<ContentHash>.append(&mut selectedRoots, target.definition) }''',1)
s=s.replace('''List<ContentHash>.asSlice(&selectedRoots), self.artifactObserving)''','''List<ContentHash>.asSlice(&selectedRoots), self.artifactObserving, false)''',1)
open(p,'w').write(s)
