p='/workspace/silk/.scratch/parallel-check-experiment/compiler/src/semantic/Semantic.silk';s=open(p).read()
s=s.replace('struct CheckWorker { process: i32, stream: ?*mut u8 }','struct CheckWorker { process: i32, stream: ?*mut u8 }\nstruct FrontierCoverage { stable: Bytes, concrete: List<DeclarationId> }')
s=s.replace('  frontierClaims: Option<[*]mut u64>,','  frontierCoverage: List<FrontierCoverage>,\n  frontierExpected: usize,\n  frontierClaims: Option<[*]mut u64>,')
s=s.replace('    frontierClaims: Option<[*]mut u64>.none(),','    frontierCoverage: List<FrontierCoverage>.make(),\n    frontierExpected: usize.ZERO,\n    frontierClaims: Option<[*]mut u64>.none(),')
s=s.replace('    self.frontierClaims = Option<[*]mut u64>.none()\n    run frontierTrace(b"worker-owned-skipped"','    run frontierTrace(b"worker-owned-skipped"',1)
s=s.replace('''      drop run Semantic.keptEscapes(&mut self.*, &mut request.*, ordinal, modules, List<DeclarationId>.asSlice(&concrete), false)
      at = at + 4
    }
    run frontierTrace(b"worker-modules"''','''      if List<Shared<Rejection>>.length(&result.rejections) > usize.ZERO || List<Shared<BackendGap>>.length(&result.gaps) > usize.ZERO {
        unsafe _exit(3)
      }
      let escaped = run Semantic.keptEscapes(&mut self.*, &mut request.*, ordinal, modules, List<DeclarationId>.asSlice(&concrete), false)
      if List<Shared<Rejection>>.length(&escaped.rejections) > usize.ZERO || List<Shared<BackendGap>>.length(&escaped.gaps) > usize.ZERO
        || List<UncheckedDeclaration>.length(&escaped.unchecked) > usize.ZERO { unsafe _exit(3) }
      at = at + 4
    }
    run frontierTrace(b"worker-total-owned-skipped", self.frontierSplit, self.frontierOwned, self.frontierSkipped)
    run frontierTrace(b"worker-modules"''',1)
s=s.replace('    let mut records = List<BuildRecord.Record>.make()\n    let mut good = true','    let mut records = List<BuildRecord.Record>.make()\n    let mut coverage = List<FrontierCoverage>.make()\n    let mut recordKeys = ExactSet.make()\n    let mut runtimeRecords = usize.ZERO\n    let mut good = true',1)
old='''        if runtimeRecord {
          if let Option<BuildRecord.Record>.Some {value} = move run BuildRecord.decode(Bytes.asSlice(&root.answer)) {
            run List<BuildRecord.Record>.append(&mut records, move value)
            found = true
          }
        } else if !same(key, Bytes.asSlice(&stable)) {
          run List<usize>.append(&mut selected, at)
        }'''
new='''        if kind == 3 {
          if let Option<BuildRecord.Record>.Some {value} = move run BuildRecord.decode(Bytes.asSlice(&root.answer)) {
            run List<BuildRecord.Record>.append(&mut records, move value)
            drop run ExactSet.add(&mut recordKeys, Slice.view<u8>(key, exact.start, exact.end - exact.start))
            if runtimeRecord { found = true runtimeRecords = runtimeRecords + usize.ONE }
          }
        } else {
          let mut escaped = false
          if let Option<CheckKey>.Some {value: checked} = move run readCheckKey(key) {
            if checked.name == usize.ONE {
              escaped = true
              if let Option<CheckAnswer>.Some {value: answer} = move run readCheckAnswer(Bytes.asSlice(&root.answer), Option<&ModuleId>.some(&checked.module)) {
                if answer.kind == 1 && List<Shared<Rejection>>.length(&answer.rejections) == usize.ZERO {
                  run List<FrontierCoverage>.append(&mut coverage, FrontierCoverage {stable: run Bytes.copy(key), concrete: move answer.concrete})
                } else { good = false }
              } else { good = false }
            }
          }
          if !escaped { run List<usize>.append(&mut selected, at) }
        }'''
