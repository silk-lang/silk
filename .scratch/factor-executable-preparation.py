from pathlib import Path
p=Path('/workspace/silk/.scratch/executable-specialization-preparation/compiler/src/semantic/Semantic.silk');s=p.read_text()
# Pure signature prefilter shared by certificate construction and already-observed consumers.
start=s.index('  let facts = match move Shared<Result<Answer, NoRejection>>.with<Option<SignatureFacts>>(&signature, signatureFacts)',s.index('effect fn classifyExecutableDeclaration'))
end=s.index('  let written = match move run header',start)
shape=s[start:end]
shape=shape.replace('  units[0] = u64.toUsize((run internKey(&mut resolver.*, signatureKey)).value)\n','').replace('Option<ExecutableDeclaration>.none()', 'Option<ExecutableSchema>.none()').replace('&signature','signature')
helper='''// A negative shape is proved by the Signature answer the caller has already observed.
// It needs neither a second query demand nor declaration-certificate lookup/replayed edges.
fn executableSignatureSchema(signature: &Shared<Result<Answer, NoRejection>>) -> Option<ExecutableSchema> {
'''+shape+'''  return Option<ExecutableSchema>.some(expected)
}

'''
s=s[:start]+'''  units[0] = u64.toUsize((run internKey(&mut resolver.*, signatureKey)).value)
  let expected = match move executableSignatureSchema(&signature) {
    Option<ExecutableSchema>.Some {value} => value
    _ => { return Option<ExecutableDeclaration>.none() }
  }
  let facts = match move Shared<Result<Answer, NoRejection>>.with<Option<SignatureFacts>>(&signature, signatureFacts) {
    Option<SignatureFacts>.Some {value} => move value
    _ => { return Option<ExecutableDeclaration>.none() }
  }
'''+s[end:]
pos=s.index('effect fn classifyExecutableDeclaration');s=s[:pos]+helper+s[pos:]
s=s.replace('''  units: &mut [usize]) -> Option<ExecutableDeclaration>
''','''  units: &mut [usize], observedSignature: &Option<Shared<Result<Answer, NoRejection>>>) -> Option<ExecutableDeclaration>
''',1)
old='''  let signature = run demandChild(&mut resolver.*, &mut owner.*, &mut dependencies.*, signatureKey, Span.make(usize.ZERO, usize.ZERO))'''
new='''  let signature = match &observedSignature.* {
    Option<Shared<Result<Answer, NoRejection>>>.Some {value} => Shared<Result<Answer, NoRejection>>.clone(&value)
    _ => run demandChild(&mut resolver.*, &mut owner.*, &mut dependencies.*, signatureKey, Span.make(usize.ZERO, usize.ZERO))
  }'''
assert old in s;s=s.replace(old,new,1)
s=s.replace('''  dependencies: &mut List<Dependency>, logical: &InstanceKey, observing: bool) -> Option<ExecutablePreparation>
''','''  dependencies: &mut List<Dependency>, logical: &InstanceKey, observing: bool,
  observedSignature: &Option<Shared<Result<Answer, NoRejection>>>) -> Option<ExecutablePreparation>
''',1)
needle='''  if !executableSpecialization() || resolver.revisable || resolver.direct { return Option<ExecutablePreparation>.none() }
'''
replace=needle+'''  let mut signatureObserved = false
  if let Option<Shared<Result<Answer, NoRejection>>>.Some {value} = &observedSignature.* {
    signatureObserved = true
    if let Option<ExecutableSchema>.None = move executableSignatureSchema(&value) {
      return Option<ExecutablePreparation>.none()
    }
  }
''';assert s.count(needle)==1;s=s.replace(needle,replace)
s=s.replace('''          if units[at] != usize.MAX { run Graph.record(&mut resolver.graph, parent, Dependee.UnitResult {unit: units[at]}) }
''','''          if units[at] != usize.MAX && !(at == usize.ZERO && signatureObserved) {
            run Graph.record(&mut resolver.graph, parent, Dependee.UnitResult {unit: units[at]})
          }
''',1)
s=s.replace('''    &identity, location, &mut units)
''','''    &identity, location, &mut units, observedSignature)
''',1)
# lowerMir already demanded exactly this declaration's signature in the active dependency scope.
needle='''  if let Option<ExecutablePreparation>.Some {value: executable} = move run executablePreparation(&mut resolver.*, &mut owner.*,
    &mut dependencies, &instance, observing) {'''
