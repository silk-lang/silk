from pathlib import Path
p=Path('/workspace/silk/.scratch/parallel-check-experiment/compiler/src/semantic/Semantic.silk')
s=p.read_text().replace('import semantic.CacheImage {Merge}\n','import semantic.CacheImage {Merge}\nimport semantic.WalkFragments\n')
s=s.replace('  freshEscapes: bool,\n','  freshEscapes: bool,\n  frontierAvailable: bool,\n  frontierTried: bool,\n  frontierWorker: usize,\n  frontierOutput: ?*mut u8,\n  frontierUnit: usize,\n  frontierUncachedUnit: usize,\n',1)
s=s.replace('    freshEscapes: false,\n','    freshEscapes: false,\n    frontierAvailable: false,\n    frontierTried: false,\n    frontierWorker: usize.MAX,\n    frontierOutput: Pointer.null<u8>(),\n    frontierUnit: usize.MAX,\n    frontierUncachedUnit: usize.MAX,\n',1)
# Only runtime check enables frontier scheduling.
needle='    let escapes = run Semantic.keptEscapes(&mut self.*, &mut request.*, ordinal, List<usize>.asSlice(&modules),\n      List<DeclarationId>.asSlice(&concrete), false)'
assert needle in s
s=s.replace(needle,'    self.frontierAvailable = frontierExperiment() && checked.length > 32\n'+needle+'\n    self.frontierAvailable = false',1)
# Assign runtime unit before starting its captured walk.
needle='    let mut capture = BuildCapture.walk()\n    let attempted = run Effect.result(Semantic.capturedEscapes('
assert needle in s
s=s.replace(needle,'    if self.frontierAvailable { self.frontierUnit = unit }\n'+needle,1)
# Child publishes only after keptEscapes has finished its graph runs and memo.
needle='      result: run copyCheckResult(&result), captured: move captured, reads: usize.MAX})\n    return move result'
assert needle in s
s=s.replace(needle,'      result: run copyCheckResult(&result), captured: move captured, reads: usize.MAX})\n    if self.frontierWorker != usize.MAX && unit == self.frontierUnit {\n      run Semantic.publishFrontier(&mut self.*, &mut request.*, checked)\n    }\n    return move result',1)
# Never save incomplete evidence for parent's successful speculative runtime.
needle='      let memo = &escapes[at]\n      at = at + usize.ONE\n'
assert needle in s
s=s.replace(needle,needle+'      if memo.unit == self.frontierUncachedUnit { continue }\n',1)
# Once per runtime, after a genuine warm prefix and a broad pending frontier.
needle='    let mut escapesChecked = false\n    while true {\n'
assert needle in s
hook='''    let mut escapesChecked = false
    while true {
      if self.frontierAvailable && !self.frontierTried && capturing
        && List<CaptureEntry>.length(&capture.entries) >= frontierWarm()
        && frontierWidth(List<BackendVisit>.asSlice(&pending)) >= 16
        && List<Shared<Rejection>>.length(&result.rejections) == usize.ZERO
        && List<Shared<BackendGap>>.length(&result.gaps) == usize.ZERO {
        self.frontierTried = true
        let mut workers = List<CheckWorker>.make()
        let mut shard = usize.ZERO
        while shard < 4 {
          let stream = unsafe tmpfile()
          if Pointer.isNull<u8>(stream) { CompilerBug.panic(b"frontier temporary file failed") }
          let process = unsafe fork()
          if process < 0 { CompilerBug.panic(b"frontier fork failed") }
          if process == 0 {
            self.frontierWorker = shard
            self.frontierOutput = stream
            run selectFrontier(&mut pending, &mut origins, &mut capture.*, shard)
            break
          }
          run List<CheckWorker>.append(&mut workers, CheckWorker {process: process, stream: stream})
          shard = shard + usize.ONE
        }
        if self.frontierWorker == usize.MAX {
          let accepted = run Semantic.joinFrontier(&mut self.*, &request.*, List<CheckWorker>.asSlice(&workers))
          if accepted {
            self.frontierUncachedUnit = self.frontierUnit
            capture.unreplayable = true
            return move result
          }
        }
      }
'''
s=s.replace(needle,hook,1)
p.write_text(s)
