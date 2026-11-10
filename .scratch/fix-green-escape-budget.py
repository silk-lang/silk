from pathlib import Path
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/Semantic.silk');s=p.read_text()
s=s.replace('  // For a replay, the unit that holds what it demanded, which the root of a replay that reports\n', '  // An exact persisted budget record validated with this memo during adoption. It carries no MIR handles.\n  budgetRecord: usize,\n  // For a replay, the unit that holds what it demanded, which the root of a replay that reports\n',1)
s=s.replace('captured: Option<CapturedBuild>.none(), reads: usize.MAX}', 'captured: Option<CapturedBuild>.none(), budgetRecord: usize.MAX, reads: usize.MAX}')
s=s.replace('captured: move captured, reads: usize.MAX}', 'captured: move captured, budgetRecord: usize.MAX, reads: usize.MAX}')
s=s.replace('captured: Option<CapturedBuild>.some(move captured), reads: reads}', 'captured: Option<CapturedBuild>.some(move captured), budgetRecord: usize.MAX, reads: reads}')
s=s.replace('captured: last, reads: _}', 'captured: last, budgetRecord: _, reads: _}')
s=s.replace('    let mut held = move image\n    // An image whose nodes do not read', '''    // Record indices belong to exactly one held image, including when an existing store adopts another.
    let prior = List<EscapeMemo>.asMutSlice(&mut self.escapeMemos)
    let mut memo = usize.ZERO
    while memo < prior.length { prior[memo].budgetRecord = usize.MAX memo = memo + usize.ONE }
    let mut held = move image
    // An image whose nodes do not read''',1)
s=s.replace('    self.escapeImage = EscapeImage.make()\n    at = usize.ZERO\n    while at < roots.length {', '''    self.escapeImage = EscapeImage.make()
    let mut budgetRecords = List<usize>.make()
    let mut budgetEntries = DigestSet.make()
    at = usize.ZERO
    while at < roots.length {''',1)
s=s.replace('''      if kind == 3 || kind == 4 {
        if (node != usize.MAX || List<bool>.get(&settled, root.node)) && !linked {''', '''      if kind == 3 || kind == 4 {
        if node != usize.MAX || List<bool>.get(&settled, root.node) {
          if kind == 3 { run List<usize>.append(&mut budgetRecords, at - usize.ONE) }
          else { drop run DigestSet.add(&mut budgetEntries, digestOfBytes(StableKey.view(Bytes.asSlice(&root.key), exact))) }
        }
        if (node != usize.MAX || List<bool>.get(&settled, root.node)) && !linked {''',1)
s=s.replace('    self.replay = Option<ReplayState>.none()\n    if recordRoot != usize.MAX {', '''    run Semantic.attachEscapeBudgets(&mut self.*, image, List<usize>.asSlice(&budgetRecords), &budgetEntries)
    self.replay = Option<ReplayState>.none()
    if recordRoot != usize.MAX {''',1)
