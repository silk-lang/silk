from pathlib import Path
p=Path('/workspace/silk/.scratch/shared-typed-bodies/compiler/src/semantic/Semantic.silk');s=p.read_text()
old='''  let original = run Semantic.checkModule(&mut producer, &mut request, &module, &Option<ModuleId>.none())
    |> Effect.provideMut<Types>(&mut producerTypes)
  run Testing.expect(!checkRefuses(&original) && producer.resolver.sharedBodies.published > usize.ZERO,
    "a real completed ordinary body publishes a portable result and full guard")'''
new='''  let child = unsafe FrontierHost.fork()
  if child == 0 {
    let attempted = run Effect.result(Semantic.checkModule(&mut producer, &mut request, &module, &Option<ModuleId>.none()))
      |> Effect.provideMut<Types>(&mut producerTypes)
    let clean = match move attempted {
      Result<DeclarationCheckResult, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} => !checkRefuses(&value)
      _ => false
    }
    unsafe FrontierHost.exit(if clean && producer.resolver.sharedBodies.published > usize.ZERO { 0 } else { 1 })
  }
  let mut childStatus: i32 = 0
  let reaped = if child > 0 { unsafe FrontierHost.wait(child, Pointer.fromMutRef<i32>(&mut childStatus), 0) } else { -1 }
  run Testing.expect(child > 0 && reaped == child && childStatus == 0,
    "a completed child publishes a real typed body and full guard before being reaped")'''
assert old in s;s=s.replace(old,new,1)
s=s.replace('// Tests transfer ownership instead of forking. Both stores explicitly hold this same revision;\n  // production obtains this mapping only by inheriting an admitted immutable store at fork.', '// The producer is now reaped; only portable arena records remain. The consumer has a fresh\n  // type/query store and explicitly holds the same authored revision as the forked producer.')
extra='''
// Reusing an unchanged caller must retain the supplied callee's header and name-roster reads.
effect fn sharedTypedBodyInteriorClaims() -> ()
! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError | AssertionError<'static> ? &mut Allocator {
  if !FrontierHost.available() { return () }
  let caller = run ModuleId.make(b"memory", b"shared-interior", b"caller.silk")
  let callee = run ModuleId.make(b"memory", b"shared-interior", b"callee.silk")
  let callerText = Option<Bytes>.some(run Bytes.copy(b"import callee\\npub fn caller() -> i32 { return callee.helper() }\\n"))
  let calleeText = Option<Bytes>.some(run Bytes.copy(b"pub fn helper() -> i32 { return 1 }\\n"))
  let initial = run Revision.publish(&Revision.make(), &caller, &callerText)
  let revision = run Revision.publish(&initial, &callee, &calleeText)
  let target = MachineTarget.forId(TargetId.Aarch64AppleDarwin)
  let mut request = Request.make()
  let mut producer = Semantic.cached(run Revision.copy(&revision), target, Option<FinalProfile>.none())
  producer.resolver.sharedBodies.arena = SharedBodyArena.open(true)
  producer.resolver.sharedBodies.active = true
  let mut producerTypes = TypeTable.make()
  let clean = run Semantic.checkModule(&mut producer, &mut request, &caller, &Option<ModuleId>.none())
    |> Effect.provideMut<Types>(&mut producerTypes)
  run Testing.expect(!checkRefuses(&clean) && producer.resolver.sharedBodies.published > usize.ZERO,
    "a caller with crossmodule signature dependencies publishes a guarded body")
  let mut consumer = Semantic.cached(run Revision.copy(&revision), target, Option<FinalProfile>.none())
  consumer.resolver.sharedBodies.arena = Intrinsic.replace(producer.resolver.sharedBodies.arena, SharedBodyArena.empty())
  producer.resolver.sharedBodies.active = false
  consumer.resolver.sharedBodies.active = true
  let mut consumerTypes = TypeTable.make()
  let imported = run Semantic.checkModule(&mut consumer, &mut request, &caller, &Option<ModuleId>.none())
    |> Effect.provideMut<Types>(&mut consumerTypes)
  run Testing.expect(!checkRefuses(&imported) && consumer.resolver.sharedBodies.avoided > usize.ZERO,
    "the unchanged caller actually imports a completed body before its dependency edits")
  let image = run Semantic.completeCacheImage(&mut consumer)
  closeSharedBodies(&mut consumer.resolver)
  let trials = [b"pub fn helper() -> bool { return true }\\n", b"pub fn renamed() -> i32 { return 1 }\\n"]
  let mut trial = usize.ZERO
  while trial < trials.length {
    let changed = run Revision.publish(&revision, &callee, &Option<Bytes>.some(run Bytes.copy(trials[trial])))
    let mut replay = Semantic.cached(run Revision.copy(&changed), target, Option<FinalProfile>.none())
    let mut replayTypes = TypeTable.make()
    drop run Semantic.adoptCache(&mut replay, &request, &image, false) |> Effect.provideMut<Types>(&mut replayTypes)
    let actual = run Semantic.checkModule(&mut replay, &mut request, &caller, &Option<ModuleId>.none())
      |> Effect.provideMut<Types>(&mut replayTypes)
    let mut fresh = Semantic.cached(move changed, target, Option<FinalProfile>.none())
    let mut freshTypes = TypeTable.make()
    let expected = run Semantic.checkModule(&mut fresh, &mut request, &caller, &Option<ModuleId>.none())
      |> Effect.provideMut<Types>(&mut freshTypes)
    let found = List<Shared<Rejection>>.asSlice(&actual.rejections)
    let wanted = List<Shared<Rejection>>.asSlice(&expected.rejections)
    run Testing.expect(found.length > usize.ZERO && found.length == wanted.length,
      "changed callee header/name roster invalidates an imported caller whose own source is unchanged")
    let mut at = usize.ZERO
    while at < found.length {
      let mut left = Bytes.make()
      let mut right = Bytes.make()
      let mut sites = List<ModuleId>.make()
      run Testing.expect((run RejectionImage.encode(&mut left, &found[at], &mut sites))
        && (run RejectionImage.encode(&mut right, &wanted[at], &mut sites)), "complete dependency diagnostics encode")
      run Testing.expect(same(Bytes.asSlice(&left), Bytes.asSlice(&right)),
        "shared body dependency edits preserve the full ordered fresh diagnostics")
      at = at + usize.ONE
    }
    trial = trial + usize.ONE
  }
}
test effect fn sharedTypedBodiesPreserveCrossmoduleHeaderAndRosterGuards() -> ()
! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError | AssertionError<'static> {
  let mut allocator = Allocator.systemAllocatorProvider()
  run sharedTypedBodyInteriorClaims() |> Effect.provideMut<Allocator>(&mut allocator)
}
'''
s += extra;p.write_text(s)
