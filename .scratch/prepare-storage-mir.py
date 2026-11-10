from pathlib import Path
root=Path('/workspace/silk/.scratch/shared-storage-helpers/compiler/src')
p=root/'semantic/Anchor.silk';s=p.read_text().replace('import silk.mem.shared {Shared}','import silk.mem.shared {Shared}\nimport silk.mem.allocator {Allocator, OutOfMemoryError}')
s=s.replace('impl Anchor {','''impl Anchor {
  /// An empty source projection for a compiler-generated body with generated-only origins.
  pub effect fn generated() -> Self ! OutOfMemoryError ? &mut Allocator {
    return Anchor {first: HirId {index: usize.ZERO}, token: usize.ZERO,
      locations: run Shared<SourceLocations>.make(run SourceLocations.make(&[], b""))}
  }
''',1);p.write_text(s)
p=root/'backend/Mir.silk';s=p.read_text().replace('import backend.InstanceKey {HelperRole, InstanceKey, NameOrder}','import backend.InstanceKey {HelperRole, InstanceKey, NameOrder, StorageShape}')
s=s.replace('import semantic.ModuleId {ModuleId}','import semantic.ModuleId {ModuleId, InvalidModulePath}')
s=s.replace('pub struct StoragePlan {\n  pub node: BodyNodeId,','''pub struct StoragePlan {
  pub node: BodyNodeId,
  /// A self-contained shared implementation, prepared only after typed storage validation.
  pub helper: Option<InstanceKey>,''',1)
# Reuse the exact existing builder state defaults, without the creator's semantic environment.
start=s.index('  return Builder {',s.index('effect fn helperBuilder('));end=s.index('\n}\n',start)
init=s[start:end]
init=init.replace('bindings: move bindings, projections: move projections,','bindings: List<Binding>.make(), projections: List<RuntimeProjection>.make(),')
init=init.replace('diagnostics: move diagnostics','diagnostics: Option<DiagnosticPlaces>.none()').replace('anchor: Anchor.copy(&creator.anchor)','anchor: run Anchor.generated()').replace('cancelEveryCall: cancellable','cancelEveryCall: false').replace('constants: run copyConstants(List<ConstantValue>.asSlice(&creator.constants))','constants: List<ConstantValue>.make()')
new='''// A generated storage implementation has no caller bindings, source variables, providers or
// diagnostic context. Range traps stay in the typed wrapper; resize only returns refusal.
effect fn storageBuilder(key: InstanceKey, result: &Interned<Type>, parameters: List<Interned<Type>>, origin: Origin)
  -> Builder ! OutOfMemoryError ? &mut Allocator | &mut Types {
  let mut locals = List<Local>.make()
  run List<Local>.append(&mut locals, Local {ty: Interned<Type>.clone(result), kind: LocalKind.Return, origin: origin})
  let listed = List<Interned<Type>>.asSlice(&parameters)
  let mut at = usize.ZERO
  while at < listed.length {
    run List<Local>.append(&mut locals, Local {ty: Interned<Type>.clone(&listed[at]),
      kind: LocalKind.Parameter {index: at}, origin: origin})
    at = at + usize.ONE
  }
'''+init+'\n}\n\n'
pos=s.index('// Lowers one erased package helper.');s=s[:pos]+new+s[pos:]
# Direct call primitive; record the edge before emitting the call.
pos=s.index('// `rawBufferResize<T>(buffer, count)`')
new='''// Invokes a sealed shared implementation through its ordinary MIR dependency. Its raw
// header address is borrowed only for this call; the typed wrapper keeps ownership of storage.
effect fn callStorageResize(builder: &mut Builder, key: &InstanceKey, buffer: &Place, requested: Operand,
  ty: &Interned<Type>, origin: Origin) -> Operand ! OutOfMemoryError ? &mut Allocator | &mut Types {
  let word = run storagePrimitive(b"usize")
  let address = run SealedCore.bytes()
  let bits = run storageValue(&mut builder.*, &word, Rvalue.AddressIntegerConversion {
    operand: Operand.Copy {place: run copyPlace(buffer)}, destinationType: Interned<Type>.clone(&word)}, origin)
  let pointer = run storageValue(&mut builder.*, &address, Rvalue.AddressIntegerConversion {
    operand: Operand.Copy {place: place(bits)}, destinationType: Interned<Type>.clone(&address)}, origin)
  let mut arguments = List<Operand>.make()
  run List<Operand>.append(&mut arguments, Operand.Copy {place: place(pointer)})
  run List<Operand>.append(&mut arguments, move requested)
  run List<Reference>.append(&mut builder.*.function.references,
    Reference {key: InstanceKey.copy(key), edge: Edge.Direct, origin: origin})
  let output = run temporary(&mut builder.*, ty, origin)
  let continuation = run block(&mut builder.*, origin)
  terminate(&mut builder.*, Terminator.Call {callee: Callee.Instance {key: InstanceKey.copy(key)}, arguments: move arguments,
    providers: List<Operand>.make(), diagnostics: Option<Diagnostics>.none(), destination: place(output),
    normal: continuation, failure: Option<FailureEdge>.none(), origin: origin})
  resume(&mut builder.*, continuation)
  return Operand.Copy {place: place(output)}
}

''';s=s[:pos]+new+s[pos:]
needle='''    StorageOperation.RawBufferResize => {
      return run lowerBufferResize(&mut builder.*, &plan, &first, List<Operand>.remove(&mut operands, usize.ZERO), ty, origin)
    }'''
