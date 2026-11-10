from pathlib import Path
p=Path('compiler/src/driver/NativeCompile.silk');s=p.read_text().replace('import driver.HostRename','import driver.CommandPath\nimport driver.HostRename',1)
anchor='// Whether the header record `record`'
pos=s.index(anchor)
helper='''// Pruning is optional. If an actual native input shares the cache directory, preserve that
// directory's contents even when an authored file has the shape of a cache artifact. Resolve
// symbolic links too; inability to establish that an input is outside the cache disables pruning.
effect fn inputInCache(path: &[u8], cache: &Option<Bytes>) -> bool ! OutOfMemoryError ? &mut Allocator {
  let prefix = match &cache.* {
    Option<Bytes>.Some {value} => Bytes.asSlice(&value)
    Option<Bytes>.None => { return true }
  }
  return match move run CommandPath.canonical(path) {
    Option<Bytes>.Some {value} => {
      let resolved = Bytes.asSlice(&value)
      if resolved.length < prefix.length || !same(Slice.view<u8>(resolved, usize.ZERO, prefix.length), prefix) { return false }
      return resolved.length == prefix.length || resolved[prefix.length] == 47
    }
    Option<Bytes>.None => true
  }
}

'''
s=s[:pos]+helper+s[pos:]
s=s.replace('effect fn headersUnchanged(record: &[u8]) -> bool','effect fn headersUnchanged(record: &[u8], cache: &Option<Bytes>, keepCache: &mut bool) -> bool')
needle='    let digest = run digestOf(Slice.view<u8>(line, usize.add(0, 33), line.length - usize.add(0, 33)))'
s=s.replace(needle,'    let path = Slice.view<u8>(line, usize.add(0, 33), line.length - usize.add(0, 33))\n    if !keepCache.* { keepCache.* = run inputInCache(path, cache) }\n    let digest = run digestOf(path)')
s=s.replace('headerDigests: &mut Stream, cacheFiles: &mut MachineFileSystem) -> i32','headerDigests: &mut Stream, cacheFiles: &mut MachineFileSystem, cache: &Option<Bytes>, keepCache: &mut bool) -> i32')
s=s.replace('run headersUnchanged(Bytes.asSlice(&recorded))','run headersUnchanged(Bytes.asSlice(&recorded), cache, &mut keepCache.*)')
s=s.replace('      let digest = run digestOf(Bytes.asSlice(&names[name]))','      if !keepCache.* { keepCache.* = run inputInCache(Bytes.asSlice(&names[name]), cache) }\n      let digest = run digestOf(Bytes.asSlice(&names[name]))')
s=s.replace('  let mut shared = run Bytes.copy(b"silk-native-1\\n")','  let canonicalCache = run CommandPath.canonical(Path.rawBytes(cache))\n  let mut keepCache = false\n  let mut shared = run Bytes.copy(b"silk-native-1\\n")')
s=s.replace('        while source < sources.length {','        while source < sources.length {\n          if !keepCache { keepCache = run inputInCache(Path.rawBytes(&sources[source]), &canonicalCache) }')
s=s.replace('&mut diagnostics, &mut headerDigests, &mut cacheFiles)','&mut diagnostics, &mut headerDigests, &mut cacheFiles, &canonicalCache, &mut keepCache)')
needle='      _ => { run List<NativeLinkInput>.append(&mut linked, run NativeLinkInputs.copy(&inputs[at])) }'
replacement='''      _ => {
        let authored = match &inputs[at] {
          NativeLinkInput.Object {path} => Option<&Path>.some(&path)
          NativeLinkInput.StaticArchive {path} => Option<&Path>.some(&path)
          NativeLinkInput.SearchPath {path} => Option<&Path>.some(&path)
          NativeLinkInput.LinkerScript {path, ..} => Option<&Path>.some(&path)
          _ => Option<&Path>.none()
        }
        if let Option<&Path>.Some {value: path} = &authored {
          if !keepCache { keepCache = run inputInCache(Path.rawBytes(path), &canonicalCache) }
        }
        run List<NativeLinkInput>.append(&mut linked, run NativeLinkInputs.copy(&inputs[at]))
      }'''
assert needle in s;s=s.replace(needle,replacement)
s=s.replace('  run prune(cache, List<Bytes>.asSlice(&kept)) |> Effect.provideMut<FileSystem>(&mut cacheFiles)','  if !keepCache { run prune(cache, List<Bytes>.asSlice(&kept)) |> Effect.provideMut<FileSystem>(&mut cacheFiles) }')
p.write_text(s)
p=Path('compiler/scripts/test-native-build.ts');s=p.read_text();s=s.replace('  // Native cache metadata is disposable; authored C and headers in that same directory are\n  // inputs. Pruning preserves them, and changing the header invalidates whole-artifact reuse.','  // A header remains an authored input even when its filename looks exactly like native\n  // cache metadata. Pruning preserves it, and editing it invalidates whole-artifact reuse.')
s=s.replace('  const authoredNativeSource = \'#include "value.h"\\nint cached_header_value(void) { return VALUE; }\\n\'','  const authoredHeader = "00000000000000000000000000000000.headers"\n  const authoredNativeSource = `#include "${authoredHeader}"\\nint cached_header_value(void) { return VALUE; }\\n`')
s=s.replace('c="${authoredNativeDirectory}/input.c"','c="src/input.c"')
s=s.replace("join(authoredNativeCache, 'input.c')", "join(nativeCacheInputs, 'src/input.c')")
s=s.replace("join(authoredNativeCache, 'value.h')",'join(authoredNativeCache, authoredHeader)')
s=s.replace("'native cache pruning preserves authored source'","'native compilation preserves authored source'")
p.write_text(s)
