from pathlib import Path
p=Path('/workspace/silk/.scratch/frontier-demanded-closure/compiler/src/semantic/Semantic.silk');s=p.read_text()
def put(a,b):
 global s
 assert s.count(a)==1,(a[:100],s.count(a));s=s.replace(a,b)
put('fn completeModuleFrontier() -> bool {','''fn demandedClosureFrontier() -> bool {
  return !Pointer.isNullMany<u8>(unsafe FrontierHost.environment(Pointer.fromSlice<u8>(b"SILK_FRONTIER_DEMANDED_CLOSURE\\0")))
}

fn completeModuleFrontier() -> bool {''')
put('  frontierKeyDigests: DigestSet,','''  frontierKeyDigests: DigestSet,
  frontierClosureQueue: List<ContentHash>,
  frontierClosureSeen: DigestSet,
  frontierClosureHead: usize,
  frontierClosureRecords: List<BuildRecord.Record>,''')
put('    frontierKeyDigests: DigestSet.make(),','''    frontierKeyDigests: DigestSet.make(),
    frontierClosureQueue: List<ContentHash>.make(),
    frontierClosureSeen: DigestSet.make(),
    frontierClosureHead: usize.ZERO,
    frontierClosureRecords: List<BuildRecord.Record>.make(),''')
put('    self.frontierExtensionReads = List<usize>.make()','''    self.frontierExtensionReads = List<usize>.make()
    self.frontierClosureQueue = List<ContentHash>.make()
    self.frontierClosureSeen = DigestSet.make()
    self.frontierClosureHead = usize.ZERO
    self.frontierClosureRecords = List<BuildRecord.Record>.make()''')
# Only closed capture records feed tickets. No imported memos or arbitrary module declarations.
needle='  effect fn frontierExtend(self: &mut Self, request: &mut Request, keys: &[ContentHash]) -> Option<BuildRecord.Record>'
put(needle,'''  effect fn queueFrontierClosureMemo(self: &mut Self, unit: usize) -> () ! OutOfMemoryError ? &mut Allocator {
    if !demandedClosureFrontier() || self.frontierWorker == usize.MAX || self.resolver.revisable { return () }
    let memos = List<EscapeMemo>.asSlice(&self.escapeMemos)
    let found = escapeMemoOf(memos, unit)
    if found == usize.MAX { return () }
    if let Option<CapturedBuild>.Some {value: capture} = &memos[found].captured {
      run appendFrontierClosure(&mut self.frontierClosureQueue, &mut self.frontierClosureSeen, &capture.record)
    }
  }

  // The worker already holds one of the shared four compute leases. One exact root is one
  // scheduling quantum, followed by module/chunk work; no extra process or thread is created.
  effect fn advanceFrontierClosure(self: &mut Self, request: &mut Request) -> bool
  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError ? &mut Allocator | &mut Types {
    if !demandedClosureFrontier() || self.frontierWorker == usize.MAX || self.resolver.revisable { return false }
    while self.frontierClosureHead < List<ContentHash>.length(&self.frontierClosureQueue) {
      let exact = List<ContentHash>.get(&self.frontierClosureQueue, self.frontierClosureHead)
      self.frontierClosureHead = self.frontierClosureHead + usize.ONE
      // A claimed definition is another capture's obligation, including an in-flight one.
      // Skipping it is not proof: the coordinator still requires a supplied full row.
      if artifactLogicalOwner(&self.frontierClaims, exact, usize.MAX) != usize.MAX { continue }
      if DigestSet.find(&self.frontierKeyDigests, exact) == usize.MAX { continue }
      let serving = self.frontierServing
      let completed = self.frontierCompletedActive
      self.frontierServing = true
      self.frontierCompletedActive = false
      let attempted = run Effect.result(Semantic.frontierExtend(&mut self.*, &mut request.*, &[exact]))
      self.frontierServing = serving
      self.frontierCompletedActive = completed
      let extended = match move attempted {
        Result<Option<BuildRecord.Record>, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} => move value
        Result<Option<BuildRecord.Record>, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Failure {error} => { fail move error }
      }
      match move extended {
        Option<BuildRecord.Record>.Some {value} => { run List<BuildRecord.Record>.append(&mut self.frontierClosureRecords, move value) }
        Option<BuildRecord.Record>.None => { Semantic.abortFrontierWorker(&self.*, true) return false }
      }
      return true
    }
    return false
  }

'''+needle)
# separate pure append function near the impl
needle='impl Semantic {\n  effect fn includeAnswerBudget'
# actual impl may differ, insert before requested impl member via standalone preceding impl below
anchor='  effect fn queueFrontierClosureMemo'
pos=s.index(anchor); impl=s.rfind('impl Semantic {',0,pos)
helper='''// Only a LEFT row reached by a completed capture creates an early closure obligation.
// EXTERNAL already has a supplier; foreign/full rows and duplicate exact keys add no work.
effect fn appendFrontierClosure(queue: &mut List<ContentHash>, seen: &mut DigestSet, record: &BuildRecord.Record) -> ()
! OutOfMemoryError ? &mut Allocator {
  let entries = List<BuildRecord.Entry>.asSlice(&record.entries)
  let mut at = usize.ZERO
  while at < entries.length {
    if entries[at].leaf == BuildRecord.LEFT && run DigestSet.add(&mut seen.*, entries[at].exact) {
      run List<ContentHash>.append(&mut queue.*, entries[at].exact)
    }
    at = at + usize.ONE
  }
}

'''
s=s[:impl]+helper+s[impl:]
# chunk capture already passed all semantic refusal checks
put('''    let escapeKey = match move run stableUnit(&self.resolver, unit) {''','''    if demandedClosureFrontier() {
      run appendFrontierClosure(&mut self.frontierClosureQueue, &mut self.frontierClosureSeen, &capture.record)
    }
    let escapeKey = match move run stableUnit(&self.resolver, unit) {''')
