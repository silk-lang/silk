from pathlib import Path
root=Path('/workspace/silk-cpu0-cache-work/compiler/src');p=root/'semantic/Semantic.silk';s=p.read_text()
def replace(old,new):
 global s
 assert s.count(old)==1,(old[:100],s.count(old));s=s.replace(old,new)
replace('import semantic.FrontierHost {FrontierHost}', 'import semantic.CacheWorkTrace\nimport semantic.FrontierHost {FrontierHost}')
replace('  directory: EscapeGraphIndex.Index,\n  replay: Option<CachedEscapeRecord>,','  directory: EscapeGraphIndex.Index,\n  trace: CacheWorkTrace.Rows,\n  replay: Option<CachedEscapeRecord>,')
replace('  let parsed = if shared { run EscapeGraphIndex.read(bytes, digest) } else { run EscapeGraphIndex.readInline(bytes) }','  let measured = run CacheWorkTrace.begin()\n  let parsed = if shared { run EscapeGraphIndex.read(bytes, digest) } else { run EscapeGraphIndex.readInline(bytes) }\n  let directoryNanos = run CacheWorkTrace.elapsed(measured)')
replace('  run List<CachedEscapeGraph>.append(&mut cache.*, CachedEscapeGraph {digest: digest, shared: shared, root: usize.MAX, directory: move directory,','  let mut trace = run CacheWorkTrace.rows(List<EscapeGraphIndex.Entry>.length(&directory.entries))\n  trace.directoryNanos = directoryNanos\n  trace.directoryBytes = bytes.length\n  run List<CachedEscapeGraph>.append(&mut cache.*, CachedEscapeGraph {digest: digest, shared: shared, root: usize.MAX, directory: move directory, trace: move trace,')
start=s.index('effect fn escapeAnswerGreen(');end=s.index('\n// The selected check charges',start);b=s[start:end]
b=b.replace('  let graph = &List<CachedEscapeGraph>.asSlice(&cache.*)[selected.graph]','  let graph = &mut List<CachedEscapeGraph>.asMutSlice(&mut cache.*)[selected.graph]')
b=b.replace('  let mut at = usize.ZERO\n  while at < indexes.length {','  let began = if graph.trace.enabled { run CacheWorkTrace.now() } else { 0 }\n  let mut accepted = true\n  let mut at = usize.ZERO\n  while at < indexes.length {\n    CacheWorkTrace.visit(&mut graph.trace, indexes[at], true)')
b=b.replace('!= BuildRecord.FACT_KNOWN + BuildRecord.FACT_KEY_BYTES { return false }','!= BuildRecord.FACT_KNOWN + BuildRecord.FACT_KEY_BYTES { accepted = false break }')
b=b.replace('  return true\n}', '  if graph.trace.enabled {\n    graph.trace.greenCalls = graph.trace.greenCalls + usize.ONE\n    graph.trace.greenNanos = graph.trace.greenNanos + (run CacheWorkTrace.elapsed(began))\n  }\n  return accepted\n}')
s=s[:start]+b+s[end:]
replace('''  return run EscapeGraphIndexReach.includeBudget(&mut graph.directory, payload, &mut budget.*,
    List<usize>.asSlice(&List<CachedEscapeView>.asSlice(&graph.views)[selected.view].entries))''','''  let indexes = List<usize>.asSlice(&List<CachedEscapeView>.asSlice(&graph.views)[selected.view].entries)
  let began = if graph.trace.enabled { run CacheWorkTrace.now() } else { 0 }
  let before = SpecializationBudget.definitionCount(&budget.*)
  let accepted = run EscapeGraphIndexReach.includeBudget(&mut graph.directory, payload, &mut budget.*, indexes)
  if graph.trace.enabled {
    graph.trace.budgetNanos = graph.trace.budgetNanos + (run CacheWorkTrace.elapsed(began))
    graph.trace.budgetCalls = graph.trace.budgetCalls + usize.ONE
    graph.trace.budgetNew = graph.trace.budgetNew + SpecializationBudget.definitionCount(&budget.*) - before
    let mut at = usize.ZERO
    while at < indexes.length { CacheWorkTrace.visit(&mut graph.trace, indexes[at], false) at = at + usize.ONE }
  }
  return accepted''')
