p='compiler/src/semantic/Type.silk'
s=open(p).read().replace('import silk.core.option {Option}', 'import silk.core.option {Option}\nimport silk.core.effect {Effect}')
pos=s.index('\neffect fn rewriteType(value:')
s=s[:pos]+'''
// One simultaneous substitution shares a cache across its structural children. Invocation
// opening is suppressed under a quantified callable, so that barrier is part of the key.
// Region numbering visits occurrences rather than DAG nodes and never uses this cache.
service Rewrites {
  effect fn find(source: usize, opened: bool) -> Option<Interned<Type>> ! OutOfMemoryError ? &mut Rewrites | &mut Allocator
  effect fn keep(source: usize, opened: bool, result: Interned<Type>) -> () ! OutOfMemoryError ? &mut Rewrites | &mut Allocator
}

struct RewrittenType {source: usize, opened: bool, result: Interned<Type>}
struct RewriteTable {entries: List<RewrittenType>, lookup: InternIndex}

impl RewriteTable {
  fn make() -> RewriteTable {
    return RewriteTable {entries: List<RewrittenType>.make(), lookup: InternIndex.make()}
  }
  effect fn find(self: &mut Self, source: usize, opened: bool) -> Option<Interned<Type>>
  ! OutOfMemoryError ? &mut Allocator {
    let mut at = InternIndex.first(&self.lookup, usize.toU64(source))
    let entries = List<RewrittenType>.asSlice(&self.entries)
    while at != usize.MAX {
      if entries[at].source == source && entries[at].opened == opened {
        return Option<Interned<Type>>.some(Interned<Type>.clone(&entries[at].result))
      }
      at = InternIndex.after(&self.lookup, at)
    }
    return Option<Interned<Type>>.none()
  }
  effect fn keep(self: &mut Self, source: usize, opened: bool, result: Interned<Type>) -> ()
  ! OutOfMemoryError ? &mut Allocator {
    run List<RewrittenType>.append(&mut self.entries, RewrittenType {source: source, opened: opened, result: move result})
    return run InternIndex.record(&mut self.lookup, usize.toU64(source))
  }
}

impl Rewrites for RewriteTable {
  find: RewriteTable.find
  keep: RewriteTable.keep
}
''' + s[pos:]
# Propagate the local service through the helpers that traverse type children.
helpers=['rewriteType','rewriteTypeInside','rewriteNominal','rewrittenArguments','rewriteArgument','rewriteRow','rewriteRowInside','rewriteCallableApplication','rewriteSchemaEnvironment','rewriteOpaqueApplication']
for name in helpers:
    start=s.index('effect fn '+name+'(')
    body=s.index(' {',start)
    sig=s[start:body]
    assert '&mut Types' in sig, name
    s=s[:start]+sig.replace('&mut Types','&mut Types | &mut Rewrites')+s[body:]
# The externally called entrypoints install one local substitution cache.
import re
wrappers=[m for m in re.finditer(r'pub effect fn (applyBindings|openInvocation|instantiate|renameParameters|numberRegions|finishOpaqueApplication)\(',s)]
for m in reversed(wrappers):
    start=m.start();body=s.index(' {',start)
    depth=1;end=body+2
    while depth:
        if s[end]=='{':depth+=1
        if s[end]=='}':depth-=1
        end+=1
    text=s[body+2:end-1]
    if not re.search(r'return run rewrite(Type|Row|Argument)\(',text):continue
    text='\n    let mut rewrites = RewriteTable.make()'+text
    # The return run expression ends at its final closing parenthesis.
    at=text.index('return run rewrite');exprEnd=text.rfind(')')+1
    text=text[:exprEnd]+' |> Effect.provideMut<Rewrites>(&mut rewrites)'+text[exprEnd:]
    s=s[:body+2]+text+s[end-1:]
# Read the cache only for structural nodes, leaving cheap leaves allocation-free.
start=s.index('effect fn rewriteType(value:');body=s.index(' {',start)+2
s=s[:body]+'''
  let opened = match &invocation.* { Option<DeclarationId>.Some {..} => true _ => false }
  let memoized = !Numbering.isActive(&numbering.*) && !Interned<Type>.with<bool>(value, rewritesToItself)
  let source = Interned<Type>.address(value)
  if memoized {
    if let Option<Interned<Type>>.Some {value: found} = move run Rewrites.find(source, opened) { return move found }
  }''' + s[body:]
start=s.index('effect fn rewriteType(value:');pos=s.index('  return move rewritten',start)
s=s[:pos]+'''  if memoized { run Rewrites.keep(source, opened, Interned<Type>.clone(&rewritten)) }
'''+s[pos:]
open(p,'w').write(s)