put('''    run Semantic.registerFrontierCompletedMemo(&mut self.*, runtimeUnit)
    let mut modulesRun''','''    run Semantic.registerFrontierCompletedMemo(&mut self.*, runtimeUnit)
    run Semantic.queueFrontierClosureMemo(&mut self.*, runtimeUnit)
    let mut closureCredit = usize.ZERO
    let mut modulesRun''')
put('''    while self.frontierWorker < 4 {
      if let Option<[*]mut u64>.Some {value: table} = &self.frontierChunks {''','''    while self.frontierWorker < 4 {
      // Four ordinary tasks earn at most one closure quantum. Mandatory declaration coverage
      // cannot be starved by a stream of newly discovered closure roots.
      if closureCredit >= 4 {
        closureCredit = usize.ZERO
        drop run Semantic.advanceFrontierClosure(&mut self.*, &mut request.*)
      }
      if let Option<[*]mut u64>.Some {value: table} = &self.frontierChunks {''')
put('''          chunksRun = chunksRun + usize.ONE
          continue''','''          chunksRun = chunksRun + usize.ONE
          closureCredit = closureCredit + usize.ONE
          continue''')
put('''      run Semantic.registerFrontierCompletedMemo(&mut self.*, u64.toUsize(word.value))
    }
    run frontierTrace(b"completed body registry"''','''      run Semantic.registerFrontierCompletedMemo(&mut self.*, u64.toUsize(word.value))
      run Semantic.queueFrontierClosureMemo(&mut self.*, u64.toUsize(word.value))
      closureCredit = closureCredit + usize.ONE
    }
    // No declaration task remains locally. Drain supplied exact tickets; release/reacquire
    // the existing lease between roots so pending descendant/runtime work keeps priority.
    while run Semantic.advanceFrontierClosure(&mut self.*, &mut request.*) {
      if let Option<[*]mut u64>.Some {value: control} = &self.frontierForkControl {
        releaseFrontierLease(control)
        if !acquireFrontierLease(control, false) { Semantic.abortFrontierWorker(&self.*, false) }
      }
    }
    if demandedClosureFrontier() {
      run frontierTrace(b"demanded closure", self.frontierSplit, List<ContentHash>.length(&self.frontierClosureQueue),
        List<BuildRecord.Record>.length(&self.frontierClosureRecords))
    }
    run frontierTrace(b"completed body registry"''')
# insert transport before write payload (exact local statement inspect)
needle='''    run writeFrontierPayload(unsafe FrontierHost.descriptor(self.frontierOutput), List<CacheImage.Root>.asSlice(&image.roots))'''
assert s.count(needle)==1,s.count(needle)
s=s.replace(needle,'''    let completedClosures = List<BuildRecord.Record>.asSlice(&self.frontierClosureRecords)
    let mut closureAt = usize.ZERO
    while closureAt < completedClosures.length {
      run List<CacheImage.Root>.append(&mut image.roots, CacheImage.Root {key: run Bytes.copy(b"frontier-demanded-closure-v1"),
        node: usize.ZERO, answer: run BuildRecord.encode(&completedClosures[closureAt])})
      closureAt = closureAt + usize.ONE
    }
'''+needle)
# no coverage credit for extra fragment; final union proves all referenced obligations
put('''        if same(key, b"frontier-sweep-chunk-v1") {''','''        if same(key, b"frontier-demanded-closure-v1") {
          if !demandedClosureFrontier() { good = false at = at + usize.ONE continue }
          let extension = match move run BuildRecord.decode(Bytes.asSlice(&root.answer)) {
            Option<BuildRecord.Record>.Some {value} => move value
            Option<BuildRecord.Record>.None => { good = false at = at + usize.ONE continue }
          }
          run List<BuildRecord.Record>.append(&mut records, move extension)
          at = at + usize.ONE
          continue
        }
        if same(key, b"frontier-sweep-chunk-v1") {''')
p.write_text(s)