replace('''effect fn settleSourceInputs(resolver: &mut Resolver) -> () ! Cycle | OutOfMemoryError ? &mut Allocator {
  while''','''effect fn settleSourceInputs(resolver: &mut Resolver) -> () ! Cycle | OutOfMemoryError ? &mut Allocator {
  let started = run CacheWorkTrace.begin()
  let pending = List<usize>.length(&resolver.sourceInputs.pending)
  let mut trace = run CacheWorkTrace.capture()
  while''')
start=s.index('effect fn settleSourceInputs(');end=s.index('\n// What `selector`',start);b=s[start:end]
b=b.replace('    let ordinal =','    let lookupStart = if trace.enabled { run CacheWorkTrace.now() } else { 0 }\n    let ordinal =',1)
b=b.replace('    let mut arena =','    let lookupNanos = run CacheWorkTrace.elapsed(lookupStart)\n    let captureStart = if trace.enabled { run CacheWorkTrace.now() } else { 0 }\n    let mut arena =',1)
b=b.replace('    let text = Inputs.text','    let captureNanos = run CacheWorkTrace.elapsed(captureStart)\n    let hashStart = if trace.enabled { run CacheWorkTrace.now() } else { 0 }\n    let text = Inputs.text',1)
b=b.replace('    let mut writable =','    if trace.enabled {\n      CacheWorkTrace.record(&mut trace, observed, Inputs.selectorName(observed), lookupNanos, captureNanos,\n        run CacheWorkTrace.elapsed(hashStart), Bytes.length(&value))\n    }\n    let mut writable =',1)
b=b.replace('  }\n}\n','  }\n  run CacheWorkTrace.end(b"settle-inputs", started, pending, List<usize>.length(&resolver.sourceInputs.pending))\n  run CacheWorkTrace.report(&trace)\n}\n')
s=s[:start]+b+s[end:]
replace('''    run settleSourceInputs(&mut self.resolver)
    let mut build = ImageBuild''','''    run settleSourceInputs(&mut self.resolver)
    let assembling = run CacheWorkTrace.begin()
    let mut build = ImageBuild''')
replace('''      fileModules: move fileModules, checks: move pending})
    return move image''','''      fileModules: move fileModules, checks: move pending})
    run CacheWorkTrace.end(b"fresh-image", assembling, CacheImage.nodeCount(&image), List<CacheImage.Root>.length(&image.roots))
    return move image''')
