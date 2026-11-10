from pathlib import Path
import re
p=Path('/workspace/silk/.scratch/immutable-executable-bodies/compiler/src/semantic/Semantic.silk');s=p.read_text()
body='result parameters locals blocks externs contexts traps cancels features inlining optimizeSize frame lines variables'.split();logical='borrow references observes suspension parks releasesPackages nonParking accesses escapes'.split()
s=s.replace('  MirFunction,','  MirDraft, MirInstance, MirView, ExecutableBody, LogicalMir,')
s=s.replace('MirFunction.','MirDraft.')
s=s.replace('&mut MirFunction','&mut MirDraft').replace('&MirFunction','&MirView').replace('function: MirFunction','function: MirDraft')
# Arena is slot storage, while helpers remain mutable drafts until finalized.
s=s.replace('List<MirFunction>','List<MirDraft>')
s='\n'.join(line.replace('List<MirDraft>','List<MirSlot>') if '.mirValues' in line or 'mirValues:' in line else line for line in s.split('\n'))
s=s.replace('functions: &[MirFunction]','functions: &[MirSlot]')
# Remove dummy payload clearing; released arena slots explicitly own no instance.
a=s.index('// Drops what a lowered function holds, keeping its key');b=s.index('effect fn storeMir',a)
s=s[:a]+'''// An arena slot retains only identity once released; readers never see an empty fake body.
struct MirSlot {
  key: InstanceKey,
  live: Option<MirInstance>,
}

fn mirSlotView<'a>(slot: &'a MirSlot) -> MirView<'a> {
  if let Option<MirInstance>.Some {value} = &slot.live { return MirInstance.view(&value) }
  return CompilerBug.panic(b"a released MIR slot was read")
}
fn mirSlotBody<'a>(slot: &'a MirSlot) -> &'a ExecutableBody {
  return mirSlotView(slot).body
}
fn mirSlotLogical<'a>(slot: &'a MirSlot) -> &'a LogicalMir {
  return mirSlotView(slot).logical
}
effect fn freezeMirSlot(draft: MirDraft) -> MirSlot ! OutOfMemoryError ? &mut Allocator {
  let key = InstanceKey.copy(&draft.key)
  return MirSlot {key: move key, live: Option<MirInstance>.some(run MirDraft.freeze(move draft))}
}

'''+s[b:]
# Freeze every insertion, uniquely in phase1, including helpers and certified copies.
s=re.sub(r'(run List<MirSlot>\.append\(&mut resolver(?:\.\*)?\.mirValues, )move (\w+)(\))',r'\1run freezeMirSlot(move \2)\3',s)
s=s.replace('  mirReleased: List<bool>,\n','').replace('      mirReleased: List<bool>.make(),\n','')
s=s.replace('    while List<bool>.length(&self.resolver.mirReleased) < count { run List<bool>.append(&mut self.resolver.mirReleased, false) }\n','')
s=s.replace('    let mut freed = List<bool>.asMutSlice(&mut self.resolver.mirReleased)\n','')
s=s.replace('''      if !marks[at] && !freed[at] {
        emptyMir(&mut functions[at])
        freed[at] = true
        released = released + usize.ONE
      }''','''      if !marks[at] {
        if let Option<MirInstance>.Some {..} = &functions[at].live {
          functions[at].live = Option<MirInstance>.none()
          released = released + usize.ONE
        }
      }''')
