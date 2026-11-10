p='/workspace/silk-balanced-frontier/compiler/src/semantic/Semantic.silk'
s=open(p).read().replace('// Ready module rosters publish only declaration counts; every worker reconstructs the\n// exact source roster locally before checking its claimed contiguous range.','// Ready module rosters publish only range counts; every worker reconstructs the\n// same source-cost ranges locally, while exact declaration coverage remains independently proved.',1)
s=s.replace('struct FrontierChunkTask { module: usize, start: usize, end: usize }\nstruct FrontierModuleRoster { module: usize, checks: ModuleChecks }\nconst frontierChunkWidth: usize = 64\nconst frontierChunkThreshold: usize = 256','struct FrontierChunkTask { module: usize, index: usize }\nstruct FrontierModuleRoster { module: usize, checks: ModuleChecks, cuts: List<usize> }\nconst frontierChunkTargetWork: usize = 65536\nconst frontierChunkMinimumWork: usize = 262144',1)
s=s.replace('fn publishFrontierChunks(table: [*]mut u64, module: usize, declarations: usize) -> () {\n  unsafe Atomic.store<u64>(unsafe Pointer.atMut<u64>(table, module * 2), usize.toU64(declarations), MemoryOrder.Release)','fn publishFrontierChunks(table: [*]mut u64, module: usize, ranges: usize) -> () {\n  unsafe Atomic.store<u64>(unsafe Pointer.atMut<u64>(table, module * 2), usize.toU64(ranges), MemoryOrder.Release)',1)
s=s.replace('''        let start = u64.toUsize(unsafe Atomic.fetchAdd<u64>(counter, usize.toU64(frontierChunkWidth), MemoryOrder.Relaxed))
        if start < count {
          let mut end = start + frontierChunkWidth
          if end > count { end = count }
          return Option<FrontierChunkTask>.some(FrontierChunkTask {module: module, start: start, end: end})
        }''','''        let index = u64.toUsize(unsafe Atomic.fetchAdd<u64>(counter, 1, MemoryOrder.Relaxed))
        if index < count { return Option<FrontierChunkTask>.some(FrontierChunkTask {module: module, index: index}) }''',1)
