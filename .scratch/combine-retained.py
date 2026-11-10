from pathlib import Path
import shutil,re
old=Path('/workspace/silk-retained-build/compiler/src')
new=Path('/workspace/silk-combined-build/compiler/src')
a=(old/'semantic/Semantic.silk').read_text();b=(new/'semantic/Semantic.silk').read_text()
def once(text,x,y):
 assert text.count(x)==1,(x[:90],text.count(x))
 return text.replace(x,y,1)
for rel in ['semantic/ArtifactGraph.silk','semantic/ArtifactGraphCases.silk','semantic/DefinitionFragments.silk','semantic/DefinitionFragmentsCases.silk','backend/EmissionPlan.silk','backend/LlvmCode.silk','semantic/TypeText.silk']:
 shutil.copyfile(old/rel,new/rel)
b=once(b,'import semantic.FiniteBudget','import semantic.ArtifactGraph\nimport semantic.DefinitionFragments\nimport semantic.FiniteBudget')
block=a[a.index('struct ArtifactJob {'):a.index('/// The semantic fact selected by a query key.')]
# No ancestry-policy switch: merged artifact closure uses the same finite command budget.
start=block.index('  // Exact graph identities select code.')
end=block.index('  effect fn retainedArtifact(',start)
block=block[:start]+block[end:]
start=block.index('fn finiteArtifactExperiment()')
end=block.index('fn artifactTraceExperiment()',start)
block=block[:start]+block[end:]
start=block.index('    // Diagnostic for the shared finite-definition admission policy:')
end=block.index('    run frontierTrace(b"artifact proved"',start)
block=block[:start]+'''    if !run WalkFragments.finiteClosed(&graph)
      || !run WalkFragments.includeBudget(&mut self.specializationBudget, &graph)
      || !run WalkFragments.escapeFree(&graph) { return Option<BackendBuild>.none() }
'''+block[end:]
# Reserve existing cmd2 GraphExtend; new commands3 roots,4 graph,5 emit,6 observing.
block=block.replace('if command == 2','if command == 3').replace('if command == 3 { return run Semantic.artifactGraphBatch','if command == 4 { return run Semantic.artifactGraphBatch').replace('if command == 5','if command == 6')
block=re.sub(r'(sendArtifactPacket\(workers\[shard\]\.control, )([2345])(,)',lambda m:m[1]+str(int(m[2])+1)+m[3],block)
block=block.replace('forkArtifactWorkers(self: &mut Self)', 'forkArtifactWorkers(self: &mut Self, request: &mut Request)')
block=block.replace('Semantic.serveFrontier(&mut self.*)', 'Semantic.serveFrontier(&mut self.*, &mut request.*)')
block=once(block,'    let answer = run demandRaw(&mut self.resolver, &mut self.query, demand, Span.make(usize.ZERO, usize.ZERO))','''    if !run Semantic.includeInstanceBudget(&mut self.*, key, usize.ZERO) { return Option<BuildRecord.Record>.none() }
    let answer = run demandRaw(&mut self.resolver, &mut self.query, demand, Span.make(usize.ZERO, usize.ZERO))
    if !run Semantic.includeAnswerBudget(&mut self.*, key, &answer) { return Option<BuildRecord.Record>.none() }''')
b=once(b,'/// The semantic fact selected by a query key.',block+'/// The semantic fact selected by a query key.')
fields=a[a.index('  artifactKeys: List<InstanceKey>,'):a.index('  frontierKeys: List<InstanceKey>,')]
b=once(b,'  frontierKeys: List<InstanceKey>,',fields+'  frontierKeys: List<InstanceKey>,')
init=a[a.index('    artifactKeys: List<InstanceKey>.make(),'):a.index('    frontierKeys: List<InstanceKey>.make(),')]
b=once(b,'    frontierKeys: List<InstanceKey>.make(),',init+'    frontierKeys: List<InstanceKey>.make(),')
# Keep the serial postcheck control experiment distinct from the retained parallel-check route.
for marker in ['fn frontierExperiment() -> bool {','fn forkExperiment() -> bool {']:
 b=once(b,marker,marker+'\n  if postcheckBuildExperiment() { return false }')
serve=a[a.index('      if command[0] >= 2 && command[0] <= 5 {'):a.index('      if command[0] != 1 { return () }',a.index('  effect fn serveFrontier('))]
serve=serve.replace('>= 2 && command[0] <= 5','>= 3 && command[0] <= 6')
b=once(b,'      if command[0] != 1 && command[0] != 2 { return () }',serve+'      if command[0] != 1 && command[0] != 2 { return () }')
# Replace only lifecycle, preserving finite join and all check accounting.
start=b.index('          let joined = run Effect.result(Semantic.joinFrontier(')
end=b.index('          if accepted {',start)
b=b[:start]+'''          let joined = run Effect.result(Semantic.joinFrontier(&mut self.*, &request.*, List<CheckWorker>.asSlice(&workers)))
          let accepted = match move joined {
            Result<bool, Cycle | OutOfMemoryError>.Success {value} => value
            Result<bool, Cycle | OutOfMemoryError>.Failure {error} => {
              stopFrontier(List<CheckWorker>.asSlice(&workers))
              if let Option<[*]mut u64>.Some {value} = move self.frontierClaims { drop unsafe munmap(value, 4194304) }
              self.frontierClaims = Option<[*]mut u64>.none()
              fail move error
            }
          }
          if accepted && self.keepArtifactWorkers {
            self.artifactWorkers = move workers
          } else {
            stopFrontier(List<CheckWorker>.asSlice(&workers))
            if let Option<[*]mut u64>.Some {value} = move self.frontierClaims { drop unsafe munmap(value, 4194304) }
            self.frontierClaims = Option<[*]mut u64>.none()
          }
'''+b[end:]
# Wrapper ensures retained processes are stopped on all early failures and ordinary exits.
start=a.index('    self.keepArtifactWorkers = retainedBuildExperiment()')
end=a.index('    run selectRequest(&mut self.resolver, &request.*)',start)
wrapper=a[start:end]
marker='''  pub effect fn buildArtifact(self: &mut Self, request: &mut Request, runtime: Option<&ModuleId>,'''
start=b.index(marker);pos=b.index('    run selectRequest(&mut self.resolver, &request.*)',start)
b=b[:pos]+wrapper+b[pos:]
start=a.index('    if postcheckBuildExperiment() && List<CheckWorker>.length(&self.artifactWorkers)')
end=a.index('    let built = run Semantic.buildFrom',start)
hook=a[start:end].replace('Semantic.forkArtifactWorkers(&mut self.*)','Semantic.forkArtifactWorkers(&mut self.*, &mut request.*)')
start=b.index('  effect fn buildArtifactHeld(');pos=b.index('    let built = run Semantic.buildFrom',start)
b=b[:pos]+hook+b[pos:]
(new/'semantic/Semantic.silk').write_text(b)
# Duplicate-body validation includes the newer finite resource metadata.
p=new/'semantic/ArtifactGraph.silk';s=p.read_text().replace('if left.flags != right.flags || left.body != right.body','if left.flags != right.flags || left.keyBytes != right.keyBytes || left.body != right.body')
s=s.replace('|| !ContentHash.equals(left.bare, right.bare) || !ContentHash.equals(left.family, right.family)', '|| !ContentHash.equals(left.bare, right.bare) || !ContentHash.equals(left.application, right.application) || !ContentHash.equals(left.family, right.family)')
p.write_text(s)
