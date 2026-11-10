from pathlib import Path
p=Path('/workspace/silk-retained-single-export/compiler/src/semantic/Semantic.silk');s=p.read_text()
def change(a,b):
 global s
 assert s.count(a)==1,(a[:90],s.count(a));s=s.replace(a,b)
change('struct FrontierMirEvidence { exact: ContentHash, unit: usize }','struct FrontierMirEvidence { exact: ContentHash, unit: usize }\nstruct DeferredFrontierSubset { full: Bytes, selected: Bytes, concrete: List<DeclarationId> }')
change('  artifactWorkers: List<CheckWorker>,','  artifactWorkers: List<CheckWorker>,\n  deferredFrontierGraph: Option<BuildRecord.Record>,\n  deferredFrontierSubsets: List<DeferredFrontierSubset>,')
change('    artifactWorkers: List<CheckWorker>.make(),','    artifactWorkers: List<CheckWorker>.make(),\n    deferredFrontierGraph: Option<BuildRecord.Record>.none(),\n    deferredFrontierSubsets: List<DeferredFrontierSubset>.make(),')
change('    self.frontierExtensionEvidence = List<FrontierMirEvidence>.make()', '    self.deferredFrontierGraph = Option<BuildRecord.Record>.none()\n    self.deferredFrontierSubsets = List<DeferredFrontierSubset>.make()\n    self.frontierExtensionEvidence = List<FrontierMirEvidence>.make()')
change('''      if retainedCacheExperiment() {
        run Semantic.persistFrontierChecks(&mut self.*, workers, &value, List<FrontierCoverage>.asSlice(&coverage))
      }''','''      if retainedCacheExperiment() {
        if self.keepArtifactWorkers {
          // The same resident workers will add final emission dependencies. Export one image
          // after that work, retaining this already-proved graph for its check-cache roots.
          self.deferredFrontierGraph = Option<BuildRecord.Record>.some(move value)
        } else { run Semantic.persistFrontierChecks(&mut self.*, workers, &value, List<FrontierCoverage>.asSlice(&coverage)) }
      }''')
change('''                run Semantic.persistFrontierSubset(&mut self.*, Bytes.asSlice(&stable), Bytes.asSlice(&selected), concrete)''','''                if let Option<BuildRecord.Record>.Some {..} = &self.deferredFrontierGraph {
                  run List<DeferredFrontierSubset>.append(&mut self.deferredFrontierSubsets, DeferredFrontierSubset {
                    full: run Bytes.copy(Bytes.asSlice(&stable)), selected: move selected, concrete: run copyDeclarations(concrete)})
                } else { run Semantic.persistFrontierSubset(&mut self.*, Bytes.asSlice(&stable), Bytes.asSlice(&selected), concrete) }''')
# Separate strict proof assembly from IPC and publication; its evidence checks remain unchanged.
start=s.index('  effect fn persistFrontierChecks(');end=s.index('\n}\n\neffect fn frontierReadSeparationClaims',start)
old=s[start:end];cut=old.index('    let mut entries = DigestSet.make()')
head=old[:cut]
body=old[cut:]
append_start=body.index('    run Semantic.unpackAdoptedImage(&mut self.*)')
append_end=body.index('    run frontierTrace(b"check cache imported"',append_start)
body=body[:append_start]+body[append_end:]
body=body.replace('&mut image,','&mut image.*,')
body=body.replace('    run frontierTrace(b"check cache imported",','    run frontierTrace(b"check cache assembled",')
body=body[:-4]+'    return move selected\n  }\n' if body.endswith('  }\n') else body
# Function substring ends with two-space brace without newline.
if not 'return move selected' in body:
 assert body.endswith('  }');body=body[:-3]+'    return move selected\n  }'