assert old in s;s=s.replace(old,new,1)
s=s.replace('    if !good || List<BuildRecord.Record>.length(&records) != workers.length {','    if !good || runtimeRecords != workers.length || List<BuildRecord.Record>.length(&records) < self.frontierExpected {',1)
s=s.replace('    run frontierTrace(b"merged-images", self.frontierSplit, usize.ZERO, usize.ZERO)','''    let covered = List<FrontierCoverage>.asSlice(&coverage)
    let mut cover = usize.ZERO
    while cover < covered.length {
      if ExactSet.find(&recordKeys, Bytes.asSlice(&covered[cover].stable)) == usize.MAX { return false }
      cover = cover + usize.ONE
    }
    if covered.length < self.frontierExpected { return false }
    run frontierTrace(b"merged-images", self.frontierSplit, List<BuildRecord.Record>.length(&records), covered.length)''',1)
s=s.replace('WalkFragments.admissionFree(&value)','WalkFragments.admissionFree(&value, List<BuildRecord.Record>.asSlice(&records))',1)
s=s.replace('      run frontierTrace(b"adopted", self.frontierSplit, usize.ZERO, usize.ZERO)','      self.frontierCoverage = move coverage\n      run frontierTrace(b"adopted", self.frontierSplit, usize.ZERO, usize.ZERO)',1)
s=s.replace('    self.frontierStarted = run frontierNow()\n    self.frontierAvailable','    self.frontierExpected = List<usize>.length(&modules) + 3\n    self.frontierStarted = run frontierNow()\n    self.frontierAvailable',1)
needle='''    let found = escapeMemoOf(List<EscapeMemo>.asSlice(&self.escapeMemos), unit)
    // The record of this check's last walk'''
replacement='''    if List<FrontierCoverage>.length(&self.frontierCoverage) > usize.ZERO {
      if let Option<Bytes>.Some {value: stable} = move run stableUnit(&self.resolver, unit) {
        let covered = List<FrontierCoverage>.asSlice(&self.frontierCoverage)
        let mut cover = usize.ZERO
        while cover < covered.length {
          if same(Bytes.asSlice(&covered[cover].stable), Bytes.asSlice(&stable))
            && sameDeclarations(List<DeclarationId>.asSlice(&covered[cover].concrete), concrete) {
            return DeclarationCheckResult {rejections: List<Shared<Rejection>>.make(), gaps: List<Shared<BackendGap>>.make(),
              unchecked: List<UncheckedDeclaration>.make()}
          }
          cover = cover + usize.ONE
        }
      }
    }
'''+needle
assert s.count(needle)==1;s=s.replace(needle,replacement)
needle='''      let lowered = run Semantic.escapeRootMir(&mut self.*, &mut request.*, declaration)
      if let Option<Shared<Result<Answer, NoRejection>>>.Some { value: rawAnswer } = move lowered {'''
replacement='''      if let Option<[*]mut u64>.Some {..} = &self.frontierClaims {
        let signature = run Semantic.demandSignatureOf(&mut self.*, &mut request.*, declaration)
        if run signatureStartsNoWalk(&signature) { continue }
        let identity = run Types.internDeclaration(DeclarationId.copy(declaration))
        let instance = run InstanceKey.named(&identity)
        let span = run authoredRequestSpan(&mut self.resolver, declaration, Span.make(usize.ZERO, usize.ZERO))
        run List<VisitOrigin>.append(&mut origins, VisitOrigin {parent: usize.MAX, position: List<ContentHash>.length(&capture.roots), requested: false})
        run List<ContentHash>.append(&mut capture.roots, run keyDigest(&instance, capture.patterns))
        run List<BackendVisit>.append(&mut pending, BackendVisit.Enter {key: move instance, edge: Edge.Direct,
          span: span, module: ModuleId.copy(DeclarationId.moduleId(declaration)), cleanup: Option<Interned<Type>>.none(),
          requester: Option<RelatedSite>.none()})
        continue
      }
'''+needle
assert s.count(needle)==1;s=s.replace(needle,replacement)
open(p,'w').write(s)