# Finalized template drafts are request caches and must not pin stale revisions indefinitely.
needle='''    self.resolver.mirReleasedCount = self.resolver.mirReleasedCount + released
''';s=s.replace(needle,'''    self.resolver.executableMirs = List<ExecutableMir>.make()
'''+needle,1)
# Field grouping for function variables, including completed.function drafts.
for field in body:s=re.sub(r'\bfunction\.'+field+r'\b','function.body.'+field,s)
for field in logical:s=re.sub(r'\bfunction\.'+field+r'\b','function.logical.'+field,s)
s=s.replace('&function.key','function.key')
# inlineKnown's function is a mutable draft, not a borrowed view.
a=s.index('effect fn inlineFrameCalls');b=s.index('\neffect fn ',a+15);part=s[a:b].replace('sameInstance(function.key,','sameInstance(&function.key,');s=s[:a]+part+s[b:]
# Direct slot field readers retain exact slot keys but read payload through live accessors.
arr=r'(?P<value>(?:functions|stored|known|initialFunctions|ordinary)\[[^\]\n]+\])'
for field in body:s=re.sub(arr+r'\.'+field+r'\b',lambda m:'mirSlotBody(&'+m['value']+').'+field,s)
for field in logical:s=re.sub(arr+r'\.'+field+r'\b',lambda m:'mirSlotLogical(&'+m['value']+').'+field,s)
# Direct expression arena readers (two count sites).
s=re.sub(r'List<MirSlot>\.asSlice\(([^\n]+?)\)\[([^\]\n]+)\]\.references',r'mirSlotLogical(&List<MirSlot>.asSlice(\1)[\2]).references',s)
# Turn direct arena borrows into view values before read-only calls.
s=re.sub(r'&((?:functions|initialFunctions|ordinary)\[[^\]\n]+\])',r'&mirSlotView(&\1)',s)
# Undo wrapping nested body/logical accessors, whose input remains a slot.
s=s.replace('mirSlotBody(&mirSlotView(&','mirSlotBody(&').replace('mirSlotLogical(&mirSlotView(&','mirSlotLogical(&')
s=re.sub(r'(mirSlot(?:Body|Logical)\(&(?:functions|initialFunctions|ordinary)\[[^\]\n]+\])\)\)',r'\1)',s)
# Slot-key lookups must stay raw even when they appeared as borrowed field expressions.
s=re.sub(r'&mirSlotView\(&((?:functions|initialFunctions|ordinary)\[[^\]\n]+\])\)\.key',r'&\1.key',s)
# Standalone arena views bound to local functions need a durable local view object.
pat=r'let (\w+) = &((?:List<MirSlot>\.asSlice\([^\n]+?\)|mirSlotView\([^\n]+?\))\[[^\]\n]+\]|mirSlotView\([^\n]+\))\n'
# More direct explicit rewrites below avoid ambiguous indexing regexes.
lines=[];serial=0
for line in s.splitlines():
 m=re.match(r'(\s*)let (\w+) = &(mirSlotView\(.+\))$',line)
 if m:
  serial+=1;indent,name,expr=m.groups();temp=name+'View'+str(serial);lines += [indent+'let '+temp+' = '+expr,indent+'let '+name+' = &'+temp];continue
 m=re.match(r'(\s*)let (\w+) = &(List<MirSlot>\.asSlice\(.+\)\[[^]]+\])$',line)
 if m:
  serial+=1;indent,name,expr=m.groups();temp=name+'View'+str(serial);lines += [indent+'let '+temp+' = mirSlotView(&'+expr+')',indent+'let '+name+' = &'+temp];continue
 lines.append(line)
s='\n'.join(lines)+'\n'
# Explicit read-only boundaries for mutable drafts.
s=s.replace('&compacted)', '&MirDraft.view(&compacted))')
s=s.replace('&listed[at])','&MirDraft.view(&listed[at]))') if False else s
# Only verification call arguments are drafts at these sites.
s=s.replace('run verifyLowered(&mut resolver.*, &mut owner.*, &mut read, &listed[at])','run verifyLowered(&mut resolver.*, &mut owner.*, &mut read, &MirDraft.view(&listed[at]))')
s=s.replace('run verifyLowered(&mut resolver.*, &mut owner.*, &mut dependencies, &function)','run verifyLowered(&mut resolver.*, &mut owner.*, &mut dependencies, &MirDraft.view(&function))')
s=s.replace('ExecutableTemplate.copy(&template.function,','ExecutableTemplate.copy(&MirDraft.view(&template.function),')
s=s.replace('ExecutableTemplate.copy(&function,','ExecutableTemplate.copy(&MirDraft.view(&function),')
# Public access represents a released or absent slot as none.
a=s.index('  pub fn mirAt(');b=s.index('  /// The [`mirAt`]',a)
s=s[:a]+'''  pub fn mirAt<'a>(self: &'a Self, index: usize) -> Option<MirView<'a>> {
    let functions = List<MirSlot>.asSlice(&self.resolver.mirValues)
    if index < functions.length {
      if let Option<MirInstance>.Some {value} = &functions[index].live {
        return Option<MirView<'a>>.some(MirInstance.view(&value))
      }
    }
    return Option<MirView<'a>>.none()
  }
'''+s[b:]
p.write_text(s)
