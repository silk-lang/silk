from pathlib import Path
r=Path('/workspace/silk/.scratch/shared-storage-helpers/compiler/src')
p=r/'backend/InstanceKey.silk';s=p.read_text().replace('pub struct StorageShape {\n  pub target:', 'pub enum StorageRole { Resize, Copy }\n\npub struct StorageShape {\n  pub role: StorageRole,\n  pub target:')
s=s.replace('pub effect fn storageResize(owner: &Interned<DeclarationId>, target: MachineTarget, size: usize, alignment: usize,','pub effect fn storage(owner: &Interned<DeclarationId>, role: StorageRole, target: MachineTarget, size: usize, alignment: usize,')
s=s.replace('run RuntimeEncoding.word(&mut runtime, 0) // resize','run RuntimeEncoding.word(&mut runtime, match role { StorageRole.Resize => 0 StorageRole.Copy => 1 })')
s=s.replace('StorageShape {target: target, size: size,','StorageShape {role: role, target: target, size: size,')
s=s.replace('Constructs one shared resize implementation','Constructs one shared storage implementation')
p.write_text(s)
p=r/'semantic/Semantic.silk';s=p.read_text().replace('ProviderEntry, StorageShape}', 'ProviderEntry, StorageShape, StorageRole}')
s=s.replace('if operation == StorageOperation.RawBufferResize && size > usize.ZERO {','if (operation == StorageOperation.RawBufferResize && size > usize.ZERO) || operation == StorageOperation.RawBufferCopy {')
s=s.replace('helper = Option<InstanceKey>.some(run InstanceKey.storageResize(&identity, resolver.target, size, alignment,','let role = if operation == StorageOperation.RawBufferResize { StorageRole.Resize } else { StorageRole.Copy }\n    helper = Option<InstanceKey>.some(run InstanceKey.storage(&identity, role, resolver.target, size, alignment,')
p.write_text(s)
p=r/'backend/MirText.silk';s=p.read_text().replace('b"storage.resize "','b"storage "');p.write_text(s)
p=r/'backend/Mir.silk';s=p.read_text().replace('NameOrder, StorageShape}', 'NameOrder, StorageShape, StorageRole}')
# split resize argument conversion from generic tracked call
needle='''  run List<Operand>.append(&mut arguments, move requested)
  run List<Reference>.append'''
s=s.replace(needle,'''  run List<Operand>.append(&mut arguments, move requested)
  return run callStorageHelper(&mut builder.*, key, move arguments, ty, origin)
}

effect fn callStorageHelper(builder: &mut Builder, key: &InstanceKey, arguments: List<Operand>,
  ty: &Interned<Type>, origin: Origin) -> Operand ! OutOfMemoryError ? &mut Allocator | &mut Types {
  run List<Reference>.append''',1)
# add copy builder before resize body
pos=s.index('// `rawBufferResize<T>(buffer, count)`')
new='''// The shared copy returns refusal before touching bytes. The typed caller emits the original
// source trap, keeping observer context and source attribution out of this generated body.
effect fn lowerBufferCopyResult(builder: &mut Builder, plan: &StoragePlan, buffer: &Place,
  offset: usize, source: usize, available: usize, length: usize, result: &Interned<Type>, origin: Origin)
  -> Operand ! OutOfMemoryError ? &mut Allocator | &mut Types {
  let word = run storagePrimitive(b"usize")
  let output = run storageValue(&mut builder.*, result, Rvalue.Use {value: Operand.Boolean {value: false}}, origin)
  let done = run block(&mut builder.*, origin)
  let count = run storageValue(&mut builder.*, &word, Rvalue.Use {value: Operand.Copy {place:
    run storagePlace(buffer, true, &[SealedCore.ordinal(CoreField.BufferCount)])}}, origin)
  let starts = run storageCondition(&mut builder.*, InfixOperator.LessOrEqual, Operand.Copy {place: place(offset)},
    Operand.Copy {place: place(count)}, origin)
  let remainingBlock = run block(&mut builder.*, origin)
  terminate(&mut builder.*, Terminator.Branch {condition: move starts, thenBlock: remainingBlock, elseBlock: done, origin: origin})
  resume(&mut builder.*, remainingBlock)
  let remaining = run storageValue(&mut builder.*, &word, Rvalue.Binary {operation: InfixOperator.Subtract,
    left: Operand.Copy {place: place(count)}, right: Operand.Copy {place: place(offset)}}, origin)
  let fits = run storageCondition(&mut builder.*, InfixOperator.LessOrEqual, Operand.Copy {place: place(length)},
    Operand.Copy {place: place(remaining)}, origin)
  let suppliedBlock = run block(&mut builder.*, origin)
  terminate(&mut builder.*, Terminator.Branch {condition: move fits, thenBlock: suppliedBlock, elseBlock: done, origin: origin})
  resume(&mut builder.*, suppliedBlock)
  let supplied = run storageCondition(&mut builder.*, InfixOperator.LessOrEqual, Operand.Copy {place: place(length)},
    Operand.Copy {place: place(available)}, origin)
  let moving = run block(&mut builder.*, origin)
  terminate(&mut builder.*, Terminator.Branch {condition: move supplied, thenBlock: moving, elseBlock: done, origin: origin})
  resume(&mut builder.*, moving)
  let address = run SealedCore.bytes()
  let octet = run storagePrimitive(b"u8")
  let base = run bufferBase(&mut builder.*, buffer, &octet, origin)
  let displacement = run storageValue(&mut builder.*, &word, Rvalue.Binary {operation: InfixOperator.Multiply,
    left: Operand.Copy {place: place(offset)}, right: run wordOperand(plan.size)}, origin)
  let destination = run storageValue(&mut builder.*, &address, Rvalue.PointerOffset {pointer: Operand.Copy {place: place(base)},
    index: Operand.Copy {place: place(displacement)}, element: Interned<Type>.clone(&octet)}, origin)
  let bytes = run storageValue(&mut builder.*, &word, Rvalue.Binary {operation: InfixOperator.Multiply,
    left: Operand.Copy {place: place(length)}, right: run wordOperand(plan.size)}, origin)
  let mut arguments = List<Operand>.make()
  run List<Operand>.append(&mut arguments, Operand.Copy {place: place(destination)})
  run List<Operand>.append(&mut arguments, Operand.Copy {place: place(source)})
  run List<Operand>.append(&mut arguments, Operand.Copy {place: place(bytes)})
  drop run callAllocator(&mut builder.*, plan, 2, move arguments, &address, origin)
  run assign(&mut builder.*, place(output), Rvalue.Use {value: Operand.Boolean {value: true}}, origin)
  terminate(&mut builder.*, Terminator.Goto {target: done, origin: origin})
  resume(&mut builder.*, done)
  return Operand.Copy {place: place(output)}
}

''';s=s[:pos]+new+s[pos:]
# copy wrapper extracts all operands, but trap is still at wrapper origin.
needle='''    StorageOperation.RawBufferCopy => {
      let offset ='''