a=s.index('  // A range remains a transport-only partial sweep')
helpers='''  // Source spans only guide scheduling. In particular, constants and names still belong
  // to the exact complete roster; they simply do not cause a cheap module to be split.
  effect fn frontierHasChunkWork(self: &mut Self, module: &ModuleId) -> bool
  ! Cycle | OutOfMemoryError ? &mut Allocator {
    let answer = run source(&mut self.resolver, module)
    let indexed = match move sourceOf(&self.resolver, &answer, module) {
      Option<&IndexedSource>.Some {value} => value
      Option<&IndexedSource>.None => { return false }
    }
    if SourceUnit.bytes(IndexedSource.sourceUnit(indexed)).length < frontierChunkMinimumWork { return false }
    let hir = IndexedSource.authored(indexed)
    let written = ModuleIndex.listDeclarations(IndexedSource.moduleIndex(indexed))
    let mut work = usize.ZERO
    let mut at = usize.ZERO
    while at < written.length {
      if let Node.Declaration {body: syntax, ..} = Module.node(hir, written[at].local) {
        if let Node.CallableBody {block} = Module.node(hir, syntax) {
          if block.present {
            let span = Module.span(hir, block.id)
            let length = span.end - span.start
            if length >= frontierChunkMinimumWork - work { return true }
            work = work + length
          }
        }
      }
      at = at + usize.ONE
    }
    return false
  }

  effect fn frontierRoster(self: &Self, module: usize, checks: ModuleChecks) -> FrontierModuleRoster
  ! OutOfMemoryError ? &mut Allocator {
    let written = List<DeclarationCheck>.asSlice(&checks.declarations)
    let mut work = run List<usize>.makeWithCapacity(written.length)
    let mut at = usize.ZERO
    while at < written.length {
      let declaration = &written[at]
      let deferred = match &declaration.deferred { Option<StaticTemplate.Reason>.Some {..} => true _ => false }
      let amount = if declaration.body && !deferred { declaration.block.end - declaration.block.start } else { usize.ZERO }
      run List<usize>.append(&mut work, amount)
      at = at + usize.ONE
    }
    let cuts = run SweepFragments.ranges(List<usize>.asSlice(&work), frontierChunkTargetWork, frontierChunkMinimumWork)
    return FrontierModuleRoster {module: module, checks: move checks, cuts: move cuts}
  }

'''
s=s[:a]+helpers+s[a:]
a=s.index('  effect fn frontierSweepChunk(');b=s.index('  effect fn publishFrontier(',a)
part=s[a:b]
part=part.replace('''    let listed = if foundRoster != usize.MAX {
      let held = List<FrontierModuleRoster>.remove(&mut self.frontierRosters, foundRoster)
      move held.checks
    } else {
      run Semantic.readPendingDeclarations(&mut self.*, &module)
      run Semantic.moduleChecks(&mut self.*, &module, &Option<DeclarationId>.none())
    }
    let written = List<DeclarationCheck>.asSlice(&listed.declarations)
    if task.start >= task.end || task.end > written.length { unsafe FrontierHost.exit(3) return () }''','''    let roster = if foundRoster != usize.MAX {
      List<FrontierModuleRoster>.remove(&mut self.frontierRosters, foundRoster)
    } else {
      run Semantic.readPendingDeclarations(&mut self.*, &module)
      let checks = run Semantic.moduleChecks(&mut self.*, &module, &Option<DeclarationId>.none())
      run Semantic.frontierRoster(&self.*, ordinal, move checks)
    }
    let cuts = List<usize>.asSlice(&roster.cuts)
    if task.index >= cuts.length || cuts.length - task.index < 2 { unsafe FrontierHost.exit(3) return () }
    let start = cuts[task.index]
    let end = cuts[task.index + usize.ONE]
    let listed = &roster.checks
    let written = List<DeclarationCheck>.asSlice(&listed.declarations)
    if start >= end || end > written.length { unsafe FrontierHost.exit(3) return () }''',1)
part=part.replace('task.start','start').replace('task.end','end')
part=part.replace('run List<FrontierModuleRoster>.append(&mut self.frontierRosters, FrontierModuleRoster {module: ordinal, checks: move listed})','run List<FrontierModuleRoster>.append(&mut self.frontierRosters, move roster)',1)
s=s[:a]+part+s[b:]
s=s.replace('''      if chunking {
        run Semantic.readPendingDeclarations(&mut self.*, &module)
        let roster = run Semantic.moduleChecks(&mut self.*, &module, &Option<DeclarationId>.none())
        let count = List<DeclarationCheck>.length(&roster.declarations)
        if count >= frontierChunkThreshold {
          run List<FrontierModuleRoster>.append(&mut self.frontierRosters, FrontierModuleRoster {module: ordinal, checks: move roster})
          if let Option<[*]mut u64>.Some {value: table} = &self.frontierChunks { publishFrontierChunks(table, at, count) }
          continue
        }
      }''','''      if chunking && run Semantic.frontierHasChunkWork(&mut self.*, &module) {
        run Semantic.readPendingDeclarations(&mut self.*, &module)
        let checks = run Semantic.moduleChecks(&mut self.*, &module, &Option<DeclarationId>.none())
        let roster = run Semantic.frontierRoster(&self.*, ordinal, move checks)
        let count = List<usize>.length(&roster.cuts)
        if count > 2 {
          run List<FrontierModuleRoster>.append(&mut self.frontierRosters, move roster)
          if let Option<[*]mut u64>.Some {value: table} = &self.frontierChunks { publishFrontierChunks(table, at, count - usize.ONE) }
          continue
        }
      }''',1)
open(p,'w').write(s)
