from pathlib import Path
p=Path('/workspace/silk/.scratch/parallel-check-experiment/compiler/src/semantic/Semantic.silk');s=p.read_text()
s=s.replace('''  effect fn serveFrontier(self: &mut Self) -> () ! OutOfMemoryError ? &mut Allocator | &mut Types {''','''  effect fn serveFrontier(self: &mut Self, context: &mut Request) -> () ! OutOfMemoryError ? &mut Allocator | &mut Types {''',1)
s=s.replace('''      if command[0] != 1 { return () }''','''      if command[0] != 1 && command[0] != 2 { return () }''',1)
needle='''      let mut request = run Bytes.zeroed(u64.toUsize(count) * 32)'''
replacement='''      if command[0] == 2 {
        let mut input = run Bytes.zeroed(u64.toUsize(count) * 16)
        if !frontierRead(self.frontierControl, Bytes.asMutSlice(&mut input)) { return () }
        let mut fields = StableKey.reader()
        let mut requested = List<ContentHash>.make()
        let mut at = usize.ZERO
        while at < u64.toUsize(count) {
          let key = ContentHash {high: StableKey.readWord(Bytes.asSlice(&input), &mut fields), low: StableKey.readWord(Bytes.asSlice(&input), &mut fields)}
          run List<ContentHash>.append(&mut requested, key)
          at = at + usize.ONE
        }
        let extended = run Effect.result(Semantic.frontierExtend(&mut self.*, &mut context.*, List<ContentHash>.asSlice(&requested)))
        let record = match move extended {
          Result<Option<BuildRecord.Record>, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} => move value
          Result<Option<BuildRecord.Record>, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Failure {error} => { drop move error Option<BuildRecord.Record>.none() }
        }
        if let Option<BuildRecord.Record>.Some {value} = move record {
          let encoded = run BuildRecord.encode(&value)
          let mut header = run Bytes.copy(&[1])
          run RuntimeEncoding.word(&mut header, usize.toU64(Bytes.length(&encoded)))
          if !frontierSend(self.frontierControl, Bytes.asSlice(&header)) || !frontierSend(self.frontierControl, Bytes.asSlice(&encoded)) { return () }
        } else { if !frontierSend(self.frontierControl, &[0]) { return () } }
        continue
      }
      let mut request = run Bytes.zeroed(u64.toUsize(count) * 32)'''
assert needle in s;s=s.replace(needle,replacement,1)
s=s.replace('run Semantic.serveFrontier(&mut self.*)','run Semantic.serveFrontier(&mut self.*, &mut request.*)',1)
pos=s.index('  effect fn serveFrontier(')
method='''  effect fn frontierExtend(self: &mut Self, request: &mut Request, keys: &[ContentHash]) -> Option<BuildRecord.Record>
  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError ? &mut Allocator | &mut Types {
    let mut roots = List<InstanceKey>.make()
    let known = List<InstanceKey>.asSlice(&self.frontierKeys)
    let mut at = usize.ZERO
    while at < keys.length {
      let found = DigestSet.find(&self.frontierKeyDigests, keys[at])
      if found != usize.MAX { run List<InstanceKey>.append(&mut roots, InstanceKey.copy(&known[found])) }
      at = at + usize.ONE
    }
    run frontierTrace(b"extension roots", self.frontierSplit, self.frontierWorker, List<InstanceKey>.length(&roots))
    let mut capture = BuildCapture.walk()
    let result = run Semantic.capturedEscapes(&mut self.*, &mut request.*, &[], List<InstanceKey>.asSlice(&roots),
      &Option<WalkBoundary>.none(), &mut capture, self.frontierUnit)
    if List<Shared<Rejection>>.length(&result.rejections) != usize.ZERO || List<Shared<BackendGap>>.length(&result.gaps) != usize.ZERO
      || List<UncheckedDeclaration>.length(&result.unchecked) != usize.ZERO || capture.unreplayable { return Option<BuildRecord.Record>.none() }
    let built = run BuildCapture.finish(move capture, usize.MAX)
    return match move built {
      Option<CapturedBuild>.Some {value} => Option<BuildRecord.Record>.some(move value.record)
      Option<CapturedBuild>.None => Option<BuildRecord.Record>.none()
    }
  }

'''
s=s[:pos]+method+s[pos:]
# Existing authored root paths supply no extra exact keys.
s=s.replace('Semantic.capturedEscapes(&mut self.*, &mut request.*, concrete, &boundary,','Semantic.capturedEscapes(&mut self.*, &mut request.*, concrete, &[], &boundary,',1)
s=s.replace('Semantic.capturedEscapes(&mut self.*, &mut request.*, declarations, boundary,','Semantic.capturedEscapes(&mut self.*, &mut request.*, declarations, &[], boundary,',1)
pos=s.index('  effect fn capturedEscapes(')
s=s[:pos]+s[pos:].replace('''    declarations: &[DeclarationId],
    boundary:''','''    declarations: &[DeclarationId],
    extraRoots: &[InstanceKey],
    boundary:''',1)
pos=s.index('    // Whether the walk already looked for local-shared escapes',pos)
seed='''    at = usize.ZERO
    while at < extraRoots.length {
      let key = &extraRoots[at]
      let declaration = DeclarationId.copyShared(&InstanceKey.identity(key))
      run List<VisitOrigin>.append(&mut origins, VisitOrigin {parent: usize.MAX, position: List<ContentHash>.length(&capture.roots), requested: false})
      run List<ContentHash>.append(&mut capture.roots, run keyDigest(key, capture.patterns))
      run List<BackendVisit>.append(&mut pending, BackendVisit.Enter {key: InstanceKey.copy(key), edge: Edge.Direct,
        span: Span.make(usize.ZERO, usize.ZERO), module: ModuleId.copy(DeclarationId.moduleId(&declaration)),
        cleanup: Option<Interned<Type>>.none(), requester: Option<RelatedSite>.none()})
      at = at + usize.ONE
    }
'''
s=s[:pos]+seed+s[pos:]
p.write_text(s)