s=s.replace(needle,'''    StorageOperation.RawBufferCopy => {
      if let Option<InstanceKey>.Some {value: helper} = &plan.helper {
        let offset = List<Operand>.remove(&mut operands, usize.ZERO)
        let source = run operandPlace(&owner, List<Operand>.remove(&mut operands, usize.ZERO), origin)
        let length = List<Operand>.remove(&mut operands, usize.ZERO)
        let bits = run storageValue(&mut builder.*, &word, Rvalue.AddressIntegerConversion {
          operand: Operand.Copy {place: run copyPlace(&first)}, destinationType: Interned<Type>.clone(&word)}, origin)
        let destination = run storageValue(&mut builder.*, &address, Rvalue.AddressIntegerConversion {
          operand: Operand.Copy {place: place(bits)}, destinationType: Interned<Type>.clone(&address)}, origin)
        let available = run storageValue(&mut builder.*, &word, Rvalue.SliceLength {place: run copyPlace(&source)}, origin)
        let data = run storageValue(&mut builder.*, &address, Rvalue.SliceData {place: move source}, origin)
        let mut arguments = List<Operand>.make()
        run List<Operand>.append(&mut arguments, Operand.Copy {place: place(destination)})
        run List<Operand>.append(&mut arguments, move offset)
        run List<Operand>.append(&mut arguments, Operand.Copy {place: place(data)})
        run List<Operand>.append(&mut arguments, Operand.Copy {place: place(available)})
        run List<Operand>.append(&mut arguments, move length)
        let boolean = run storagePrimitive(b"bool")
        let success = run callStorageHelper(&mut builder.*, &helper, move arguments, &boolean, origin)
        run trapUnless(&mut builder.*, move success, TrapReason.RawBufferRangeOutOfBounds, origin)
        return Operand.Unit
      }
      let offset =''',1)
# generated helper body parameters and role-specific work
s=s.replace('''    let result = run storagePrimitive(b"bool")
    let mut parameters = List<Interned<Type>>.make()
    run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&address))
    run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&word))
    let mut builder = run storageBuilder''','''    let result = run storagePrimitive(b"bool")
    let role = Shared<StorageShape>.with<StorageRole>(shape, fn(value: &StorageShape) -> StorageRole { return value.role })
    let mut parameters = List<Interned<Type>>.make()
    run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&address))
    run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&word))
    if role == StorageRole.Copy {
      run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&address))
      run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&word))
      run List<Interned<Type>>.append(&mut parameters, Interned<Type>.clone(&word))
    }
    let mut builder = run storageBuilder''',1)
s=s.replace('''    let output = run lowerBufferResize(&mut builder, &plan, &place(buffer), Operand.Copy {place: place(2)}, &result, origin)
    run assign''','''    let output = if role == StorageRole.Resize {
      run lowerBufferResize(&mut builder, &plan, &place(buffer), Operand.Copy {place: place(2)}, &result, origin)
    } else {
      run lowerBufferCopyResult(&mut builder, &plan, &place(buffer), 2, 3, 4, 5, &result, origin)
    }
    run assign''',1)
s=s.replace('Builds a shared sealed resize implementation','Builds a shared sealed storage implementation')
p.write_text(s)
