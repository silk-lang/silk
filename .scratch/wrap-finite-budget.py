from pathlib import Path
import sys,re
sys.path.insert(0,'/workspace/silk/.scratch');from silk_edit_helpers import item_span
p=Path('compiler/src/semantic/WalkFragments.silk');s=p.read_text().replace('import silk.core.option {Option}','import silk.core.option {Option}\nimport silk.core.result {Result}')
pos=s.index('pub effect fn includeBudget(')
s=s[:pos]+'''pub effect fn includeBudget(budget: &mut Budget, record: &BuildRecord.Record) -> bool ! OutOfMemoryError ? &mut Allocator {
  let saved = Budget.checkpoint(&mut budget.*)
  let result = run Effect.result(includeBudgetEntries(&mut budget.*, record))
  return match move result {
    Result<bool, OutOfMemoryError>.Success {value} => {
      if value { Budget.commit(&mut budget.*, saved) }
      else { run Budget.rollback(&mut budget.*, saved) }
      return value
    }
    Result<bool, OutOfMemoryError>.Failure {error} => {
      run Budget.rollback(&mut budget.*, saved)
      fail move error
    }
  }
}

'''+s[pos:].replace('pub effect fn includeBudget(', 'effect fn includeBudgetEntries(',1)
p.write_text(s)
p=Path('compiler/src/semantic/Semantic.silk');s=p.read_text()
configs={
'replayBuild':('BackendBuild','&mut state.*, module, roots, entrySpan'),
'rewalkBuild':('BackendBuild','move state, module, roots, entrySpan'),
'replayEscapesWith':('EscapeReplay','&mut request.*, concrete, &mut record.*, recordRoot, previous, guard, inProcess, plain, &mut sited.*'),
'rewalkEscapes':('EscapeReplay','&mut request.*, concrete, boundary, record, previous, inProcess'),
'replayKept':('DeclarationCheckResult','&mut request.*, module, member, unit, concrete, boundary, recorded, recordRoot, previous, guard, inProcess'),
}
for name,(typ,args) in configs.items():
 a,b=item_span(s,r'^  effect fn '+name+r'\(');t=s[a:b];header=t[:t.index('{')+1]
 wrapper=header+f'''
    let saved = SpecializationBudget.checkpoint(&mut self.specializationBudget)
    let attempted = run Effect.result(Semantic.{name}Attempt(&mut self.*, {args}))
    let result = match move attempted {{
      Result<Option<{typ}>, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {{value}} => move value
      Result<Option<{typ}>, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Failure {{error}} => {{
        run SpecializationBudget.rollback(&mut self.specializationBudget, saved)
        fail move error
      }}
    }}
    if let Option<{typ}>.Some {{..}} = &result {{
      if !SpecializationBudget.exhausted(&self.specializationBudget) {{
        SpecializationBudget.commit(&mut self.specializationBudget, saved)
        return move result
      }}
    }}
    run SpecializationBudget.rollback(&mut self.specializationBudget, saved)
    return Option<{typ}>.none()
  }}

'''
 s=s[:a]+wrapper+t.replace('fn '+name+'(', 'fn '+name+'Attempt(',1)+s[b:]
p.write_text(s)