replace='''  let executableSignature = Option<Shared<Result<Answer, NoRejection>>>.some(Shared<Result<Answer, NoRejection>>.clone(&signature))
  if let Option<ExecutablePreparation>.Some {value: executable} = move run executablePreparation(&mut resolver.*, &mut owner.*,
    &mut dependencies, &instance, observing, &executableSignature) {''';assert needle in s;s=s.replace(needle,replace)
# Replace duplicate identity/signature passes with one recipe-order traversal.
start=s.index('effect fn emissionSignatureContent(');end=s.index('// One callee declaration',start)
old=s[start:end]
new=old.replace('effect fn emissionSignatureContent(','''struct EmissionRecipeContent {
  encoded: List<Bytes>,
  signatures: Bytes,
  executable: bool,
}

effect fn emissionRecipeContent(''',1)
new=new.replace('''  callees: &[InstanceKey],
''','''  recipe: &InstanceRecipe,
''',1)
new=new.replace('''  digesting: bool,
) -> Bytes''','''  digesting: bool,
  observing: bool,
  ownExecutableAllowed: bool,
) -> EmissionRecipeContent''',1)
new=new.replace('''  let mut result = Bytes.make()
  let mut at = usize.ZERO''','''  let mut result = Bytes.make()
  let mut encoded = List<Bytes>.make()
  let mut executable = false
  let mut own = Option<ExecutablePreparation>.none()
  if ownExecutableAllowed {
    own = run executablePreparation(&mut resolver.*, &mut owner.*, &mut dependencies.*, &recipe.key, observing,
      &Option<Shared<Result<Answer, NoRejection>>>.none())
  }
  match move own {
    Option<ExecutablePreparation>.Some {value} => {
      run List<Bytes>.append(&mut encoded, move value.encoding)
      executable = true
    }
    _ => { run List<Bytes>.append(&mut encoded, run InstanceKey.encodingAt(&recipe.key, &mut coordinates.*)) }
  }
  let callees = List<InstanceKey>.asSlice(&recipe.callees)
  let keepEvidence = recording(&resolver.*)
  let mut at = usize.ZERO''',1)
new=new.replace('''  while at < callees.length {
    if let InstanceKey.Function''','''  while at < callees.length {
    let mut observedSignature = Option<Shared<Result<Answer, NoRejection>>>.none()
    if keepEvidence {
    if let InstanceKey.Function''',1)
needle='''        let identityHandle = InstanceKey.identity(&callees[at])'''
new=new.replace(needle,'''        observedSignature = Option<Shared<Result<Answer, NoRejection>>>.some(Shared<Result<Answer, NoRejection>>.clone(&signature))
'''+needle,1)
needle='''    at = at + usize.ONE
  }
  return move result
}'''
replacement='''    }
    let prepared = run executablePreparation(&mut resolver.*, &mut owner.*, &mut dependencies.*, &callees[at], observing,
      &observedSignature)
    match move prepared {
      Option<ExecutablePreparation>.Some {value} => { run List<Bytes>.append(&mut encoded, move value.encoding) }
      _ => { run List<Bytes>.append(&mut encoded, run InstanceKey.encodingAt(&callees[at], &mut coordinates.*)) }
    }
    at = at + usize.ONE
  }
  return EmissionRecipeContent {encoded: move encoded, signatures: move result, executable: executable}
}'''
assert new.count(needle)==1;new=new.replace(needle,replacement)
s=s[:start]+new+s[end:]
start=s.index('  let mut encoded = run InstanceText.encodings(&recipe, &mut coordinates)',s.index('effect fn resolveEmissionInputs'))
end=s.index('  let mut identity = Option<ContentHash>.none()',start)
replacement='''  // Preserve exact recipe keys and every signature/source guard. Choose executable identity
  // before serializing a logical key which would immediately be discarded for a certified body.
  let digesting = resolver.revisable
  let ownExecutableAllowed = match &suspension { Option<CoroutineFacts>.None => true _ => false }
  let prepared = run emissionRecipeContent(&mut resolver.*, &mut owner.*, &mut dependencies, &recipe, &mut coordinates,
    digesting, variantObserving, ownExecutableAllowed)
  let encoded = move prepared.encoded
  let signatures = move prepared.signatures
  let executableCertified = prepared.executable
  let identities = run InstanceText.identities(&recipe, List<Bytes>.asSlice(&encoded))
'''
s=s[:start]+replacement+s[end:]
p.write_text(s)
