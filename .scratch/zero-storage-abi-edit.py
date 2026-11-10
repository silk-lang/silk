from pathlib import Path
root=Path('/workspace/silk/.scratch/zero-storage-abi/compiler/src/backend')
p=root/'LoweringPlan.silk';s=p.read_text()
anchor='/// The order of a function\'s lanes.\n'
insert='''/// Whether the source result and failure values have bytes to transport. A fallible call's
/// status and diagnostic context are independent of these payload lanes.
pub struct OutcomeStorage {
  pub result: bool,
  pub failure: bool,
}

impl Copy for OutcomeStorage {}

/// Selects payload lanes from complete target layout facts, including zero-sized records.
/// Representation.size is not suitable here: scalar representations need not store their size.
pub fn outcomeStorage(result: Metrics, failure: Option<Metrics>) -> OutcomeStorage {
  return OutcomeStorage {result: result.size != usize.ZERO,
    failure: match failure { Option<Metrics>.Some {value} => value.size != usize.ZERO _ => false }}
}

/// The payload storage required by an ordinary definition or its coroutine entry.
pub effect fn functionOutcomes(function: &MirFunction, layouts: &TypeLayouts) -> OutcomeStorage
! Gap | OutOfMemoryError ? &mut Allocator | &mut Types {
  let locals = List<Local>.asSlice(&function.locals)
  let result = run layoutOf(layouts, &function.result, function, locals[usize.ZERO].origin.location)
  let failed = failureLocal(function)
  let mut failure = Option<Metrics>.none()
  if failed != usize.MAX {
    failure = Option<Metrics>.some(run layoutOf(layouts, &locals[failed].ty, function, locals[failed].origin.location))
  }
  return outcomeStorage(result, move failure)
}

'''
assert anchor in s;s=s.replace(anchor,insert+anchor)
s=s.replace('ordinaryShape(facts: Callable, outward: bool)', 'ordinaryShape(facts: Callable, outward: bool, storage: OutcomeStorage)')
s=s.replace('if outward && !facts.fallible {', 'if outward && !facts.fallible && storage.result {')
s=s.replace('    run List<Lane>.append(&mut lanes, Lane.Result)\n    run appendFailure(&mut lanes, facts)', '    if storage.result { run List<Lane>.append(&mut lanes, Lane.Result) }\n    run appendFailure(&mut lanes, facts, storage)')
s=s.replace('enterShape(facts: Callable, takes: bool)', 'enterShape(facts: Callable, storage: OutcomeStorage)')
s=s.replace('if takes { run List<Lane>.append(&mut lanes, Lane.Result) }', 'if storage.result { run List<Lane>.append(&mut lanes, Lane.Result) }')
s=s.replace('if facts.fallible { run appendFailure(&mut lanes, facts) }', 'if facts.fallible { run appendFailure(&mut lanes, facts, storage) }')
s=s.replace('appendFailure(lanes: &mut List<Lane>, facts: Callable)', 'appendFailure(lanes: &mut List<Lane>, facts: Callable, storage: OutcomeStorage)')
s=s.replace('  run List<Lane>.append(&mut lanes.*, Lane.Failure)\n', '  if storage.failure { run List<Lane>.append(&mut lanes.*, Lane.Failure) }\n')
p.write_text(s)

def segment(s,start,end,fn):
 a=s.index(start);b=s.index(end,a);return s[:a]+fn(s[a:b])+s[b:]
for filename in ['LlvmCode.silk','WasmLower.silk']:
 p=root/filename;s=p.read_text();none='Bitcode.none()' if filename=='LlvmCode.silk' else 'none()'
 s=s.replace('  Callable,\n','  Callable,\n  OutcomeStorage,\n')
 def ordinary_call(t):
  t=t.replace('  let kind = output.representation\n','  let kind = output.representation\n  let resultFacts = run layoutOf(layouts, &output.ty, function, span)\n  let mut failureFacts = Option<Metrics>.none()\n')
  old='    failed = Option<Address>.some(run emitPlace(&mut writer.*, function, target, layouts, &edge.destination))'
  new='''    let failureSlot = run emitPlace(&mut writer.*, function, target, layouts, &edge.destination)
    failureFacts = Option<Metrics>.some(run layoutOf(layouts, &failureSlot.ty, function, span))
    failed = Option<Address>.some(move failureSlot)'''
  assert old in t;t=t.replace(old,new)
  t=t.replace('  let fallible = handler != usize.MAX\n','  let fallible = handler != usize.MAX\n  let storage = LoweringPlan.outcomeStorage(resultFacts, move failureFacts)\n')
  t=t.replace('} else if !outward {','} else if !outward && storage.result {')
  t=t.replace('LoweringPlan.ordinaryShape(facts, outward)', 'LoweringPlan.ordinaryShape(facts, outward, storage)')
  t=t.replace('if !kind.unit && !outward {','if storage.result && !outward {')
  return t
 s=segment(s,'effect fn emitCallInner(', '\n// ',ordinary_call)
 def definition(t):
  t=t.replace('  let pointer = run pointerType(&mut writer)\n', '''  let storage = if exported { OutcomeStorage {result: true, failure: true} }
    else { run LoweringPlan.functionOutcomes(function, layouts) }
  let pointer = run pointerType(&mut writer)
''',1)
  t=t.replace('} else if !outward {','} else if !outward && storage.result {')
  t=t.replace('LoweringPlan.ordinaryShape(LoweringPlan.callable(function), outward)', 'LoweringPlan.ordinaryShape(LoweringPlan.callable(function), outward, storage)')
  return t
 # The exported top-level LLVM function is named emit; target only the unique resultFacts region.
 start=s.index('  let resultFacts = run layoutOf(layouts, &function.result, function, locals[usize.ZERO].origin.location)',s.index('effect fn beginFunction(') if filename=='LlvmCode.silk' else s.index('effect fn emitChecked('))
 end=s.index('\n  let mut functionAttributes',start) if filename=='LlvmCode.silk' else s.index('\n  let mut open',start) if '\n  let mut open' in s[start:] else -1
 # Finish the edited signature block at the first suspension/body setup following parameter lanes.
 if filename=='WasmLower.silk':end=s.index('\n  let mut stepping',start) if '\n  let mut stepping' in s[start:] else s.index('\n  let suspended',start)
 s=s[:start]+definition(s[start:end])+s[end:]
 s=segment(s,'effect fn emitReturn(', '\n// ',lambda t:t.replace('  if kind.unit {','  if resultLayout.size == usize.ZERO {',1))
 s=segment(s,'effect fn emitFail(', '\n// ',lambda t:t.replace('  if !kind.unit {','  if failureLayout.size != usize.ZERO {',1))
 p.write_text(s)
