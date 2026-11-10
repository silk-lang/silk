from pathlib import Path
root=Path('/workspace/silk-cache-budget-timing/compiler/src')
p=root/'semantic/Semantic.silk';s=p.read_text();s=s.replace('import semantic.FrontierHost {FrontierHost}', 'import semantic.CacheWorkTrace\nimport semantic.FrontierHost {FrontierHost}',1)
s=s.replace('  let parsed = if shared { run EscapeGraphIndex.read(bytes, digest) } else { run EscapeGraphIndex.readInline(bytes) }','  let measured = run CacheWorkTrace.begin()\n  let parsed = if shared { run EscapeGraphIndex.read(bytes, digest) } else { run EscapeGraphIndex.readInline(bytes) }\n  run CacheWorkTrace.end(if shared { b"directory-shared" } else { b"directory-inline" }, measured, bytes.length, usize.ZERO)',1)
s=s.replace('  let answer = match move run EscapeGraph.decodeAnswer(bytes) {','  let answer = match move run EscapeGraph.decodeAnswer(bytes) {',1)
needle='  let selected = match move run cachedEscapeAnswer(Option<&CacheImage.Image>.some(image), &mut cache.*, bytes) {'
s=s.replace(needle,'  let measured = run CacheWorkTrace.begin()\n'+needle,1)
s=s.replace('  return true\n}\n\n// The selected check charges', '  run CacheWorkTrace.end(b"green-entries", measured, indexes.length, usize.ZERO)\n  return true\n}\n\n// The selected check charges',1)
s=s.replace('  return run EscapeGraphIndexReach.includeBudget(&mut graph.directory, payload, &mut budget.*,\n    List<usize>.asSlice(&List<CachedEscapeView>.asSlice(&graph.views)[selected.view].entries))', '''  let measured = run CacheWorkTrace.begin()
  let before = SpecializationBudget.definitionCount(budget)
  let entries = List<usize>.asSlice(&List<CachedEscapeView>.asSlice(&graph.views)[selected.view].entries)
  let accepted = run EscapeGraphIndexReach.includeBudget(&mut graph.directory, payload, &mut budget.*, entries)
  run CacheWorkTrace.end(b"budget-indexed", measured, entries.length, SpecializationBudget.definitionCount(budget) - before)
  return accepted''',1)
s=s.replace('    // Record indices belong to exactly one held image, including when an existing store adopts another.','    let measured = run CacheWorkTrace.begin()\n    // Record indices belong to exactly one held image, including when an existing store adopts another.',1)
s=s.replace('    return run Semantic.finishAdoption(&mut self.*, move held, move attempted)','    let adopted = run Semantic.finishAdoption(&mut self.*, move held, move attempted)\n    run CacheWorkTrace.end(b"adopt-total", measured, adopted.roots, adopted.stale)\n    return move adopted',1)
needle='    let roots = List<CacheImage.Root>.asSlice(&image.roots)\n    let mut at = usize.ZERO\n    while at < candidates.length {'
s=s.replace(needle,'    let measured = run CacheWorkTrace.begin()\n    let mut attached = usize.ZERO\n'+needle,1)
s=s.replace('            slots[found].budgetRecord = root','            slots[found].budgetRecord = root\n            attached = attached + usize.ONE',1)
s=s.replace('  // Holds the pack the image root at `root` describes with the body offered for it, when one was.', '  // Holds the pack the image root at `root` describes with the body offered for it, when one was.',1)
needle='''    }
  }

  // Holds the pack'''
s=s.replace(needle,'''    }
    run CacheWorkTrace.end(b"attach-budgets", measured, candidates.length, attached)
  }

  // Holds the pack''',1)
needle='''          accounted = run WalkFragments.includeBudget(&mut self.specializationBudget, &capture.record)'''
s=s.replace(needle,'''          let measured = run CacheWorkTrace.begin()
          let before = SpecializationBudget.definitionCount(&self.specializationBudget)
          accounted = run WalkFragments.includeBudget(&mut self.specializationBudget, &capture.record)
          run CacheWorkTrace.end(b"budget-captured", measured, List<BuildRecord.Entry>.length(&capture.record.entries),
            SpecializationBudget.definitionCount(&self.specializationBudget) - before)''',1)
needle='''          let encoded = run adoptedAnswer(&self.heldImage, kept[found].budgetRecord)
          accounted = run escapeAnswerBudget(heldImageReference(&self.heldImage), &mut self.escapeGraphs,
            &mut self.specializationBudget, Bytes.asSlice(&encoded))'''
s=s.replace(needle,'''          let measured = run CacheWorkTrace.begin()
          let encoded = run adoptedAnswer(&self.heldImage, kept[found].budgetRecord)
          accounted = run escapeAnswerBudget(heldImageReference(&self.heldImage), &mut self.escapeGraphs,
            &mut self.specializationBudget, Bytes.asSlice(&encoded))
          run CacheWorkTrace.end(b"budget-green-total", measured, Bytes.length(&encoded), if accounted { usize.ONE } else { usize.ZERO })''',1)
p.write_text(s)
p=root/'driver/SemanticCache.silk';s=p.read_text();s=s.replace('import semantic.BuildRecord','import semantic.CacheWorkTrace\nimport semantic.BuildRecord',1)
start=s.index('pub effect fn openPrefetched(');end=s.index('  let stamp = ',start)
header=s[start:end];wrapper=header+'''  let measured = run CacheWorkTrace.begin()
  let result = run openPrefetchedMeasured(store, request, cache, compiler, linked, building, move prefetched, dependencies, runtime)
  run CacheWorkTrace.end(b"open-cache-total", measured, dependencies.length, runtime.length)
  return move result
}

'''+header.replace('pub effect fn openPrefetched(', 'effect fn openPrefetchedMeasured(')
s=s[:start]+wrapper+s[end:];p.write_text(s)