start=s.index('  effect fn completeCacheImageWithWalkRecords(');end=s.index('\n  /// Adds to `image`',start);b=s[start:end]
b=b.replace('    run Semantic.unpackAdoptedImage(&mut self.*)','    let carrying = run CacheWorkTrace.begin()\n    run Semantic.unpackAdoptedImage(&mut self.*)',1)
b=b.replace('    if adopted {','    run CacheWorkTrace.end(b"carry-image", carrying, CacheImage.nodeCount(&image), List<CacheImage.Root>.length(&image.roots))\n    let finishing = run CacheWorkTrace.begin()\n    if adopted {',1)
b=b.replace('    run pruneEscapeBlobs(&mut image)','    run CacheWorkTrace.end(b"carried-checks-files", finishing, CacheImage.nodeCount(&image), List<CacheImage.Root>.length(&image.roots))\n    let pruning = run CacheWorkTrace.begin()\n    run pruneEscapeBlobs(&mut image)\n    run CacheWorkTrace.end(b"prune-blobs", pruning, CacheImage.nodeCount(&image), List<CacheImage.Root>.length(&image.roots))',1)
s=s[:start]+b+s[end:]
marker='  fn clearEscapeAdoption(self: &mut Self) -> () {'
report='''  /// Emits one aggregate snapshot of diagnostic cache-read work before persistence. Counts
  /// belong to this adoption generation, are never semantic authority, and are not rolled back.
  pub effect fn traceCacheWork(self: &Self) -> () ! OutOfMemoryError ? &mut Allocator {
    if !CacheWorkTrace.enabled() { return () }
    let graphs = List<CachedEscapeGraph>.asSlice(&self.escapeGraphs)
    let mut mode = usize.ZERO
    while mode < 2 {
      let shared = mode == usize.ONE
      let mut greenNanos: u64 = 0
      let mut budgetNanos: u64 = 0
      let mut directoryNanos: u64 = 0
      let mut greenRows = usize.ZERO
      let mut greenFirst = usize.ZERO
      let mut greenCalls = usize.ZERO
      let mut budgetRows = usize.ZERO
      let mut budgetFirst = usize.ZERO
      let mut budgetCalls = usize.ZERO
      let mut newDefinitions = usize.ZERO
      let mut directoryBytes = usize.ZERO
      let mut directories = usize.ZERO
      let mut at = usize.ZERO
      while at < graphs.length {
        let graph = &graphs[at]
        at = at + usize.ONE
        if graph.shared != shared { continue }
        let trace = &graph.trace
        greenNanos = greenNanos + trace.greenNanos
        budgetNanos = budgetNanos + trace.budgetNanos
        directoryNanos = directoryNanos + trace.directoryNanos
        greenRows = greenRows + trace.greenRows
        greenFirst = greenFirst + trace.greenFirst
        greenCalls = greenCalls + trace.greenCalls
        budgetRows = budgetRows + trace.budgetRows
        budgetFirst = budgetFirst + trace.budgetFirst
        budgetCalls = budgetCalls + trace.budgetCalls
        newDefinitions = newDefinitions + trace.budgetNew
        directoryBytes = directoryBytes + trace.directoryBytes
        directories = directories + usize.ONE
      }
      run CacheWorkTrace.emit(if shared { b"green-shared" } else { b"green-inline" }, greenNanos, greenRows, greenFirst, greenCalls)
      run CacheWorkTrace.emit(if shared { b"budget-shared" } else { b"budget-inline" }, budgetNanos, budgetRows, budgetFirst, budgetCalls)
      run CacheWorkTrace.emit(if shared { b"directory-shared" } else { b"directory-inline" }, directoryNanos, directoryBytes, directories, newDefinitions)
      mode = mode + usize.ONE
    }
  }
'''
replace(marker,report+marker)
p.write_text(s)
p=root/'semantic/CacheWorkTrace.silk';s=p.read_text().replace('  pub budgetNew: usize,','  pub budgetNew: usize, pub directoryNanos: u64, pub directoryBytes: usize,').replace('budgetFirst: 0, budgetNanos: 0, budgetNew: 0}','budgetFirst: 0, budgetNanos: 0, budgetNew: 0, directoryNanos: 0, directoryBytes: 0}');p.write_text(s)
p=root/'driver/SemanticCache.silk';s=p.read_text();s=s.replace('import semantic.BuildRecord','import semantic.CacheWorkTrace\nimport semantic.BuildRecord',1)
for prefix in ['pub effect fn save(store:', 'pub effect fn saveTracked(store:']:
 start=s.index(prefix);pos=s.index('  if current(&store.*, file)',start);s=s[:pos]+'  run Semantic.traceCacheWork(&store.*)\n'+s[pos:]
s=s.replace('  let image = run CacheImage.compactDuplicateRoots(move completed)','  let pruning = run CacheWorkTrace.begin()\n  let image = run CacheImage.compactDuplicateRoots(move completed)\n  run CacheWorkTrace.end(b"compact-roots", pruning, CacheImage.nodeCount(&image), List<CacheImage.Root>.length(&image.roots))',1)
s=s.replace('  let files = run CacheImage.encodeFiles(&pending.image, Bytes.asSlice(&pending.stamp))','  let encoding = run CacheWorkTrace.begin()\n  let files = run CacheImage.encodeFiles(&pending.image, Bytes.asSlice(&pending.stamp))\n  run CacheWorkTrace.end(b"encode-files", encoding, Bytes.length(&files.graph), Bytes.length(&files.roots))\n  let writing = run CacheWorkTrace.begin()',1)
s=s.replace('  drop run written(Bytes.asSlice(&pending.path), Bytes.asSlice(&files.graph), creating)','  drop run written(Bytes.asSlice(&pending.path), Bytes.asSlice(&files.graph), creating)\n  run CacheWorkTrace.end(b"write-files", writing, Bytes.length(&files.graph), Bytes.length(&files.roots))',1)
p.write_text(s)
