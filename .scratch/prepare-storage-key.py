from pathlib import Path
root=Path('/workspace/silk/.scratch/shared-storage-helpers/compiler/src')
p=root/'backend/InstanceKey.silk';s=p.read_text()
s=s.replace('import semantic.Types {Types}', 'import semantic.Types {Types}\nimport semantic.Target {Target as MachineTarget}\nimport silk.num.u32')
s=s.replace('  Helper {pub creator: Shared<InstanceKey>, pub node: usize, pub ordinal: usize, pub purpose: HelperRole},','''  Helper {pub creator: Shared<InstanceKey>, pub node: usize, pub ordinal: usize, pub purpose: HelperRole},
  /// A source-independent sealed storage implementation. Its complete target, measured layout
  /// and allocator identities select the body; no caller or element's semantic identity does.
  Storage {pub shape: Shared<StorageShape>, owner: Interned<DeclarationId>, runtime: Shared<Bytes>, family: u64,
    encodings: Shared<KeyEncodings>},''')
pos=s.index('/// The digests of a key')
s=s[:pos]+'''/// A sealed storage helper's complete lowering inputs. The allocator functions have the sealed
/// C signatures selected by this target; changing that convention changes the key version.
pub struct StorageShape {
  pub target: MachineTarget,
  pub size: usize,
  pub alignment: usize,
  pub externs: List<Interned<DeclarationId>>,
}

'''+s[pos:]
pos=s.index('  /// Copies this function',s.index('impl InstanceKey {'))
s=s[:pos]+'''  /// Constructs one shared resize implementation after typed storage validation and layout
  /// measurement. Equal layouts share code, never source typing or ownership evidence.
  pub effect fn storageResize(owner: &Interned<DeclarationId>, target: MachineTarget, size: usize, alignment: usize,
    externs: &[Interned<DeclarationId>]) -> InstanceKey ! OutOfMemoryError ? &mut Allocator {
    let mut runtime = Bytes.make()
    run RuntimeEncoding.word(&mut runtime, 7)
    run RuntimeEncoding.word(&mut runtime, 1) // generated storage ABI/body schema
    run RuntimeEncoding.word(&mut runtime, 0) // resize
    run RuntimeEncoding.field(&mut runtime, MachineTarget.name(&target))
    run RuntimeEncoding.word(&mut runtime, u32.toU64(MachineTarget.revision(&target)))
    run RuntimeEncoding.word(&mut runtime, usize.toU64(size))
    run RuntimeEncoding.word(&mut runtime, usize.toU64(alignment))
    run RuntimeEncoding.declaration(&mut runtime, &DeclarationId.copyShared(owner))
    run RuntimeEncoding.word(&mut runtime, usize.toU64(externs.length))
    let mut callees = List<Interned<DeclarationId>>.make()
    let mut at = usize.ZERO
    while at < externs.length {
      run RuntimeEncoding.declaration(&mut runtime, &DeclarationId.copyShared(&externs[at]))
      run List<Interned<DeclarationId>>.append(&mut callees, Interned<DeclarationId>.clone(&externs[at]))
      at = at + usize.ONE
    }
    let family = familyHash(&runtime)
    return InstanceKey.Storage {shape: run Shared<StorageShape>.make(StorageShape {target: target, size: size,
      alignment: alignment, externs: move callees}), owner: Interned<DeclarationId>.clone(owner),
      runtime: run Shared<Bytes>.make(move runtime), family: family, encodings: run emptyEncodings()}
  }
  /// The prepared source-independent storage body, when this key names one.
  pub fn storageShape(self: &Self) -> Option<Shared<StorageShape>> {
    return match &self.* {
      InstanceKey.Storage {shape, ..} => Option<Shared<StorageShape>>.some(Shared<StorageShape>.clone(&shape))
      _ => Option<Shared<StorageShape>>.none()
    }
  }
'''+s[pos:]
s=s.replace('      InstanceKey.Helper {..} => Option<Interned<Application>>.none()','      InstanceKey.Helper {..} => Option<Interned<Application>>.none()\n      InstanceKey.Storage {..} => Option<Interned<Application>>.none()')
s=s.replace('      InstanceKey.Helper {creator, node, ordinal, purpose} => InstanceKey.Helper {','''      InstanceKey.Storage {shape, owner, runtime, family, encodings} => InstanceKey.Storage {
        shape: Shared<StorageShape>.clone(&shape), owner: Interned<DeclarationId>.clone(&owner),
        runtime: Shared<Bytes>.clone(&runtime), family: family, encodings: Shared<KeyEncodings>.clone(&encodings),
      }
      InstanceKey.Helper {creator, node, ordinal, purpose} => InstanceKey.Helper {''',1)
