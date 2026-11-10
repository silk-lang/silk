from pathlib import Path
src=Path('/workspace/silk-combined-build/compiler/src/semantic/Semantic.silk').read_text()
p=Path('/workspace/silk-combined-current/compiler/src/semantic/Semantic.silk');s=p.read_text()
def once(text,x,y):
 assert text.count(x)==1,(x[:80],text.count(x));return text.replace(x,y,1)
def host(text):
 for a,b in [('getenv','FrontierHost.environment'),('munmap','FrontierHost.unmapShared'),('fork','FrontierHost.fork'),('close','FrontierHost.close'),('_exit','FrontierHost.exit')]:text=text.replace('unsafe '+a+'(', 'unsafe '+b+'(')
 text=text.replace('unsafe socketpair(1, 1, 0, ', 'unsafe FrontierHost.socketPair(')
 return text
s=once(s,'import semantic.FiniteBudget','import semantic.ArtifactGraph\nimport semantic.DefinitionFragments\nimport semantic.FiniteBudget')
start=src.index('struct ArtifactJob {');end=src.index('/// The semantic fact selected by a query key.',start)
block=host(src[start:end]);s=once(s,'/// The semantic fact selected by a query key.',block+'/// The semantic fact selected by a query key.')
fields=src[src.index('  artifactKeys: List<InstanceKey>,'):src.index('  frontierKeys: List<InstanceKey>,')];s=once(s,'  frontierKeys: List<InstanceKey>,',fields+'  frontierKeys: List<InstanceKey>,')
init=src[src.index('    artifactKeys: List<InstanceKey>.make(),'):src.index('    frontierKeys: List<InstanceKey>.make(),')];s=once(s,'    frontierKeys: List<InstanceKey>.make(),',init+'    frontierKeys: List<InstanceKey>.make(),')
needle='fn claimFrontier(table: [*]mut u64, digest: ContentHash, worker: usize) -> bool {'
start=src.index(needle);end=src.index('  let mut slot',start);s=once(s,needle,src[start:end].rstrip())
s=once(s,'fn frontierExperiment() -> bool {','fn frontierExperiment() -> bool {\n  if postcheckBuildExperiment() { return false }')
start=src.index('      if command[0] >= 3 && command[0] <= 6 {');end=src.index('      if command[0] != 1 && command[0] != 2',start)
s=once(s,'      if command[0] != 2 { return () }',src[start:end]+'      if command[0] != 2 { return () }')
# Preserve setup failure handling and central FILE ownership from the host cleanup.
start=s.index('          stopFrontier(List<CheckWorker>.asSlice(&workers))',s.index('          let joined = if available'))
end=s.index('          if accepted {',start)
a=src.index('          let accepted = match move joined {',src.index('let joined = run Effect.result(Semantic.joinFrontier'))
z=src.index('          if accepted {',a)
s=s[:start]+host(src[a:z])+s[end:]
# Wrap all exits; keep existing build body and its current API intact.
start=src.index('    self.keepArtifactWorkers = retainedBuildExperiment()');end=src.index('    run selectRequest(&mut self.resolver, &request.*)',start)
start2=s.index('  pub effect fn buildArtifact(');at=s.index('    run selectRequest(&mut self.resolver, &request.*)',start2)
s=s[:at]+host(src[start:end])+s[at:]
start=src.index('    // The runtime entry creates the same finite worker frontier used by check.')
end=src.index('    let mut checked = run Semantic.checkDeclarations',start)
needle='    let mut checked = run Semantic.checkDeclarations(&mut self.*, &mut request.*, checked, &exempt)'
s=once(s,needle,src[start:end]+needle)
start=src.index('    if postcheckBuildExperiment() && List<CheckWorker>.length(&self.artifactWorkers)')
end=src.index('    let built = run Semantic.buildFrom',start)
start2=s.index('  effect fn buildArtifactHeld(');at=s.index('    let built = run Semantic.buildFrom',start2)
s=s[:at]+src[start:end]+s[at:]
p.write_text(s)
