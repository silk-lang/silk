from pathlib import Path
root=Path('/workspace/silk/.scratch/worker-forks/compiler/src/semantic')
p=root/'FrontierHost.silk';s=p.read_text().replace('  unsafe extern "C" fn nativeClose(fd: i32) -> i32 as "close"','  unsafe extern "C" fn nativeClose(fd: i32) -> i32 as "close"\n  unsafe extern "C" fn nativeUsleep(microseconds: u32) -> i32 as "usleep"')
s=s.replace('    pub fn available() -> bool { return true }','    pub fn available() -> bool { return true }\n    pub fn yieldWorker() -> () { drop unsafe nativeUsleep(1000) }')
s=s.replace('    pub fn available() -> bool { return false }','    pub fn available() -> bool { return false }\n    pub fn yieldWorker() -> () {}')
p.write_text(s)
p=root/'Semantic.silk';s=p.read_text().replace('unsafe _exit(', 'unsafe FrontierHost.exit(')
s=s.replace('  frontierAvailable: bool,','  frontierAvailable: bool,\n  frontierForkControl: Option<[*]mut u64>,\n  frontierChildren: List<CheckWorker>,\n  frontierForkRequested: bool,\n  frontierForkUsed: bool,\n  frontierServing: bool,')
s=s.replace('    frontierAvailable: false,','    frontierAvailable: false,\n    frontierForkControl: Option<[*]mut u64>.none(),\n    frontierChildren: List<CheckWorker>.make(),\n    frontierForkRequested: false,\n    frontierForkUsed: false,\n    frontierServing: false,')
needle='fn dynamicFrontier() -> bool {'
insert='''// At most one descendant of each original worker is resident. Four shared compute leases
// cover original work, descendant work and later graph extensions; proxy I/O holds no lease.
fn privateFrontier() -> bool {
  return ephemeralFrontier() && !Pointer.isNullMany<u8>(unsafe FrontierHost.environment(Pointer.fromSlice<u8>(b"SILK_FRONTIER_FORK_PRIVATE\\0")))
}
fn makeFrontierForkControl() -> Option<[*]mut u64> {
  if !privateFrontier() { return Option<[*]mut u64>.none() }
  let mapped = unsafe FrontierHost.mapShared(4096)
  if Pointer.addressMany<u64>(mapped) == usize.MAX { return Option<[*]mut u64>.none() }
  let table = Pointer.nonNullManyMut<u64>(mapped)
  if let Option<[*]mut u64>.Some {value} = &table {
    unsafe Atomic.store<u64>(unsafe Pointer.atMut<u64>(value, 0), 4, MemoryOrder.Relaxed)
  }
  return table
}
fn tryFrontierLease(table: [*]mut u64) -> bool {
  let slot = unsafe Pointer.atMut<u64>(table, 0)
  let mut before = unsafe Atomic.load<u64>(slot, MemoryOrder.Acquire)
  while before < 4 {
    match unsafe Atomic.compareExchange<u64>(slot, before, before + 1, MemoryOrder.AcquireRelease, MemoryOrder.Acquire) {
      CompareExchange<u64>.Exchanged {..} => { return true }
      CompareExchange<u64>.Unchanged {value} => { before = value }
    }
  }
  return false
}
fn releaseFrontierLease(table: [*]mut u64) -> () {
  drop unsafe Atomic.fetchSub<u64>(unsafe Pointer.atMut<u64>(table, 0), 1, MemoryOrder.Release)
}
fn acquireFrontierLease(table: [*]mut u64, yieldToFork: bool) -> bool {
  let mut waited = usize.ZERO
  // A dead worker must not strand another worker on a leaked lease forever. Failure causes
  // the existing parent proof refusal and serial retry, never an incomplete success.
  while waited < 60000 {
    let requests = unsafe Atomic.load<u64>(unsafe Pointer.atMut<u64>(table, 1), MemoryOrder.Acquire)
    if !(yieldToFork && waited < 100 && requests != 0) && tryFrontierLease(table) { return true }
    FrontierHost.yieldWorker()
    waited = waited + usize.ONE
  }
  return false
}
fn requestFrontierFork(table: [*]mut u64, requested: &mut bool, wanted: bool) -> () {
  if wanted == requested.* { return () }
  let slot = unsafe Pointer.atMut<u64>(table, 1)
  if wanted { drop unsafe Atomic.fetchAdd<u64>(slot, 1, MemoryOrder.Release) }
  else { drop unsafe Atomic.fetchSub<u64>(slot, 1, MemoryOrder.Release) }
  requested.* = wanted
}

// Only the private suffix is divided. An inherited Enter remains with its original root worker;
// every retained Leave still unwinds the exact active ancestry copied at the fork boundary.
effect fn selectPrivateFrontier(pending: &mut List<BackendVisit>, origins: &mut List<VisitOrigin>,
  capture: &mut BuildCapture, inherited: usize, child: bool) -> () ! OutOfMemoryError ? &mut Allocator | &mut Types {
  let mut visits = Intrinsic.replace(pending.*, List<BackendVisit>.make())
  let mut sources = Intrinsic.replace(origins.*, List<VisitOrigin>.make())
  let mut position = usize.ZERO
  let mut privateOrdinal = usize.ZERO
  while List<BackendVisit>.length(&visits) != usize.ZERO {
    let visit = List<BackendVisit>.remove(&mut visits, usize.ZERO)
    let origin = List<VisitOrigin>.remove(&mut sources, usize.ZERO)
    match move visit {
      BackendVisit.Leave => {
        run List<BackendVisit>.append(&mut pending.*, BackendVisit.Leave)
        run List<VisitOrigin>.append(&mut origins.*, origin)
      }
      BackendVisit.Enter {key, edge, span, module, cleanup, requester} => {
        let keep = if position < inherited { !child } else { (privateOrdinal % 2 == usize.ZERO) == child }
        if position >= inherited { privateOrdinal = privateOrdinal + usize.ONE }
        if keep {
          run List<BackendVisit>.append(&mut pending.*, BackendVisit.Enter {key: move key, edge: move edge,
            span: span, module: move module, cleanup: move cleanup, requester: move requester})
          run List<VisitOrigin>.append(&mut origins.*, origin)
        } else { run BuildCapture.reached(&mut capture.*, &key, origin, WalkFragments.EXTERNAL) }
      }
    }
    position = position + usize.ONE
  }
}

'''
s=s.replace(needle,insert+needle)
s=s.replace('        self.frontierClaims = makeFrontierClaims()','        self.frontierClaims = makeFrontierClaims()\n        self.frontierForkControl = makeFrontierForkControl()\n        run List<CheckWorker>.reserve(&mut self.frontierChildren, usize.ONE)')
s=s.replace('          self.frontierClaims = Option<[*]mut u64>.none()','          self.frontierClaims = Option<[*]mut u64>.none()\n          if let Option<[*]mut u64>.Some {value} = move self.frontierForkControl {\n            drop unsafe FrontierHost.unmapShared(value, 4096)\n          }\n          self.frontierForkControl = Option<[*]mut u64>.none()')
s=s.replace('    let mut inheritedOrdinal = usize.ZERO','    let mut inheritedOrdinal = usize.ZERO\n    let mut forkProbe = usize.ZERO')
needle='''      // A bounded walk that reached a callback access walks the left bodies the callback's calls'''
insert='''      // A new child inherits all freshly interned types and completed MIR without serializing
      // handles. It is retained behind this worker's control socket for later graph extension.
      if self.frontierWorker < 4 && !self.frontierForkUsed && !self.frontierServing {
        forkProbe = forkProbe + usize.ONE
        if forkProbe >= 64 {
          forkProbe = usize.ZERO
          if let Option<[*]mut u64>.Some {value: control} = &self.frontierForkControl {
            let visits = List<BackendVisit>.asSlice(&pending)
            let private = Slice.view<BackendVisit>(visits, inheritedRemaining, visits.length - inheritedRemaining)
            let wanted = frontierWidth(private) >= 16
            requestFrontierFork(control, &mut self.frontierForkRequested, wanted)
            if wanted && tryFrontierLease(control) {
              self.frontierForkUsed = true
              requestFrontierFork(control, &mut self.frontierForkRequested, false)
              let stream = unsafe FrontierHost.temporaryFile()
              let mut sockets: [i32; 2] = [-1, -1]
              let paired = !Pointer.isNull<u8>(stream) && unsafe FrontierHost.socketPair(Pointer.fromMutSlice<i32>(&mut sockets)) == 0
              let process = if paired { unsafe FrontierHost.fork() } else { -1 }
              if process < 0 {
                if paired { drop unsafe FrontierHost.close(sockets[0]) drop unsafe FrontierHost.close(sockets[1]) }
                if !Pointer.isNull<u8>(stream) { drop unsafe FrontierHost.closeFile(stream) }
                releaseFrontierLease(control)
              } else {
                let child = process == 0
                if child {
                  drop unsafe FrontierHost.close(sockets[0])
                  drop unsafe FrontierHost.close(self.frontierControl)
                  drop unsafe FrontierHost.closeFile(self.frontierOutput)
                  self.frontierControl = sockets[1]
                  self.frontierOutput = stream
                  self.frontierWorker = self.frontierWorker + 4
                } else {
                  drop unsafe FrontierHost.close(sockets[1])
                  run List<CheckWorker>.append(&mut self.frontierChildren, CheckWorker {process: process, stream: stream, control: sockets[0]})
                }
                run frontierTrace(b"private fork", self.frontierSplit, self.frontierWorker, frontierWidth(private))
                run selectPrivateFrontier(&mut pending, &mut origins, &mut capture.*, inheritedRemaining, child)
                if child { inheritedRemaining = usize.ZERO }
              }
            }
          }
        }
      }
'''
s=s.replace(needle,insert+needle)
# Both processes continue at the same initial runtime walk; children publish no module sweep claims.
s=s.replace('''    let mut at = self.frontierWorker + usize.ONE
    let mut modulesRun''','''    if let Option<[*]mut u64>.Some {value: control} = &self.frontierForkControl {
      requestFrontierFork(control, &mut self.frontierForkRequested, false)
      releaseFrontierLease(control)
      if !acquireFrontierLease(control, self.frontierWorker < 4) { unsafe FrontierHost.exit(3) }
    }
    let mut at = self.frontierWorker + usize.ONE
    let mut modulesRun''')
