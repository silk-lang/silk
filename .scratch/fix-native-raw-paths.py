from pathlib import Path
p=Path('compiler/src/driver/NativeCompile.silk');s=p.read_text()
s=s.replace('pub diagnostics: Bytes, pub headers: ContentHash}', 'pub diagnostics: Bytes, pub headers: ContentHash, pub cacheable: bool}')
a=s.index('// The digest of the file at `path`');b=s.index('// Pruning is optional.',a)
s=s[:a]+'''// The digest of a header, or `missing` when it cannot be read. Clang can report native
// paths containing `..`; resolving these lexically changes their meaning through symlinks.
// Resolve such names through the host and retain the original name in the header record so
// every native-object validation resolves it again. The input recorder cannot represent that
// raw lookup, so the complete artifact must not bypass this validation on the next build.
effect fn digestOf(path: &[u8], cacheable: &mut bool) -> Bytes ! OutOfMemoryError ? &mut FileSystem | &mut Allocator {
  let mut resolvedName = Bytes.make()
  let parsed = match move run Effect.result(CommandPath.fromHost(path)) {
    Result<Path, FileError | OutOfMemoryError>.Success {value} => move value
    Result<Path, FileError | OutOfMemoryError>.Failure {error} => match move error {
      FileError failure => {
        drop failure
        cacheable.* = false
        resolvedName = match move run CommandPath.canonical(path) {
          Option<Bytes>.Some {value} => move value
          Option<Bytes>.None => { return run Bytes.copy(b"missing") }
        }
        match move run Effect.result(Path.fromBytes(Bytes.asSlice(&resolvedName))) {
          Result<Path, FileError | OutOfMemoryError>.Success {value} => move value
          Result<Path, FileError | OutOfMemoryError>.Failure {error} => match move error {
            FileError invalid => { drop invalid return run Bytes.copy(b"missing") }
            OutOfMemoryError exhausted => { fail move exhausted }
          }
        }
      }
      OutOfMemoryError exhausted => { fail move exhausted }
    }
  }
  return match move run readOptional(&parsed) {
    Option<Bytes>.Some {value} => {
      let mut stream = ContentHash.stream()
      if Bytes.length(&resolvedName) > usize.ZERO {
        // A symlink retarget is significant even when the new header has identical bytes.
        ContentHash.append(&mut stream, b"resolved-native-header")
        ContentHash.appendByte(&mut stream, 0)
        ContentHash.append(&mut stream, Bytes.asSlice(&resolvedName))
        ContentHash.appendByte(&mut stream, 0)
      }
      ContentHash.append(&mut stream, Bytes.asSlice(&value))
      return run hexOf(ContentHash.finish(move stream))
    }
    Option<Bytes>.None => {
      cacheable.* = false
      return run Bytes.copy(b"missing")
    }
  }
}

'''+s[b:]
s=s.replace('cache: &Option<Bytes>, keepCache: &mut bool) -> bool ! OutOfMemoryError ? &mut FileSystem','cache: &Option<Bytes>, keepCache: &mut bool, cacheable: &mut bool) -> bool ! OutOfMemoryError ? &mut FileSystem')
s=s.replace('run digestOf(path)','run digestOf(path, &mut cacheable.*)')
s=s.replace('cache: &Option<Bytes>, keepCache: &mut bool) -> i32','cache: &Option<Bytes>, keepCache: &mut bool, cacheable: &mut bool) -> i32')
s=s.replace('run headersUnchanged(Bytes.asSlice(&recorded), cache, &mut keepCache.*)','run headersUnchanged(Bytes.asSlice(&recorded), cache, &mut keepCache.*, &mut cacheable.*)')
s=s.replace('run digestOf(Bytes.asSlice(&names[name]))','run digestOf(Bytes.asSlice(&names[name]), &mut cacheable.*)')
s=s.replace('  let mut keepCache = false\n','  let mut keepCache = false\n  let mut cacheable = true\n')
s=s.replace('&mut cacheFiles, &canonicalCache, &mut keepCache)','&mut cacheFiles, &canonicalCache, &mut keepCache, &mut cacheable)')
s=s.replace('headers: ContentHash.finish(move headerDigests)}','headers: ContentHash.finish(move headerDigests), cacheable: cacheable}')
p.write_text(s)
p=Path('compiler/src/main.silk');s=p.read_text().replace('  let mut nativeHeaders = Option<ContentHash>.none()','  let mut nativeHeaders = Option<ContentHash>.none()\n  let mut nativeCacheable = true',1)
s=s.replace('NativeBuild.Linked {inputs, diagnostics, headers} => {','NativeBuild.Linked {inputs, diagnostics, headers, cacheable} => {',1)
s=s.replace('        nativeHeaders = Option<ContentHash>.some(headers)','        nativeHeaders = Option<ContentHash>.some(headers)\n        nativeCacheable = cacheable',1)
s=s.replace('  let stamped = linked && !windows && !archive && NativeLinkInputs.onlySources(linkInputs)', '  // Raw native header paths that the input recorder cannot represent must be re-resolved.\n  // Without a link stamp, recordBuild also declines whole-artifact reuse for this build.\n  let stamped = nativeCacheable && linked && !windows && !archive && NativeLinkInputs.onlySources(linkInputs)',1)
p.write_text(s)
