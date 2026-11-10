from pathlib import Path
p=Path('/workspace/silk/.scratch/parallel-check-experiment/compiler/src/semantic/Semantic.silk');s=p.read_text()
s=s.replace('    self.specializationBudget = SpecializationBudget.make()\n    self.frontierCoverage','    SpecializationBudget.clear(&mut self.specializationBudget)\n    self.frontierCoverage')
pos=s.index('  effect fn includeInstanceBudget(')
helper='''  effect fn specializationBudgetRejectionAt(self: &Self, module: &ModuleId, span: Span) -> Shared<Rejection>
  ! OutOfMemoryError ? &mut Allocator {
    let mut diagnostic = run Rejections.make(RejectionCode.SpecializationBudget, module, span)
    run List<MessageArgument>.append(&mut diagnostic.arguments, MessageArgument {name: run Bytes.copy(b"template"), value: run Bytes.copy(b"2")})
    let mut limit = run decimalText(SpecializationBudget.failureLimit(&self.specializationBudget))
    run Bytes.append(&mut limit, b" ")
    run Bytes.append(&mut limit, SpecializationBudget.failureResource(&self.specializationBudget))
    run List<MessageArgument>.append(&mut diagnostic.arguments, MessageArgument {name: run Bytes.copy(b"limit"), value: move limit})
    return run Shared<Rejection>.make(move diagnostic)
  }

  effect fn specializationBudgetRejection(self: &mut Self, owner: &DeclarationId, span: Span) -> Shared<Rejection>
  ! Cycle | InvalidModulePath | OutOfMemoryError ? &mut Allocator | &mut Types {
    let anchor = run authoredRequestSpan(&mut self.resolver, owner, span)
    return run Semantic.specializationBudgetRejectionAt(&self.*, DeclarationId.moduleId(owner), anchor)
  }

  effect fn specializationBudgetCheckResult(self: &mut Self, module: usize, concrete: &[DeclarationId]) -> DeclarationCheckResult
  ! Cycle | InvalidModulePath | OutOfMemoryError ? &mut Allocator | &mut Types {
    let diagnostic = if concrete.length > usize.ZERO {
      run Semantic.specializationBudgetRejection(&mut self.*, &concrete[usize.ZERO], Span.make(usize.ZERO, usize.ZERO))
    } else {
      run Semantic.specializationBudgetRejectionAt(&self.*, &resolvedModule(&self.resolver, module), Span.make(usize.ZERO, usize.ZERO))
    }
    let mut rejections = List<Shared<Rejection>>.make()
    run List<Shared<Rejection>>.append(&mut rejections, move diagnostic)
    return DeclarationCheckResult {rejections: move rejections, gaps: List<Shared<BackendGap>>.make(), unchecked: List<UncheckedDeclaration>.make()}
  }

'''
s=s[:pos]+helper+s[pos:]
# Only actual command-budget exhaustion uses this diagnostic; canonicalization failures retain
# their separate NotProven path until the producer supplies its specific failure reason.
for start,end in [('  pub effect fn demandApplicationMir(', '  /// Demands MIR for one exact reached instance'),('  pub effect fn demandInstanceMir(', '  /// Source-validates one instance')]:
 a=s.index(start);b=s.index(end,a);section=s[a:b]
 # Replace precisely the bodies immediately following the include calls.
 lines=section.splitlines();inside=False
 for i,line in enumerate(lines):
  if 'if !run Semantic.includeInstanceBudget' in line or 'if !run Semantic.includeAnswerBudget' in line:inside=True
  elif inside and 'run canonicalRejection(&mut self.resolver,' in line:
   lines[i]=line.replace('run canonicalRejection(&mut self.resolver,','run Semantic.specializationBudgetRejection(&mut self.*,')
   inside=False
 section='\n'.join(lines)+'\n';s=s[:a]+section+s[b:]
# Current in-process records still contribute after revision/profile budget reset. A memo with
# no complete record falls back to live traversal rather than silently avoiding accounting.
needle='''        let kept = List<EscapeMemo>.asSlice(&self.escapeMemos)
        return run copyCheckResult(&kept[found].result)'''
replacement='''        let kept = List<EscapeMemo>.asSlice(&self.escapeMemos)
        let mut accounted = false
        if let Option<CapturedBuild>.Some {value: capture} = &kept[found].captured {
          accounted = run WalkFragments.includeBudget(&mut self.specializationBudget, &capture.record)
        }
        if accounted { return run copyCheckResult(&kept[found].result) }
        if SpecializationBudget.exhausted(&self.specializationBudget) {
          return run Semantic.specializationBudgetCheckResult(&mut self.*, module, concrete)
        }'''
assert needle in s;s=s.replace(needle,replacement,1)
# A successful replay's capture is the current reached graph, unlike the superseded input record.
needle='''      let EscapeReplay {captured, result} = move replay
      run List<EscapeMemo>.append'''
replacement='''      let EscapeReplay {captured, result} = move replay
      if !run WalkFragments.includeBudget(&mut self.specializationBudget, &captured.record) {
        if SpecializationBudget.exhausted(&self.specializationBudget) {
          return Option<DeclarationCheckResult>.some(run Semantic.specializationBudgetCheckResult(&mut self.*, module, concrete))
        }
        return Option<DeclarationCheckResult>.none()
      }
      run List<EscapeMemo>.append'''
assert needle in s;s=s.replace(needle,replacement,1)
# Both successful build-record paths must join the same command budget before returning text.
needle='''    if let BackendBuild.Module {..} = &assembled {
      self.capturedBuild = Option<CapturedBuild>.some(CapturedBuild {record: Intrinsic.replace(state.record'''
replacement='''    if let BackendBuild.Module {..} = &assembled {
      if !run WalkFragments.includeBudget(&mut self.specializationBudget, &state.record) {
        if SpecializationBudget.exhausted(&self.specializationBudget) {
          return Option<BackendBuild>.some(refusedBuild(run Semantic.specializationBudgetRejectionAt(&self.*, module, entrySpan)))
        }
        return Option<BackendBuild>.none()
      }
      self.capturedBuild = Option<CapturedBuild>.some(CapturedBuild {record: Intrinsic.replace(state.record'''
assert needle in s;s=s.replace(needle,replacement,1)
needle='''    if let BackendBuild.Module {..} = &assembled {
      self.capturedBuild = Option<CapturedBuild>.some(CapturedBuild {record: move rewritten'''
replacement='''    if let BackendBuild.Module {..} = &assembled {
      if !run WalkFragments.includeBudget(&mut self.specializationBudget, &rewritten) {
        if SpecializationBudget.exhausted(&self.specializationBudget) {
          return Option<BackendBuild>.some(refusedBuild(run Semantic.specializationBudgetRejectionAt(&self.*, module, entrySpan)))
        }
        return Option<BackendBuild>.none()
      }
      self.capturedBuild = Option<CapturedBuild>.some(CapturedBuild {record: move rewritten'''
assert needle in s;s=s.replace(needle,replacement,1)
p.write_text(s)
