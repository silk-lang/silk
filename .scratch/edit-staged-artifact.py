p='/workspace/silk/.scratch/staged-artifact-cache/compiler/src/semantic/Semantic.silk'
s=open(p).read()
# Extract import/adoption: both synchronous and staged completion use the same exact operation.
a=s.index('      let imported = match move run Semantic.importArtifactCache',s.index('effect fn retainedArtifact('))
b=s.index('\n    }\n    let mut collected =',a)
block=s[a:b]
block=block.replace('      ', '    ', 1) # remaining indentation cosmetic; normalize all by two spaces
block='\n'.join(x[2:] if x.startswith('      ') else x for x in block.splitlines())
block=block.replace('return Option<BackendBuild>.none()', 'return Option<CapturedBuild>.none()')
old='persisted = Option<CapturedBuild>.some(CapturedBuild {record: move replay, entries: move rested,\n        guard: usize.MAX, carriedRecord: usize.MAX})'
# normalize exact suffix independently
c=block.index('persisted = Option<CapturedBuild>.some(')
d=block.index('\n',block.index('guard: usize.MAX, carriedRecord: usize.MAX})',c))
block=block[:c]+'''let captured = CapturedBuild {record: move replay, entries: move rested,
      guard: usize.MAX, carriedRecord: usize.MAX}'''+block[d:]
block+='\n    return Option<CapturedBuild>.some(move captured)'
helper='''  // The cache evidence of a proved, emitted retained graph. Cache transfer failure leaves the
  // caller free to discard speculative native work and use the ordinary serial build path.
  effect fn captureArtifactReplay(self: &mut Self, replay: BuildRecord.Record, started: u64) -> Option<CapturedBuild>
  ! Cycle | OutOfMemoryError ? &mut Allocator | &mut Types {
'''+block+'\n  }\n\n'
s=s[:a]+'''      if deferCache && self.resolver.codegenUnits && !self.resolver.revisable {
        pending.* = Option<BuildRecord.Record>.some(move replay)
      } else {
        persisted = run Semantic.captureArtifactReplay(&mut self.*, move replay, started)
        if let Option<CapturedBuild>.None = &persisted { return Option<BackendBuild>.none() }
      }'''+s[b:]