s=s.replace('''    while true {
      if dynamicFrontier() {''','''    while self.frontierWorker < 4 {
      if dynamicFrontier() {''')
# Fold descendants' exact completed fragments into one original worker transport.
needle='''    run frontierTrace(b"transport captures", self.frontierSplit, self.frontierWorker, memos.length)
'''
insert='''    let descendants = List<CheckWorker>.asSlice(&self.frontierChildren)
    let mut descendant = usize.ZERO
    while descendant < descendants.length {
      let mut ready: [u8; 1] = [0]
      if !frontierRead(descendants[descendant].control, &mut ready) || ready[0] != 1 { unsafe FrontierHost.exit(3) }
      let mut partial = run readFrontierPayload(unsafe FrontierHost.descriptor(descendants[descendant].stream))
      while let Option<CacheImage.Root>.Some {value} = move List<CacheImage.Root>.pop(&mut partial.roots) {
        run List<CacheImage.Root>.append(&mut image.roots, move value)
      }
      descendant = descendant + usize.ONE
    }
'''
s=s.replace(needle,needle+insert)
s=s.replace('''    run Semantic.serveFrontier(&mut self.*, &mut request.*)
    drop unsafe FrontierHost.close(self.frontierControl)''','''    if let Option<[*]mut u64>.Some {value: control} = &self.frontierForkControl { releaseFrontierLease(control) }
    self.frontierServing = true
    let served = run Effect.result(Semantic.serveFrontier(&mut self.*, &mut request.*))
    stopFrontier(List<CheckWorker>.asSlice(&self.frontierChildren))
    if let Result<(), OutOfMemoryError>.Failure {error} = move served { drop error }
    drop unsafe FrontierHost.close(self.frontierControl)''')
s=s.replace('''              found = true
              runtimeRecords = runtimeRecords + usize.ONE''','''              if !found { runtimeRecords = runtimeRecords + usize.ONE }
              found = true''')
p.write_text(s)
