from pathlib import Path
p=Path('/workspace/silk/.scratch/shared-storage-helpers/compiler/src/semantic/Semantic.silk');s=p.read_text()
s=s.replace('import backend.InstanceKey {HelperRole, InstanceKey, ProviderEntry}','import backend.InstanceKey {HelperRole, InstanceKey, ProviderEntry, StorageShape}')
s=s.replace('    InstanceKey.DropGlue {..} => { return false }','    InstanceKey.DropGlue {..} => { return false }\n    InstanceKey.Storage {..} => { return false }',1)
s=s.replace('    InstanceKey.DropGlue { .. } => {\n      return false\n    }','    InstanceKey.DropGlue { .. } => {\n      return false\n    }\n    InstanceKey.Storage {..} => { return false }',1)
needle='  let identity = InstanceKey.identity(instance)\n  // Glue owned by a sealed core'
s=s.replace(needle,'''  let identity = InstanceKey.identity(instance)
  if let InstanceKey.Storage {..} = &instance.* {
    if List<ModuleId>.length(&resolver.modules) == usize.ZERO { return Option<InstanceLocation>.none() }
    return Option<InstanceLocation>.some(InstanceLocation {module: usize.ZERO, declaration: usize.MAX})
  }
  // Glue owned by a sealed core''',1)
s=s.replace('  if let InstanceKey.DropGlue {..} = &instance.* { return Option<Anchor>.none() }','  if let InstanceKey.DropGlue {..} = &instance.* { return Option<Anchor>.none() }\n  if let InstanceKey.Storage {..} = &instance.* { return Option<Anchor>.none() }',1)
s=s.replace('    InstanceKey.Helper {..} => usize.MAX - 3','    InstanceKey.Helper {..} => usize.MAX - 3\n    InstanceKey.Storage {..} => usize.MAX - 4',1)
needle='  if let InstanceKey.Helper {creator, node, ordinal, purpose} = &instance {\n    let creating'
s=s.replace(needle,'''  if let InstanceKey.Storage {shape, ..} = &instance {
    let function = run MirFunction.storageHelper(InstanceKey.copy(&instance), Shared<StorageShape>.get(&shape))
    return run storeMir(&mut resolver.*, &mut owner.*, move function, List<Dependency>.make())
  }
  if let InstanceKey.Helper {creator, node, ordinal, purpose} = &instance {
    let creating''',1)
# Shared has get? Existing code consistently Shared.get sometimes? fixed below after searching.
needle='  return Result<MirStoragePlan, PreparationFailure>.succeed(MirStoragePlan {node: node, size: size, alignment: alignment, externs: move externs,'
s=s.replace(needle,'''  let mut helper = Option<InstanceKey>.none()
  if operation == StorageOperation.RawBufferResize && size > usize.ZERO {
    let identity = run SealedCore.identity(SealedKind.RawBuffer)
    helper = Option<InstanceKey>.some(run InstanceKey.storageResize(&identity, resolver.target, size, alignment,
      List<Interned<DeclarationId>>.asSlice(&externs)))
  }
  return Result<MirStoragePlan, PreparationFailure>.succeed(MirStoragePlan {node: node, helper: move helper, size: size, alignment: alignment, externs: move externs,''',1)
s=s.replace('  if let Option<Interned<Type>>.Some {..} = move InstanceKey.glueType(&key) { return Option<StaticClosure>.none() }','  if let Option<Interned<Type>>.Some {..} = move InstanceKey.glueType(&key) { return Option<StaticClosure>.none() }\n  if let InstanceKey.Storage {..} = &key { return Option<StaticClosure>.none() }',1)
p.write_text(s)
