from pathlib import Path
root=Path('/workspace/silk/.scratch/dwarf-runtime-names/compiler/src')
p=root/'semantic/TypeText.silk'
s=p.read_text()
s=s.replace('import semantic.DeclarationId {DeclarationId}', 'import semantic.DeclarationId {DeclarationId, OwnerStep}')
s=s.replace('import semantic.ModuleId {ModuleId}', 'import semantic.ModuleId {InvalidModulePath, ModuleId}')
s=s.replace('import silk.core.option {Option}', 'import silk.core.option {Option}\nimport silk.core.effect {Effect}\nimport silk.testing.testing {AssertionError, Testing}')
s=s.replace('ty, false, &mut names, viewer','ty, Spelling.Exact, &mut names, viewer')
s=s.replace('ty, true, &mut names, viewer','ty, Spelling.Elided, &mut names, viewer')
s=s.replace('ty, true, &mut names.*, viewer','ty, Spelling.Elided, &mut names.*, viewer')
s=s.replace('expected, true, &mut names.*, viewer','expected, Spelling.Elided, &mut names.*, viewer')
s=s.replace('actual, true, &mut names.*, viewer','actual, Spelling.Elided, &mut names.*, viewer')
anchor='/// As `displayElided`, spelling a type parameter by its entry in `names`.'
at=s.index(anchor)
s=s[:at]+'''/// The spelling of a runtime representation, with every lifetime elided, including `'static`.
/// Shared machine code has one debug type regardless of which semantic lifetime representative
/// was checked first. None when the type has no supported spelling.
pub effect fn displayRuntime(ty: &Interned<Type>, viewer: &ModuleId) -> Option<Bytes> ! OutOfMemoryError ? &mut Allocator {
  let mut output = Bytes.make()
  let mut names = List<Named>.make()
  if !run append(&mut output, ty, Spelling.Runtime, &mut names, viewer) { return Option<Bytes>.none() }
  return Option<Bytes>.some(move output)
}

'''+s[at:]
s=s.replace("// Appends the spelling of `ty`; false when it has no exactly reproducible spelling. `loose`\n// writes a lifetime other than `'static` as elided instead of refusing.",'''enum Spelling { Exact, Elided, Runtime }

// Appends the selected spelling recursively. Diagnostic elision preserves `'static`; runtime
// representation names erase every lifetime in both containers and nominal arguments.''')
s=s.replace('ty: &Interned<Type>, loose: bool, names:', 'ty: &Interned<Type>, spelling: Spelling, names:')
s=s.replace('arguments: &[Argument], loose: bool,', 'arguments: &[Argument], spelling: Spelling,')
s=s.replace('  let copied = run Type.copy(ty)', '  let loose = spelling != Spelling.Exact\n  let copied = run Type.copy(ty)')
s=s.replace('  let count = DeclarationId.ownerCount(declaration)', '  let loose = spelling != Spelling.Exact\n  let count = DeclarationId.ownerCount(declaration)')
s=s.replace(', loose, &mut names.*, viewer)', ', spelling, &mut names.*, viewer)')
s=s.replace('if staticLifetime(&lifetime)', 'if spelling != Spelling.Runtime && staticLifetime(&lifetime)')
s=s.replace('if staticLifetime(&value)', 'if spelling != Spelling.Runtime && staticLifetime(&value)')
s+='''

// Construct one nested nominal whose explicit lifetime, reference, slice and string all carry
// the chosen region. Each is observable in diagnostic spelling and erased in representation names.
effect fn runtimeTextFixture(owner: &DeclarationId, region: &Interned<Lifetime>) -> Interned<Type>
! OutOfMemoryError ? &mut Allocator {
  let text = run Interned<Type>.make(Type.String {lifetime: Interned<Lifetime>.clone(region)})
  let slice = run Interned<Type>.make(Type.Slice {element: move text, access: Access.Shared,
    lifetime: Interned<Lifetime>.clone(region)})
  let reference = run Interned<Type>.make(Type.Reference {referent: move slice, access: Access.Shared,
    lifetime: Interned<Lifetime>.clone(region)})
  let mut arguments = List<Argument>.make()
  run List<Argument>.append(&mut arguments, Argument.Lifetime {value: Interned<Lifetime>.clone(region)})
  run List<Argument>.append(&mut arguments, Argument.Type {value: move reference})
  return run Interned<Type>.make(Type.Nominal {declaration: DeclarationId.copy(owner), isPublic: true, arguments: move arguments})
}

fn textIs(value: &Option<Bytes>, expected: &[u8]) -> bool {
  return match &value.* { Option<Bytes>.Some {value: text} => same(Bytes.asSlice(&text), expected) _ => false }
}

effect fn runtimeTextClaims() -> () ! InvalidModulePath | OutOfMemoryError | AssertionError<'static> ? &mut Allocator {
  let module = run ModuleId.make(b"test", b"test", b"sample.silk")
  let mut owners = List<OwnerStep>.make()
  run List<OwnerStep>.append(&mut owners, OwnerStep {kind: OwnerKind.Struct,
    name: Option<Bytes>.some(run Bytes.copy(b"Wrapper")), occurrence: usize.ZERO})
  let owner = run DeclarationId.fromParts(ModuleId.copy(&module), move owners)
  let staticRegion = run Interned<Lifetime>.make(Lifetime.Static)
  let suppliedRegion = run Interned<Lifetime>.make(Lifetime.Supplied {ordinal: 7})
  let first = run runtimeTextFixture(&owner, &staticRegion)
  let second = run runtimeTextFixture(&owner, &suppliedRegion)
  let staticRuntime = run displayRuntime(&first, &module)
  let suppliedRuntime = run displayRuntime(&second, &module)
  run Testing.expect(textIs(&staticRuntime, b"sample.Wrapper<'_, &&[string]>"), "runtime names erase nested static lifetime evidence")
  run Testing.expect(textIs(&suppliedRuntime, b"sample.Wrapper<'_, &&[string]>"), "runtime names are independent of the first lifetime representative")
  let staticDiagnostic = run displayElided(&first, &module)
  let suppliedDiagnostic = run displayElided(&second, &module)
  run Testing.expect(textIs(&staticDiagnostic, b"sample.Wrapper<'static, &'static &'static [string<'static>]>"),
    "diagnostic elision keeps static lifetime evidence")
  run Testing.expect(textIs(&suppliedDiagnostic, b"sample.Wrapper<'_, &&[string]>"), "diagnostic elision still hides supplied lifetimes")
}

test effect fn runtimeTypeNamesEraseAllLifetimesWithoutChangingDiagnostics() -> ()
! InvalidModulePath | OutOfMemoryError | AssertionError<'static> {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run runtimeTextClaims() |> Effect.provideMut<Allocator>(&mut allocator)
}
'''
p.write_text(s)
p=root/'backend/LlvmCode.silk'
s=p.read_text().replace('run TypeText.displayElided(ty, viewer)', 'run TypeText.displayRuntime(ty, viewer)')
s=s.replace('// in all. Fields are named by their index.','''// in all. Fields are named by their index. Names erase every lifetime, as the runtime layout
// lookup does, including names reached through layout fields, slice elements and pointees.''')
p.write_text(s)
