from pathlib import Path
p=Path('/workspace/silk/.scratch/parallel-check-experiment/compiler/src/semantic/Semantic.silk');s=p.read_text()
# Canonical backend keys have already passed bounded region/type construction.
s=s.replace('Admission.enter(&mut admission, &application, move reaching)','Admission.enterCanonical(&mut admission, &application, move reaching)')
s=s.replace('Admission.enter(&mut admission, &application, Edge.copy(&edge))','Admission.enterCanonical(&mut admission, &application, Edge.copy(&edge))')
s=s.replace('Admission.enter(&mut admission, &run InstanceKey.selected(key), Edge.Direct)','Admission.enterCanonical(&mut admission, &run InstanceKey.selected(key), Edge.Direct)')
s=s.replace('Admission.enter(&mut draft.admission, &application, Edge.copy(&edge))','Admission.enterCanonical(&mut draft.admission, &application, Edge.copy(&edge))')
# Raw source producer applications retain bounded canonicalization and report resources honestly.
s=s.replace('''        Decision.Open => {}
        Decision.Entered => {}''','''        Decision.Open => {}
        Decision.NotProven {..} => { return Option<OriginRefusal>.some(OriginRefusal.Bounded {module: ModuleId.copy(DeclarationId.moduleId(Application.bodyDeclaration(application)))}) }
        Decision.Entered => {}''',1)
a=s.index('effect fn gatherOriginProducer(');b=s.index('\n  let previous =',a)
section=s[a:b].replace('''    Decision.Open => {}''','''    Decision.Open => {}
    Decision.NotProven {..} => { return Option<Shared<Rejection>>.some(run reject(&resolver.*, module, RejectionCode.Undetermined, span)) }''',1);s=s[:a]+section+s[b:]
a=s.index('effect fn gatherOpaqueProducer(');b=s.index('\n  let previous =',a)
section=s[a:b].replace('''    Decision.Open => { return Option<Shared<Rejection>>.some(run reject(&resolver.*, module, RejectionCode.Undetermined, incoming)) }''','''    Decision.Open => { return Option<Shared<Rejection>>.some(run reject(&resolver.*, module, RejectionCode.Undetermined, incoming)) }
    Decision.NotProven {..} => { return Option<Shared<Rejection>>.some(run reject(&resolver.*, module, RejectionCode.Undetermined, incoming)) }''',1);s=s[:a]+section+s[b:]
# Runtime walkers: this case is unreachable for canonical keys but must remain conservative.
a=s.index('  effect fn capturedEscapes(');b=s.index('\n    let mut escapes =',a)
section=s[a:b].replace('''          Decision.Open => {''','''          Decision.NotProven {..} => {
            capture.unreplayable = true
            run List<Shared<Rejection>>.append(&mut result.rejections, run canonicalRejection(&mut self.resolver,
              &DeclarationId.copyShared(&InstanceKey.identity(&instance)), entered.span))
            continue
          }
          Decision.Open => {''',1);s=s[:a]+section+s[b:]
a=s.index('  pub effect fn demandApplicationMir(');b=s.index('\n    // Every region pattern',a)
section=s[a:b].replace('''    let open = match move admitted { Decision.Open => true _ => false }''','''    let open = match &admitted { Decision.Open => true _ => false }
    if let Decision.NotProven {..} = move admitted {
      return run Shared<Result<Answer, NoRejection>>.make(Result<Answer, NoRejection>.succeed(run memberRejected(
        run canonicalRejection(&mut self.resolver, declaredModule, span), List<Dependency>.make())))
    }''',1);s=s[:a]+section+s[b:]
a=s.index('Admission.enterCanonical(&mut admission, &application, move reaching)',s.index('  pub effect fn demandApplicationMir('));b=s.index('          }\n        }',a)
section=s[a:b].replace('''            Decision.Open => {''','''            Decision.NotProven {..} => {
              run List<Shared<Rejection>>.append(&mut refusals, run canonicalRejection(&mut self.resolver,
                &DeclarationId.copyShared(&InstanceKey.identity(&instance)), entered.span))
              continue
            }
            Decision.Open => {''',1);s=s[:a]+section+s[b:]
a=s.index('effect fn enterChainNode(');b=s.index('\n  let known =',a)
section=s[a:b].replace('''    Decision.Open => {''','''    Decision.NotProven {..} => { return Option<StaticClosure>.some(StaticClosure.NotProven {
      diagnostic: run canonicalRejection(&mut semantic.*.resolver, Application.bodyDeclaration(&application), span)}) }
    Decision.Open => {''',1);s=s[:a]+section+s[b:]
p.write_text(s)