s=s.replace('      InstanceKey.DropGlue {owner, ..} => Interned<DeclarationId>.clone(&owner)','      InstanceKey.DropGlue {owner, ..} => Interned<DeclarationId>.clone(&owner)\n      InstanceKey.Storage {owner, ..} => Interned<DeclarationId>.clone(&owner)')
s=s.replace('      InstanceKey.DropGlue {family, ..} => family','      InstanceKey.DropGlue {family, ..} => family\n      InstanceKey.Storage {family, ..} => family')
s=s.replace('      InstanceKey.Helper {creator, node, ordinal, purpose} => match & other.* {','''      InstanceKey.Storage {runtime, family, ..} => match &other.* {
        InstanceKey.Storage {runtime: compared, family: hashed, ..} => family == hashed && sameRuntime(&runtime, &compared)
        _ => false
      }
      InstanceKey.Helper {creator, node, ordinal, purpose} => match & other.* {''',1)
s=s.replace('      InstanceKey.DropGlue {runtime, ..} => Option<Shared<Bytes>>.some(Shared<Bytes>.clone(&runtime))','      InstanceKey.DropGlue {runtime, ..} => Option<Shared<Bytes>>.some(Shared<Bytes>.clone(&runtime))\n      InstanceKey.Storage {runtime, ..} => Option<Shared<Bytes>>.some(Shared<Bytes>.clone(&runtime))')
needle='      InstanceKey.Helper {creator, node, ordinal, purpose} => {\n        run RuntimeEncoding.recordWord(&mut output, 4, &mut coordinates.*)'
s=s.replace(needle,'''      InstanceKey.Storage {runtime, ..} => {
        run RuntimeEncoding.recordWord(&mut output, 5, &mut coordinates.*)
        let count = Shared<Bytes>.with<usize>(&runtime, Bytes.length)
        if !RuntimeEncoding.recordPayload(&mut coordinates.*, count) { return Bytes.make() }
        let bytes = run copyShared(&runtime)
        run RuntimeEncoding.recordField(&mut output, Bytes.asSlice(&bytes), &mut coordinates.*)
      }
'''+needle)
s=s.replace('      InstanceKey.DropGlue {family, ..} => Option<u64>.some(family)','      InstanceKey.DropGlue {family, ..} => Option<u64>.some(family)\n      InstanceKey.Storage {family, ..} => Option<u64>.some(family)')
needle='      InstanceKey.Helper {..} => {\n        let runtime = run InstanceKey.runtimeEncoding(self)'
s=s.replace(needle,'''      InstanceKey.Storage {family, runtime, ..} => Option<NameOrder>.some(NameOrder {
        first: family, second: Shared<Bytes>.with<u64>(&runtime, secondHash),
      })
'''+needle)
s=s.replace('    InstanceKey.DropGlue {encodings, ..} => Option<Shared<KeyEncodings>>.some(Shared<KeyEncodings>.clone(&encodings))','    InstanceKey.DropGlue {encodings, ..} => Option<Shared<KeyEncodings>>.some(Shared<KeyEncodings>.clone(&encodings))\n    InstanceKey.Storage {encodings, ..} => Option<Shared<KeyEncodings>>.some(Shared<KeyEncodings>.clone(&encodings))')
p.write_text(s)
p=root/'backend/EmissionPlan.silk';s=p.read_text().replace('      InstanceKey.Helper {..} => 3','      InstanceKey.Helper {..} => 3\n      InstanceKey.Storage {..} => 4');p.write_text(s)
p=root/'backend/MirText.silk';s=p.read_text();needle='    InstanceKey.Helper {creator, node, ordinal, purpose} => {';s=s.replace(needle,'''    InstanceKey.Storage {..} => {
      run Bytes.append(&mut out.*, b"storage.resize ")
      let name = run InstanceKey.runtimeName(key)
      run Bytes.append(&mut out.*, Bytes.asSlice(&name))
    }
'''+needle);p.write_text(s)
