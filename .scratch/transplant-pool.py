from pathlib import Path
import shutil
p=Path('/workspace/silk-retained-build/compiler/src/semantic/Semantic.silk');s=p.read_text();origin=Path('/workspace/silk/.scratch/parallel-check-experiment/compiler/src/semantic');source=(origin/'Semantic.silk').read_text()
def span(text,name):
 start=text.index('  effect fn '+name+'('); opening=text.index('{',start);i=opening;depth=0;quoted=False
 while i<len(text):
  if not quoted and text[i:i+2]=='//':
   i=text.index('\n',i);continue
  if text[i]=='"':quoted=not quoted
  elif quoted and text[i]=='\\':i+=1
  elif not quoted:
   if text[i]=='{':depth+=1
   if text[i]=='}':
    depth-=1
    if depth==0:return start,i+1
  i+=1
 raise ValueError(name)
for name in ['frontierDescent','serveFrontier','frontierAdmissions','capturedEscapes']:
 a,b=span(s,name);c,d=span(source,name);s=s[:a]+source[c:d]+s[b:]
s=s.replace('  effect fn serveFrontier(self: &Self)', '  effect fn serveFrontier(self: &mut Self)',1)
needle='''      if command[0] != 1 { return () }
      let mut header: [u8; 8]'''
repl='''      if command[0] >= 2 && command[0] <= 4 {
        let payload = match move run readArtifactPacket(self.frontierControl) {
          Option<Bytes>.Some {value} => move value
          Option<Bytes>.None => { return () }
        }
        let attempted = run Effect.result(Semantic.artifactCommand(&mut self.*, command[0], Bytes.asSlice(&payload)))
        let reply = match move attempted {
          Result<Bytes, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Success {value} => move value
          Result<Bytes, Cycle | InvalidModulePath | RevisionMismatch | OutOfMemoryError>.Failure {..} => Bytes.make()
        }
        if !run replyArtifactPacket(self.frontierControl, Bytes.asSlice(&reply)) { return () }
        continue
      }
      if command[0] != 1 { return () }
      let mut header: [u8; 8]'''
assert needle in s;s=s.replace(needle,repl,1)
s=s.replace('''          stopFrontier(List<CheckWorker>.asSlice(&workers))
          let accepted = match move joined''','''          let accepted = match move joined''',1)
needle='''          if let Option<[*]mut u64>.Some {value} = move self.frontierClaims {
            drop unsafe munmap(value, 4194304)
          }
          self.frontierClaims = Option<[*]mut u64>.none()
          if accepted {'''
repl='''          if accepted && self.keepArtifactWorkers {
            self.artifactWorkers = move workers
          } else {
            stopFrontier(List<CheckWorker>.asSlice(&workers))
            if let Option<[*]mut u64>.Some {value} = move self.frontierClaims { drop unsafe munmap(value, 4194304) }
            self.frontierClaims = Option<[*]mut u64>.none()
          }
          if accepted {'''
assert needle in s;s=s.replace(needle,repl,1)
p.write_text(s)
for file in ['WalkFragments.silk','Specialization.silk']:shutil.copy2(origin/file,p.parent/file)
