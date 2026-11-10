from pathlib import Path
root=Path('/workspace/silk/.scratch/zero-storage-abi/compiler/src/backend')
def segment(s,start,end,fn):
 a=s.index(start);b=s.index(end,a);return s[:a]+fn(s[a:b])+s[b:]
p=root/'WasmLower.silk';s=p.read_text().replace('  Callable,\n','  Callable,\n  OutcomeStorage,\n')
def ordinary_call(t):
 t=t.replace('  let kind = output.representation\n','  let kind = output.representation\n  let resultFacts = run layoutOf(layouts, &output.ty, function, span)\n  let mut failureFacts = Option<Metrics>.none()\n')
 t=t.replace('    failed = Option<Address>.some(run emitPlace(&mut writer.*, function, target, layouts, &edge.destination))','''    let failureSlot = run emitPlace(&mut writer.*, function, target, layouts, &edge.destination)
    failureFacts = Option<Metrics>.some(run layoutOf(layouts, &failureSlot.ty, function, span))
    failed = Option<Address>.some(move failureSlot)''')
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
s=segment(s,'effect fn emitChecked(', '\n// The symbol',definition)
s=segment(s,'effect fn emitReturn(', '\n// ',lambda t:t.replace('  if kind.unit {','  if resultLayout.size == usize.ZERO {',1))
s=segment(s,'effect fn emitFail(', '\n// ',lambda t:t.replace('  if !kind.unit {','  if failureLayout.size != usize.ZERO {',1))
p.write_text(s)
for name in ['LlvmCode.silk','WasmLower.silk']:
 p=root/name;s=p.read_text();none='Bitcode.none()' if name=='LlvmCode.silk' else 'none()'
 # One shared, layout-derived storage plan replaces the old fallibility-based result pointer rule.
 a=s.index('effect fn takesResult(');b=s.index('// The `$enter` signature:',a)
 s=s[:a]+s[b:]
 s=s.replace('layouts: &TypeLayouts, takes: bool)\n', 'layouts: &TypeLayouts, storage: OutcomeStorage)\n')
 s=s.replace('LoweringPlan.enterShape(LoweringPlan.callable(function), takes)', 'LoweringPlan.enterShape(LoweringPlan.callable(function), storage)')
 s=s.replace('  let takes = run takesResult(function, target, layouts)', '  let storage = run LoweringPlan.functionOutcomes(function, layouts)')
 s=s.replace('enterSignature(&mut writer.*, function, target, layouts, takes)', 'enterSignature(&mut writer.*, function, target, layouts, storage)')
 s=s.replace('if takes { run storeWordAt(&mut writer.*, hidden[0], frame, Coroutine.outOffset(word)) }', 'if storage.result { run storeWordAt(&mut writer.*, hidden[0], frame, Coroutine.outOffset(word)) }')
 old='''  if fallible {
    run storeWordAt(&mut writer.*, hidden[1], frame, Coroutine.failOffset(word))
    if observed { run storeWordAt(&mut writer.*, hidden[2], frame, Coroutine.contextOffset(word)) }
  }'''
 new='''  if storage.failure { run storeWordAt(&mut writer.*, hidden[1], frame, Coroutine.failOffset(word)) }
  if fallible && observed { run storeWordAt(&mut writer.*, hidden[2], frame, Coroutine.contextOffset(word)) }'''
 assert old in s,(name,'enter stores');s=s.replace(old,new)
 def step(t):
  t=t.replace('  if run takesResult(function, target, layouts) {', '  let storage = run LoweringPlan.functionOutcomes(function, layouts)\n  if storage.result {')
  if name=='LlvmCode.silk':
   old='''  if fallible {
    writer.failure = run loadHidden(&mut writer.*, hiddenName(b"fail"), Coroutine.failOffset(word))
    if observed { writer.context = run loadHidden(&mut writer.*, hiddenName(b"context"), Coroutine.contextOffset(word)) }
  }'''
   new='''  if storage.failure { writer.failure = run loadHidden(&mut writer.*, hiddenName(b"fail"), Coroutine.failOffset(word)) }
  if fallible && observed { writer.context = run loadHidden(&mut writer.*, hiddenName(b"context"), Coroutine.contextOffset(word)) }'''
  else:
   old='''  if fallible {
    writer.failure = run loadHidden(&mut writer.*, Coroutine.failOffset(word))
    if observed { writer.context = run loadHidden(&mut writer.*, Coroutine.contextOffset(word)) }
  }'''
   new='''  if storage.failure { writer.failure = run loadHidden(&mut writer.*, Coroutine.failOffset(word)) }
  if fallible && observed { writer.context = run loadHidden(&mut writer.*, Coroutine.contextOffset(word)) }'''
  assert old in t,(name,'step loads');return t.replace(old,new)
 s=segment(s,'effect fn emitStep(', '\n// ',step)
 old=f'''  if writer.failure != {none} {{
    run List<u64>.append(&mut arguments, writer.failure)
    if writer.context != {none} {{ run List<u64>.append(&mut arguments, writer.context) }}
  }}'''
 new=f'''  if writer.failure != {none} {{ run List<u64>.append(&mut arguments, writer.failure) }}
  // A zero-byte failure still carries an observed failure's diagnostic context.
  if writer.context != {none} {{ run List<u64>.append(&mut arguments, writer.context) }}'''
 assert old in s,(name,'callEnter');s=s.replace(old,new)
 s=segment(s,'effect fn emitStepReturn(', '\n// ',lambda t:t.replace('  if !kind.unit {','  if resultLayout.size != usize.ZERO {',1))
 s=segment(s,'effect fn emitStepFail(', '\n// ',lambda t:t.replace('  if !kind.unit {','  if failureLayout.size != usize.ZERO {',1))
 def suspending(t):
  t=t.replace('  let output = run emitPlace(&mut writer.*, function, target, layouts, destination)\n','''  let output = run emitPlace(&mut writer.*, function, target, layouts, destination)
  let resultFacts = run layoutOf(layouts, &output.ty, function, span)
  let mut failureFacts = Option<Metrics>.none()
''',1)
  t=t.replace('    failed = failureSlot.value\n','    failed = failureSlot.value\n    failureFacts = Option<Metrics>.some(run layoutOf(layouts, &failureSlot.ty, function, span))\n',1)
  t=t.replace(f'  let fallible = failed != {none}\n', '  let fallible = match &failure.* { Option<FailureEdge>.Some {..} => true _ => false }\n  let storage = LoweringPlan.outcomeStorage(resultFacts, move failureFacts)\n')
  t=t.replace('  if fallible || !output.representation.unit { run List<u64>.append(&mut passed, output.value) }', '  if storage.result { run List<u64>.append(&mut passed, output.value) }')
  old=f'''  if fallible {{
    run List<u64>.append(&mut passed, failed)
    if context != {none} {{ run List<u64>.append(&mut passed, context) }}
  }}'''
  new=f'''  if storage.failure {{ run List<u64>.append(&mut passed, failed) }}
  if fallible && context != {none} {{ run List<u64>.append(&mut passed, context) }}'''
  assert old in t,(name,'suspending arguments');return t.replace(old,new)
 s=segment(s,'effect fn emitSuspendingCall(', '\n// ',suspending)
 p.write_text(s)