# Attach only a record whose every definition was independently verified green at adoption.
pos=s.index('  // Holds the pack the image root at `root` describes')
s=s[:pos]+'''  effect fn attachEscapeBudgets(self: &mut Self, image: &CacheImage.Image, candidates: &[usize], green: &DigestSet) -> ()
  ! OutOfMemoryError ? &mut Allocator {
    let roots = List<CacheImage.Root>.asSlice(&image.roots)
    let mut at = usize.ZERO
    while at < candidates.length {
      let root = candidates[at]
      at = at + usize.ONE
      let record = match move run BuildRecord.decode(Bytes.asSlice(&roots[root].answer)) {
        Option<BuildRecord.Record>.Some {value} => move value
        Option<BuildRecord.Record>.None => { continue }
      }
      if record.patterns { continue }
      let entries = List<BuildRecord.Entry>.asSlice(&record.entries)
      let mut complete = true
      let mut entry = usize.ZERO
      while entry < entries.length && complete {
        let value = &entries[entry]
        if value.leaf == 0 && value.alias == usize.MAX {
          complete = DigestSet.find(green, value.exact) != usize.MAX
            && u64.bitAnd(value.facts.flags, BuildRecord.FACT_KNOWN + BuildRecord.FACT_KEY_BYTES)
              == BuildRecord.FACT_KNOWN + BuildRecord.FACT_KEY_BYTES
        }
        entry = entry + usize.ONE
      }
      if !complete { continue }
      let mut exact = Span.make(usize.ZERO, usize.ZERO)
      if buildRootKind(Bytes.asSlice(&roots[root].key), &mut exact) != 3 { continue }
      let key = StableKey.view(Bytes.asSlice(&roots[root].key), exact)
      if let Option<CheckKey>.Some {value: check} = move run readCheckKey(key) {
        if check.name != usize.ONE { continue }
        let module = run internModule(&mut self.resolver, &check.module)
        let word = run internKey(&mut self.resolver, Key {family: Family.ModuleCheck, module: module, name: check.name,
          declaration: usize.MAX, member: check.member, external: false})
        let unit = u64.toUsize(word.value)
        // Context/profile are part of the exact check key, not merely its module/name/member.
        if let Option<Bytes>.Some {value: stable} = move run stableUnit(&self.resolver, unit) {
          if !same(Bytes.asSlice(&stable), key) { continue }
          let found = escapeMemoOf(List<EscapeMemo>.asSlice(&self.escapeMemos), unit)
          if found != usize.MAX {
            let slots = List<EscapeMemo>.asMutSlice(&mut self.escapeMemos)
            slots[found].budgetRecord = root
          }
        }
      }
    }
  }

'''+s[pos:]
s=s.replace('''        let kept = List<EscapeMemo>.asSlice(&self.escapeMemos)
        let mut accounted = false
        if let Option<CapturedBuild>.Some {value: capture} = &kept[found].captured {
          accounted = run WalkFragments.includeBudget(&mut self.specializationBudget, &capture.record)
        }
        if accounted { return run copyCheckResult(&kept[found].result) }''','''        let kept = List<EscapeMemo>.asSlice(&self.escapeMemos)
        // A verified hard failure is reusable without claiming that its incomplete graph is finite.
        if checkRefuses(&kept[found].result) { return run copyCheckResult(&kept[found].result) }
        let mut accounted = false
        if let Option<CapturedBuild>.Some {value: capture} = &kept[found].captured {
          accounted = run WalkFragments.includeBudget(&mut self.specializationBudget, &capture.record)
        } else if self.frontierWorker == usize.MAX && kept[found].budgetRecord != usize.MAX {
          // Workers still replay assigned checks to obtain real transport captures. Ordinary green
          // hits need only the exact graph's budget facts, already verified during adoption.
          let encoded = run adoptedAnswer(&self.heldImage, kept[found].budgetRecord)
          if let Option<BuildRecord.Record>.Some {value: record} = move run BuildRecord.decode(Bytes.asSlice(&encoded)) {
            accounted = run WalkFragments.includeBudget(&mut self.specializationBudget, &record)
          }
        }
        if accounted { return run copyCheckResult(&kept[found].result) }''',1)
pos=s.index('// The escape check of one list of concrete bodies')
s=s[:pos]+'''fn checkRefuses(result: &DeclarationCheckResult) -> bool {
  if List<Shared<BackendGap>>.length(&result.gaps) != usize.ZERO { return true }
  let rejections = List<Shared<Rejection>>.asSlice(&result.rejections)
  let mut at = usize.ZERO
  while at < rejections.length {
    if Shared<Rejection>.with<bool>(&rejections[at], fn(value: &Rejection) -> bool { return !rejectionWarns(value.code) }) { return true }
    at = at + usize.ONE
  }
  return false
}

'''+s[pos:]
p.write_text(s)