wrapper=head+'''    let selected = run Semantic.completeFrontierChecks(&self.*, &mut image, graph, coverage)
    drop run Semantic.appendArtifactImage(&mut self.*, &image, List<usize>.asSlice(&selected))
  }

  // Validates portable records against their exact MIR and root-read evidence before any root
  // is published. Both check-only and deferred build publication use this one proof path.
  effect fn completeFrontierChecks(self: &Self, image: &mut CacheImage.Image,
    graph: &BuildRecord.Record, coverage: &[FrontierCoverage]) -> List<usize>
  ! OutOfMemoryError ? &mut Allocator | &mut Types {
'''+body
s=s[:start]+wrapper+s[end:]
# Shared final image publication retains build-entry map and safe independent metadata roots.
start=s.index('  // Called only after every selected definition has completed emission.')
end=s.index('\n}\n\neffect fn artifactCacheCheckKey',start)
old=s[start:end]
map_start=old.index('    let positions = List<usize>.asSlice(&selected)')
mapbody=old[map_start:]
mapbody=mapbody.replace('    let positions = List<usize>.asSlice(&selected)\n','    let roots = List<CacheImage.Root>.asSlice(&image.roots)\n')
mapbody=mapbody.replace('Semantic.appendFrontierImage(&mut self.*, &image, positions)','Semantic.appendFrontierImage(&mut self.*, image, positions)')
new='''  // Export final check and definition evidence together. This is also called before an
  // unsupported artifact path stops its workers, so a fallback does not lose valid check caches.
  effect fn importArtifactCache(self: &mut Self) -> Option<List<ArtifactImportedRoot>>
  ! Cycle | OutOfMemoryError ? &mut Allocator | &mut Types {
    if self.resolver.revisable || !Graph.recording(&self.resolver.graph) || !self.frontierCacheComplete { return Option<List<ArtifactImportedRoot>>.none() }
    let stamp = run artifactCacheStamp(&self.*)
    let workers = List<CheckWorker>.asSlice(&self.artifactWorkers)
    let mut image = match move run fetchFrontierCache(workers, Bytes.asSlice(&stamp)) {
      Option<CacheImage.Image>.Some {value} => move value
      Option<CacheImage.Image>.None => { return Option<List<ArtifactImportedRoot>>.none() }
    }
    let selected = match &self.deferredFrontierGraph {
      Option<BuildRecord.Record>.Some {value: graph} => run Semantic.completeFrontierChecks(&self.*, &mut image,
        &graph, List<FrontierCoverage>.asSlice(&self.frontierCoverage))
      Option<BuildRecord.Record>.None => run artifactCacheSelections(&image, false)
    }
    let imported = run Semantic.appendArtifactImage(&mut self.*, &image, List<usize>.asSlice(&selected))
    if let Option<List<ArtifactImportedRoot>>.Some {..} = &imported {
      self.deferredFrontierGraph = Option<BuildRecord.Record>.none()
      while let Option<DeferredFrontierSubset>.Some {value: subset} = move List<DeferredFrontierSubset>.pop(&mut self.deferredFrontierSubsets) {
        run Semantic.persistFrontierSubset(&mut self.*, Bytes.asSlice(&subset.full), Bytes.asSlice(&subset.selected),
          List<DeclarationId>.asSlice(&subset.concrete))
      }
    }
    return move imported
  }

  effect fn flushDeferredFrontierCache(self: &mut Self) -> ()
  ! Cycle | OutOfMemoryError ? &mut Allocator | &mut Types {
    if let Option<BuildRecord.Record>.Some {..} = &self.deferredFrontierGraph {
      if List<CheckWorker>.length(&self.artifactWorkers) > usize.ZERO { drop run Semantic.importArtifactCache(&mut self.*) }
    }
    self.deferredFrontierGraph = Option<BuildRecord.Record>.none()
    self.deferredFrontierSubsets = List<DeferredFrontierSubset>.make()
  }

  effect fn appendArtifactImage(self: &mut Self, image: &CacheImage.Image, positions: &[usize]) -> Option<List<ArtifactImportedRoot>>
  ! OutOfMemoryError ? &mut Allocator {
'''+mapbody
s=s[:start]+new+s[end:]
change('''      run frontierTrace(b"artifact refused", self.frontierSplit, usize.ZERO, usize.ZERO)
      stopFrontier''','''      run frontierTrace(b"artifact refused", self.frontierSplit, usize.ZERO, usize.ZERO)
      run Semantic.flushDeferredFrontierCache(&mut self.*)
      stopFrontier''')
change('''    let attempted = run Effect.result(Semantic.buildArtifactHeld(&mut self.*, &mut request.*, runtime, rootPackage, checked, closureNodes))
    stopFrontier''','''    let attempted = run Effect.result(Semantic.buildArtifactHeld(&mut self.*, &mut request.*, runtime, rootPackage, checked, closureNodes))
    let cached = run Effect.result(Semantic.flushDeferredFrontierCache(&mut self.*))
    stopFrontier''')
anchor='''    self.keepArtifactWorkers = false
    return match move attempted {
      Result<BackendBuild, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} => move value'''
change(anchor,'''    self.keepArtifactWorkers = false
    return match move attempted {
      Result<BackendBuild, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} => {
        match move cached {
          Result<(), Cycle | OutOfMemoryError>.Success {..} => move value
          Result<(), Cycle | OutOfMemoryError>.Failure {error} => { fail move error }
        }
      }''')
p.write_text(s)
