from pathlib import Path
p=Path('/workspace/silk/.scratch/parallel-check-experiment/compiler/src/semantic/Semantic.silk');s=p.read_text()
s=s.replace('struct CheckWorker { process: i32, stream: ?*mut u8 }','''@foreign(noCapture: .("sockets"))
unsafe extern "C" fn socketpair(domain: i32, kind: i32, protocol: i32, sockets: ?[*]mut i32) -> i32
@foreign(noCapture: .("buffer"))
unsafe extern "C" fn send(fd: i32, buffer: ?[*]const u8, length: usize, flags: i32) -> isize
unsafe extern "C" fn close(fd: i32) -> i32
struct CheckWorker { process: i32, stream: ?*mut u8, control: i32 }''')
s=s.replace('fn sharedFrontier() -> bool {',Path('/workspace/silk/.scratch/frontier-pool-helpers.txt').read_text()+'fn sharedFrontier() -> bool {',1)
s=s.replace('  frontierCoverage: List<FrontierCoverage>,','  frontierKeys: List<InstanceKey>,\n  frontierKeyDigests: DigestSet,\n  frontierControl: i32,\n  frontierCoverage: List<FrontierCoverage>,',1)
s=s.replace('    frontierCoverage: List<FrontierCoverage>.make(),','    frontierKeys: List<InstanceKey>.make(),\n    frontierKeyDigests: DigestSet.make(),\n    frontierControl: -1,\n    frontierCoverage: List<FrontierCoverage>.make(),',1)
s=s.replace('  effect fn publishFrontier(',Path('/workspace/silk/.scratch/frontier-pool-methods.txt').read_text()+'  effect fn publishFrontier(',1)
s=s.replace('''    run frontierTrace(b"worker-transport", self.frontierSplit, self.frontierWorker, List<CacheImage.Root>.length(&image.roots))
    unsafe _exit(0)''','''    run frontierTrace(b"worker-transport", self.frontierSplit, self.frontierWorker, List<CacheImage.Root>.length(&image.roots))
    drop unsafe fclose(self.frontierOutput)
    run Semantic.serveFrontier(&self.*)
    drop unsafe close(self.frontierControl)
    unsafe _exit(0)''',1)
old='''      let mut status: i32 = 0
      let waited = unsafe waitpid(workers[shard].process, Pointer.fromMutRef<i32>(&mut status), 0)
      if waited != workers[shard].process || status != 0 {''';new='''      let mut ready: [u8; 1] = [0]
      if !frontierRead(workers[shard].control, &mut ready) || ready[0] != 1 {''';assert s.count(old)==1;s=s.replace(old,new)
s=s.replace('''      if sharedFrontier() && !(run WalkFragments.admissionFree(&value, List<BuildRecord.Record>.asSlice(&records))) {''','''      if sharedFrontier() && !(run Semantic.frontierAdmissions(&self.*, &value, List<BuildRecord.Record>.asSlice(&records), workers)) {''',1)
s=s.replace('''        self.frontierClaims = makeFrontierClaims()
        let mut workers''','''        self.frontierClaims = makeFrontierClaims()
        let prior = List<InstanceKey>.asSlice(&visited)
        let mut keyAt = usize.ZERO
        while keyAt < prior.length {
          run Semantic.rememberFrontier(&mut self.*, &prior[keyAt])
          keyAt = keyAt + usize.ONE
        }
        let mut workers''',1)
old='''          if Pointer.isNull<u8>(stream) { CompilerBug.panic(b"frontier temporary file failed") }
          let process = unsafe fork()''';new='''          if Pointer.isNull<u8>(stream) { CompilerBug.panic(b"frontier temporary file failed") }
          let mut sockets: [i32; 2] = [-1, -1]
          if unsafe socketpair(1, 1, 0, Pointer.fromMutSlice<i32>(&mut sockets)) != 0 { CompilerBug.panic(b"frontier socketpair failed") }
          let process = unsafe fork()''';assert s.count(old)==1;s=s.replace(old,new)
s=s.replace('''            self.frontierWorker = shard
            self.frontierOutput = stream
            run selectFrontier''','''            drop unsafe close(sockets[0])
            let inherited = List<CheckWorker>.asSlice(&workers)
            let mut sibling = usize.ZERO
            while sibling < inherited.length {
              drop unsafe close(inherited[sibling].control)
              drop unsafe fclose(inherited[sibling].stream)
              sibling = sibling + usize.ONE
            }
            self.frontierWorker = shard
            self.frontierOutput = stream
            self.frontierControl = sockets[1]
            run selectFrontier''',1)
s=s.replace('''          run List<CheckWorker>.append(&mut workers, CheckWorker {process: process, stream: stream})
          shard = shard + usize.ONE''','''          drop unsafe close(sockets[1])
          run List<CheckWorker>.append(&mut workers, CheckWorker {process: process, stream: stream, control: sockets[0]})
          shard = shard + usize.ONE''',1)
# The old unrelated module-only experiment has no persistent control channel.
s=s.replace('CheckWorker {process: process, stream: stream}', 'CheckWorker {process: process, stream: stream, control: -1}')
s=s.replace('''          let accepted = run Semantic.joinFrontier(&mut self.*, &request.*, List<CheckWorker>.asSlice(&workers))
          if let Option''','''          let joined = run Effect.result(Semantic.joinFrontier(&mut self.*, &request.*, List<CheckWorker>.asSlice(&workers)))
          stopFrontier(List<CheckWorker>.asSlice(&workers))
          let accepted = match move joined {
            Result<bool, Cycle | OutOfMemoryError>.Success {value} => value
            Result<bool, Cycle | OutOfMemoryError>.Failure {error} => { fail move error }
          }
          if let Option''',1)
s=s.replace('''      let instance = move entered.key

      // Imported C declarations''','''      let instance = move entered.key
      if self.frontierWorker != usize.MAX { run Semantic.rememberFrontier(&mut self.*, &instance) }

      // Imported C declarations''',1)
p.write_text(s)
