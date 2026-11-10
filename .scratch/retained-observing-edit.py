p='/workspace/silk-retained-build/compiler/src/semantic/Semantic.silk'
s=open(p).read()
s=s.replace('  keepArtifactWorkers: bool,','  keepArtifactWorkers: bool,\n  artifactObserving: bool,\n  artifactObservationRequired: bool,',1)
s=s.replace('    keepArtifactWorkers: false,','    keepArtifactWorkers: false,\n    artifactObserving: false,\n    artifactObservationRequired: false,',1)
s=s.replace('''    if command == 3 { return run Semantic.artifactGraphBatch(&mut self.*, payload) }
    return run Semantic.artifactEmitBatch(&mut self.*, payload)''','''    if command == 3 { return run Semantic.artifactGraphBatch(&mut self.*, payload) }
    if command == 5 {
      if !same(payload, &[1]) { return Bytes.make() }
      self.artifactObserving = true
      return run Bytes.copy(&[1])
    }
    return run Semantic.artifactEmitBatch(&mut self.*, payload)''',1)
s=s.replace('command[0] >= 2 && command[0] <= 4','command[0] >= 2 && command[0] <= 5',1)
s=s.replace('exactBackendVariant(&mut self.resolver, key, false, &Option<CoroutineFacts>.none())','exactBackendVariant(&mut self.resolver, key, self.artifactObserving, &Option<CoroutineFacts>.none())',1)
s=s.replace('exactBackendVariant(&mut self.resolver, &key, false, &Option<CoroutineFacts>.none())','exactBackendVariant(&mut self.resolver, &key, self.artifactObserving, &Option<CoroutineFacts>.none())',1)
s=s.replace('''    if function.observes { run frontierTrace(b"artifact observing", self.frontierSplit, self.frontierWorker, index)
      return Option<BuildRecord.Record>.none() }''','''    if function.observes && !self.artifactObserving {
      self.artifactObservationRequired = true
      run frontierTrace(b"artifact needs observation", self.frontierSplit, self.frontierWorker, index)
      return Option<BuildRecord.Record>.none() }''',1)
s=s.replace('let mut capture = run BuildCapture.make(false, List<BuildRoot>.asSlice(&roots))','let mut capture = run BuildCapture.make(self.artifactObserving, List<BuildRoot>.asSlice(&roots))',1)
s=s.replace('''    run BuildCapture.walked(&mut capture, usize.ZERO, &summary)
    let references''','''    run BuildCapture.walked(&mut capture, usize.ZERO, &summary)
    if function.observes { BuildCapture.flag(&mut capture, usize.ZERO, BuildRecord.FACT_OBSERVES) }
    let references''',1)
s=s.replace('''        Option<InstanceKey>.Some {value} => {
          match move run Semantic.artifactNode''','''        Option<InstanceKey>.Some {value} => {
          self.artifactObservationRequired = false
          match move run Semantic.artifactNode''',1)
s=s.replace('''            Option<BuildRecord.Record>.None => { run RuntimeEncoding.word(&mut output, 2) }''','''            Option<BuildRecord.Record>.None => {
              run RuntimeEncoding.word(&mut output, if self.artifactObservationRequired { 3 } else { 2 })
            }''',1)
s=s.replace('''      let mut healthy = true
      shard = usize.ZERO
      while shard < workers.length {
        let reply = match move run readArtifactPacket''','''      let mut healthy = true
      let mut observing = false
      shard = usize.ZERO
      while shard < workers.length {
        let reply = match move run readArtifactPacket''',1)
s=s.replace('''        while at < positions.length && healthy {''','''        while at < positions.length && !StableKey.failed(&reader) {''',1)
s=s.replace('''          } else { healthy = false }
          if StableKey.failed(&reader)''','''          } else if status == 3 { observing = true
            healthy = false
          } else { healthy = false }
          if StableKey.failed(&reader)''',1)
s=s.replace('''      if !healthy { run frontierTrace(b"artifact graph refused", started, rounds, List<ArtifactJob>.length(&jobs))''','''      if observing && !self.artifactObserving {
        shard = usize.ZERO
        while shard < workers.length {
          if !run sendArtifactPacket(workers[shard].control, 5, &[1]) { return Option<BackendBuild>.none() }
          shard = shard + usize.ONE
        }
        shard = usize.ZERO
        while shard < workers.length {
          let reply = match move run readArtifactPacket(workers[shard].control) {
            Option<Bytes>.Some {value} => move value
            Option<Bytes>.None => { return Option<BackendBuild>.none() }
          }
          if !same(Bytes.asSlice(&reply), &[1]) { return Option<BackendBuild>.none() }
          shard = shard + usize.ONE
        }
        self.artifactObserving = true
        run frontierTrace(b"artifact observing restart", started, rounds, List<ArtifactJob>.length(&jobs))
        return run Semantic.retainedArtifact(&mut self.*, roots, module, span)
      }
      if !healthy { run frontierTrace(b"artifact graph refused", started, rounds, List<ArtifactJob>.length(&jobs))''',1)
s=s.replace('ArtifactGraph.merge(List<BuildRecord.Record>.asSlice(&records), List<ContentHash>.asSlice(&selectedRoots))','ArtifactGraph.merge(List<BuildRecord.Record>.asSlice(&records), List<ContentHash>.asSlice(&selectedRoots), self.artifactObserving)',1)
s=s.replace('''    self.keepArtifactWorkers = retainedBuildExperiment()
    let attempted''','''    self.keepArtifactWorkers = retainedBuildExperiment()
    self.artifactObserving = false
    self.artifactObservationRequired = false
    let attempted''',1)
open(p,'w').write(s)