pos=s.index('  effect fn retainedArtifact(')
s=s[:pos]+helper+s[pos:]
s=s.replace('effect fn retainedArtifact(self: &mut Self, roots: &[BuildRoot], module: &ModuleId, span: Span) -> Option<BackendBuild>', 'effect fn retainedArtifact(self: &mut Self, roots: &[BuildRoot], module: &ModuleId, span: Span,\n    deferCache: bool, pending: &mut Option<BuildRecord.Record>) -> Option<BackendBuild>')
s=s.replace('Semantic.retainedArtifact(&mut self.*, roots, module, span)', 'Semantic.retainedArtifact(&mut self.*, roots, module, span, deferCache, &mut pending.*)')
s=s.replace('Semantic.retainedArtifact(&mut self.*, List<BuildRoot>.asSlice(&roots), &module, origin)', 'Semantic.retainedArtifact(&mut self.*, List<BuildRoot>.asSlice(&roots), &module, origin, deferCache, &mut pending.*)')
# Only retainedArtifact's publication differs; no deferred cache means unchanged synchronous behavior.
a=s.index('  effect fn retainedArtifact(');b=s.index('\nfn artifactTraceExperiment',a)
part=s[a:b].replace('    self.freshBuild = true', '    self.freshBuild = match &pending.* { Option<BuildRecord.Record>.None => true _ => false }')
s=s[:a]+part+s[b:]
# A preparation owns the unadopted replay, so no new long-lived Semantic state is needed.
pos=s.index('// A build refused before or after the instance walk')
s=s[:pos]+'''/// A proved and assembled artifact whose retained cache evidence may still await adoption.
/// Only [`Semantic.finishBuildArtifact`] releases the owned build for publication.
pub struct ArtifactPreparation {
  build: BackendBuild,
  replay: Option<BuildRecord.Record>,
}

impl ArtifactPreparation {
  /// Borrows exact assembled units for private native compilation before final cache adoption.
  pub fn preview(self: &Self) -> &BackendBuild { return &self.build }
  /// Whether cache adoption remains pending. Every unit in this case has its body in memory;
  /// none refers to a stored pack. Synchronous and warm builds return false.
  pub fn deferred(self: &Self) -> bool {
    return match &self.replay { Option<BuildRecord.Record>.Some {..} => true _ => false }
  }
}

/// The completed artifact and whether it is the same artifact that preparation previewed.
pub struct ArtifactCompletion {
  pub build: BackendBuild,
  /// False when cache transfer failed and serial fallback replaced the preview. Discard every
  /// pending native product in that case, even if individual units happen to match.
  pub accepted: bool,
}

'''+s[pos:]
# Extract cleanup so every error, cancellation and successful finish closes the same resources.
a=s.index('  pub effect fn buildArtifact(self:');b=s.index('  effect fn buildArtifactHeld(',a)
old=s[a:b]
x=old.index('    stopFrontier(');y=old.index('    return match move attempted',x)
cleanup=old[x:y]
# Keep normal synchronous API as a completed entry, not a caller migration shim.
new='''  pub effect fn buildArtifact(self: &mut Self, request: &mut Request, runtime: Option<&ModuleId>,
    rootPackage: &[ModuleId], checked: &[ModuleId], closureNodes: usize) -> BackendBuild
  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError
  ? &mut Allocator | &mut Types {
    let prepared = run Semantic.prepareArtifactWithCache(&mut self.*, &mut request.*, runtime, rootPackage, checked, closureNodes, false)
    return move prepared.build
  }

  /// Checks and assembles an artifact, leaving only an admitted cold retained build's cache
  /// evidence pending. The caller must finish or abandon the preparation before reusing the store.
  pub effect fn prepareBuildArtifact(self: &mut Self, request: &mut Request, runtime: Option<&ModuleId>,
    rootPackage: &[ModuleId], checked: &[ModuleId], closureNodes: usize) -> ArtifactPreparation
  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError
  ? &mut Allocator | &mut Types {
    return run Semantic.prepareArtifactWithCache(&mut self.*, &mut request.*, runtime, rootPackage, checked, closureNodes, true)
  }

  fn stopArtifactWorkers(self: &mut Self) -> () {
'''+cleanup+'''  }

  effect fn finishArtifactWorkers(self: &mut Self) -> () ! Cycle | OutOfMemoryError ? &mut Allocator | &mut Types {
    let cached = run Effect.result(Semantic.flushDeferredFrontierCache(&mut self.*))
    Semantic.stopArtifactWorkers(&mut self.*)
    match move cached {
      Result<(), Cycle | OutOfMemoryError>.Success {..} => {}
      Result<(), Cycle | OutOfMemoryError>.Failure {error} => { fail move error }
    }
  }

  /// Discards an unfinished preparation and closes its workers without publishing build evidence.
  pub fn abandonBuildArtifact(self: &mut Self, prepared: &mut ArtifactPreparation) -> () {
    prepared.replay = Option<BuildRecord.Record>.none()
    self.capturedBuild = Option<CapturedBuild>.none()
    self.freshBuild = false
    self.packedBuild = PackedBuild.make()
    Semantic.stopArtifactWorkers(&mut self.*)
  }

  /// Adopts the exact cache proof and closes retained workers. Failed transport discards the
  /// preview and retries the ordinary build without process workers; it never authorizes pending
  /// native output from the discarded preparation. The request and roots must match preparation.
  pub effect fn finishBuildArtifact(self: &mut Self, request: &mut Request, runtime: Option<&ModuleId>,
    rootPackage: &[ModuleId], checked: &[ModuleId], closureNodes: usize, prepared: ArtifactPreparation) -> ArtifactCompletion
  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError
  ? &mut Allocator | &mut Types {
    let ArtifactPreparation {build, replay} = move prepared
    let record = match move replay {
      Option<BuildRecord.Record>.Some {value} => move value
      Option<BuildRecord.Record>.None => { return ArtifactCompletion {build: move build, accepted: true} }
    }
    let captured = run Effect.result(Semantic.captureArtifactReplay(&mut self.*, move record, self.frontierSplit))
    let mut accepted = false
    match move captured {
      Result<Option<CapturedBuild>, Cycle | OutOfMemoryError>.Success {value} => {
        if let Option<CapturedBuild>.Some {value: proof} = move value {
          self.capturedBuild = Option<CapturedBuild>.some(move proof)
          self.freshBuild = true
          accepted = true
        }
      }
      Result<Option<CapturedBuild>, Cycle | OutOfMemoryError>.Failure {error} => {
        Semantic.stopArtifactWorkers(&mut self.*)
        fail move error
      }
    }
    run Semantic.finishArtifactWorkers(&mut self.*)
    if accepted { return ArtifactCompletion {build: move build, accepted: true} }
    drop build
    self.capturedBuild = Option<CapturedBuild>.none()
    self.freshBuild = false
    self.packedBuild = PackedBuild.make()
    let allowed = self.processWorkersAllowed
    self.processWorkersAllowed = false
    let retried = run Effect.result(Semantic.buildArtifact(&mut self.*, &mut request.*, runtime, rootPackage, checked, closureNodes))
    self.processWorkersAllowed = allowed
    return match move retried {
      Result<BackendBuild, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} =>
        ArtifactCompletion {build: move value, accepted: false}
      Result<BackendBuild, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Failure {error} => { fail move error }
    }
  }

  effect fn prepareArtifactWithCache(self: &mut Self, request: &mut Request, runtime: Option<&ModuleId>,
    rootPackage: &[ModuleId], checked: &[ModuleId], closureNodes: usize, deferCache: bool) -> ArtifactPreparation
  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError
  ? &mut Allocator | &mut Types {
'''
init=old[old.index('    self.keepArtifactWorkers'):old.index('    let attempted =')]
new+=init+'''    let mut pending = Option<BuildRecord.Record>.none()
    let attempted = run Effect.result(Semantic.buildArtifactHeld(&mut self.*, &mut request.*, runtime, rootPackage, checked, closureNodes,
      deferCache, &mut pending))
    let build = match move attempted {
      Result<BackendBuild, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} => move value
      Result<BackendBuild, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Failure {error} => {
        let flushed = run Effect.result(Semantic.finishArtifactWorkers(&mut self.*))
        drop flushed
        fail move error
      }
    }
    let mut canDefer = false
    if let BackendBuild.Module {units, ..} = &build {
      canDefer = List<CodegenUnit>.length(&units) > usize.ZERO
      let listed = List<CodegenUnit>.asSlice(&units)
      let mut at = usize.ZERO
      while at < listed.length {
        if listed[at].stored { canDefer = false }
        at = at + usize.ONE
      }
    }
    if !canDefer {
      if let Option<BuildRecord.Record>.Some {value} = move pending {
        let captured = run Effect.result(Semantic.captureArtifactReplay(&mut self.*, move value, self.frontierSplit))
        match move captured {
          Result<Option<CapturedBuild>, Cycle | OutOfMemoryError>.Success {value: proof} => { self.capturedBuild = move proof }
          Result<Option<CapturedBuild>, Cycle | OutOfMemoryError>.Failure {error} => {
            Semantic.stopArtifactWorkers(&mut self.*)
            fail move error
          }
        }
      }
      pending = Option<BuildRecord.Record>.none()
    }
    if let Option<BuildRecord.Record>.None = &pending { run Semantic.finishArtifactWorkers(&mut self.*) }
    return ArtifactPreparation {build: move build, replay: move pending}
  }

'''
s=s[:a]+new+s[b:]
s=s.replace('    rootPackage: &[ModuleId], checked: &[ModuleId], closureNodes: usize) -> BackendBuild\n  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError\n  ? &mut Allocator | &mut Types {\n    run selectRequest', '    rootPackage: &[ModuleId], checked: &[ModuleId], closureNodes: usize, deferCache: bool,\n    pending: &mut Option<BuildRecord.Record>) -> BackendBuild\n  ! Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError\n  ? &mut Allocator | &mut Types {\n    run selectRequest',1)
open(p,'w').write(s)