s=s.replace(needle,'''    StorageOperation.RawBufferResize => {
      if let Option<InstanceKey>.Some {value: helper} = &plan.helper {
        return run callStorageResize(&mut builder.*, &helper, &first, List<Operand>.remove(&mut operands, usize.ZERO), ty, origin)
      }
      return run lowerBufferResize(&mut builder.*, &plan, &first, List<Operand>.remove(&mut operands, usize.ZERO), ty, origin)
    }''')
pos=s.index('  /// Makes one C export shim')
new='''  /// Builds a shared sealed resize implementation directly from its complete key. The typed
  /// caller already proved its storage contract; this body accesses only the fixed header.
  pub effect fn storageHelper(key: InstanceKey, shape: &StorageShape) -> MirFunction
  ! InvalidModulePath | OutOfMemoryError ? &mut Allocator | &mut Types {
    let origin = Origin {node: usize.ZERO, location: Location.generated()}
    let word = run storagePrimitive(b"usize")
    let address = run SealedCore.bytes()
    let result = run storagePrimitive(b"bool")
    let mut parameters = List<Interned<Type>>.make()
    run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&address))
    run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&word))
    let mut builder = run storageBuilder(move key, &result, move parameters, origin)
    let entry = run block(&mut builder, origin)
    resume(&mut builder, entry)
    let octet = run storagePrimitive(b"u8")
    let header = run SealedCore.applied(SealedCore.Core.RawBuffer, &octet)
    let headerPointer = run SealedCore.address(&header)
    let bits = run storageValue(&mut builder, &word, Rvalue.AddressIntegerConversion {
      operand: Operand.Copy {place: place(usize.ONE)}, destinationType: Interned<Type>.clone(&word)}, origin)
    let buffer = run storageValue(&mut builder, &headerPointer, Rvalue.AddressIntegerConversion {
      operand: Operand.Copy {place: place(bits)}, destinationType: Interned<Type>.clone(&headerPointer)}, origin)
    let mut externs = List<Interned<DeclarationId>>.make()
    let targets = List<Interned<DeclarationId>>.asSlice(&shape.externs)
    let mut at = usize.ZERO
    while at < targets.length {
      run List<Interned<DeclarationId>>.append(&mut externs, Interned<DeclarationId>.clone(&targets[at]))
      at = at + usize.ONE
    }
    let plan = StoragePlan {node: BodyNodeId {index: usize.ZERO}, helper: Option<InstanceKey>.none(),
      size: shape.size, alignment: shape.alignment, externs: move externs, cleanup: false,
      targets: List<CallTarget>.make(), results: List<Interned<Type>>.make(), steps: List<RunPlan>.make()}
    let output = run lowerBufferResize(&mut builder, &plan, &place(buffer), Operand.Copy {place: place(2)}, &result, origin)
    run assign(&mut builder, place(usize.ZERO), Rvalue.Use {value: move output}, origin)
    terminate(&mut builder, Terminator.Return {origin: origin})
    return move builder.function
  }
''';s=s[:pos]+new+s[pos:]
s=s.replace('import semantic.SealedCore {Field as CoreField, Lifecycle}','import semantic.SealedCore {Core as SealedKind, Field as CoreField, Lifecycle}').replace('SealedCore.Core.RawBuffer','SealedKind.RawBuffer')
p.write_text(s)
