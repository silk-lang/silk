p='/workspace/silk-declaration-chunks/compiler/src/semantic/Semantic.silk'
s=open(p).read()
pos=s.index('  effect fn publishFrontier(')
helper='''  // A range remains a transport-only partial sweep until the parent verifies the complete
  // authored roster and name checks. Its escape memo is moved into the packet immediately.
  effect fn frontierSweepChunk(self: &mut Self, request: &mut Request, modules: &[usize], task: FrontierChunkTask) -> ()
  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError ? &mut Allocator | &mut Types {
    let started = run frontierNow()
    let ordinal = modules[task.module]
    let module = resolvedModule(&self.resolver, ordinal)
    run Semantic.readPendingDeclarations(&mut self.*, &module)
    let listed = run Semantic.moduleChecks(&mut self.*, &module, &Option<DeclarationId>.none())
    let written = List<DeclarationCheck>.asSlice(&listed.declarations)
    if task.start >= task.end || task.end > written.length { unsafe FrontierHost.exit(3) return () }
    self.deferredTemplates = List<DeferredStaticTemplate>.make()
    self.uncheckedRoot = List<UncheckedBody>.make()
    let mut sweep = Sweep.make()
    let mut names = List<Bytes>.make()
    if task.start == usize.ZERO {
      let expected = List<CheckedName>.asSlice(&listed.names)
      run Semantic.checkNames(&mut self.*, &module, expected, &mut sweep.rejections)
      let mut at = usize.ZERO
      while at < expected.length {
        run List<Bytes>.append(&mut names, run Bytes.copy(Bytes.asSlice(&expected[at].name)))
        at = at + usize.ONE
      }
    }
    let mut declarations = List<Bytes>.make()
    let mut at = task.start
    while at < task.end {
      run Semantic.sweptDeclaration(&mut self.*, &mut request.*, &module, ordinal, &written[at], &mut sweep)
      let mut identity = Bytes.make()
      run StableKey.declaration(&mut identity, &written[at].identity)
      run List<Bytes>.append(&mut declarations, move identity)
      at = at + usize.ONE
    }
    let diagnoses = List<Shared<Rejection>>.asSlice(&sweep.rejections)
    at = usize.ZERO
    while at < diagnoses.length {
      let warning = Shared<Rejection>.with<bool>(&diagnoses[at], fn(value: &Rejection) -> bool { return rejectionWarns(value.code) })
      if !warning { unsafe FrontierHost.exit(3) return () }
      at = at + usize.ONE
    }
    if List<Shared<BackendGap>>.length(&sweep.gaps) != usize.ZERO || List<UncheckedDeclaration>.length(&sweep.unchecked) != usize.ZERO
      || List<UncheckedBody>.length(&self.uncheckedRoot) != usize.ZERO { unsafe FrontierHost.exit(3) return () }
    let mut sites = List<ModuleId>.make()
    let answer = match move run reportingAnswer(0, List<DeclarationId>.asSlice(&sweep.concrete),
      List<Shared<Rejection>>.asSlice(&sweep.rejections), List<DeferredStaticTemplate>.asSlice(&self.deferredTemplates), &mut sites) {
      Option<Bytes>.Some {value} => move value
      Option<Bytes>.None => { unsafe FrontierHost.exit(3) return () }
    }
    let sweepWord = run internKey(&mut self.resolver, Key {family: Family.ModuleCheck, module: ordinal, name: usize.ZERO,
      declaration: usize.MAX, member: usize.ZERO, external: false})
    let sweepKey = match move run stableUnit(&self.resolver, u64.toUsize(sweepWord.value)) {
      Option<Bytes>.Some {value} => move value
      Option<Bytes>.None => { unsafe FrontierHost.exit(3) return () }
    }
    let escaped = run Semantic.keptEscapes(&mut self.*, &mut request.*, ordinal, modules, List<DeclarationId>.asSlice(&sweep.concrete), false)
    if List<Shared<Rejection>>.length(&escaped.rejections) != usize.ZERO || List<Shared<BackendGap>>.length(&escaped.gaps) != usize.ZERO
      || List<UncheckedDeclaration>.length(&escaped.unchecked) != usize.ZERO { unsafe FrontierHost.exit(3) return () }
    let escapeWord = run internKey(&mut self.resolver, Key {family: Family.ModuleCheck, module: ordinal, name: usize.ONE,
      declaration: usize.MAX, member: usize.ONE, external: false})
    let unit = u64.toUsize(escapeWord.value)
    let found = escapeMemoOf(List<EscapeMemo>.asSlice(&self.escapeMemos), unit)
    if found == usize.MAX { unsafe FrontierHost.exit(3) return () }
    let memo = List<EscapeMemo>.remove(&mut self.escapeMemos, found)
    let capture = match move memo.captured {
      Option<CapturedBuild>.Some {value} => move value
      Option<CapturedBuild>.None => { unsafe FrontierHost.exit(3) return () }
    }
    let escapeKey = match move run stableUnit(&self.resolver, unit) {
      Option<Bytes>.Some {value} => move value
      Option<Bytes>.None => { unsafe FrontierHost.exit(3) return () }
    }
    run List<SweepFragments.Packet>.append(&mut self.frontierSweepChunks, SweepFragments.Packet {
      sweep: move sweepKey, escape: move escapeKey, total: written.length, start: task.start,
      declarations: move declarations, namesChecked: task.start == usize.ZERO, names: move names,
      answer: move answer, record: run BuildRecord.encode(&capture.record)})
    run frontierTrace(b"declaration chunk", started, self.frontierWorker, task.start)
  }

'''
s=s[:pos]+helper+s[pos:]
start=s.index('  effect fn publishFrontier(')
a=s.index('    let mut modulesRun = usize.ZERO\n    while true {',start)
s=s[:a]+s[a:].replace('    let mut modulesRun = usize.ZERO\n    while true {','''    let mut modulesRun = usize.ZERO
    let mut chunksRun = usize.ZERO
    while true {
      if let Option<[*]mut u64>.Some {value: table} = &self.frontierChunks {
        if let Option<FrontierChunkTask>.Some {value: task} = move takeFrontierChunk(table, modules.length) {
          run Semantic.frontierSweepChunk(&mut self.*, &mut request.*, modules, task)
          chunksRun = chunksRun + usize.ONE
          continue
        }
      }''',1)
a=s.index('      let module = resolvedModule(&self.resolver, ordinal)\n      let found =',start)
s=s[:a]+s[a:].replace('      let module = resolvedModule(&self.resolver, ordinal)\n      let found =','''      let module = resolvedModule(&self.resolver, ordinal)
      if let Option<[*]mut u64>.Some {value: table} = &self.frontierChunks {
        run Semantic.readPendingDeclarations(&mut self.*, &module)
        let roster = run Semantic.moduleChecks(&mut self.*, &module, &Option<DeclarationId>.none())
        let count = List<DeclarationCheck>.length(&roster.declarations)
        if count >= frontierChunkThreshold {
          publishFrontierChunks(table, at, count)
          continue
        }
      }
      let found =''',1)
a=s.index('    run frontierTrace(b"module task count"',start)
s=s[:a]+'    run frontierTrace(b"module chunk count", self.frontierSplit, self.frontierWorker, chunksRun)\n'+s[a:]
open(p,'w').write(s)
