from pathlib import Path
import re
root=Path('/workspace/silk/.scratch/immutable-executable-bodies/compiler/src/backend')
body='result parameters locals blocks externs contexts traps cancels features inlining optimizeSize frame lines variables'.split()
logical='borrow references observes suspension parks releasesPackages nonParking accesses escapes'.split()
fields={x:'body' for x in body}|{x:'logical' for x in logical}
# Track syntax delimiters, respecting comments and quoted literals.
def split_parts(s):
 out=[];start=0;stack=[];i=0;quote=None
 while i<len(s):
  if s.startswith('//',i):
   end=s.find('\n',i);i=len(s) if end<0 else end;continue
  c=s[i]
  if c=='"':
   i+=1
   while i<len(s):
    if s[i]=='\\':i+=2;continue
    if s[i]=='"':i+=1;break
    i+=1
   continue
  if c in '({[':stack.append(c)
  elif c in ')}]':stack.pop()
  elif c==',' and not stack:out.append(s[start:i].strip());start=i+1
  i+=1
 if s[start:].strip():out.append(s[start:].strip())
 return out

def end_brace(s,start):
 depth=1;i=start+1
 while i<len(s):
  if s.startswith('//',i):
   e=s.find('\n',i);i=len(s) if e<0 else e;continue
  if s[i]=='"':
   i+=1
   while i<len(s):
    if s[i]=='\\':i+=2;continue
    if s[i]=='"':i+=1;break
    i+=1
   continue
  if s[i]=='{':depth+=1
  if s[i]=='}':
   depth-=1
   if depth==0:return i
  i+=1
 raise ValueError('unterminated')

for file in ['Mir.silk','DropGlue.silk','UnionDispatch.silk','MirCoalesce.silk','MirInline.silk','ExecutableTemplate.silk']:
 p=root/file;s=p.read_text();old=s
 # Rewrite all value literals (not struct/impl blocks) before new definitions exist.
 matches=list(re.finditer(r'\bMirFunction\s*\{',s))
 for m in reversed(matches):
  before=s[max(0,m.start()-12):m.start()]
  if re.search(r'(?:struct|impl)\s*$',before):continue
  a=s.index('{',m.start());b=end_brace(s,a);parts=split_parts(s[a+1:b]);by={}
  for v in parts:
   n=v.split(':',1)[0].strip();assert n in fields or n=='key',(file,n);by[n]=v
  assert set(by)==set(fields)|{'key'},(file,set(fields)-set(by))
  replacement='MirDraft {'+by['key']+', logical: LogicalMir {'+', '.join(by[n] for n in logical)+'}, body: ExecutableBody {'+', '.join(by[n] for n in body)+'}}'
  s=s[:m.start()]+replacement+s[b+1:]
 # Names used for function objects; do not rewrite unrelated Builder fields.
 names=set(re.findall(r'\b(\w+)\s*:\s*&(?:mut\s+)?MirFunction\b',old))
 if file=='ExecutableTemplate.silk':names|={'source','alias'}
 for n in names:
  for f,part in fields.items():
   s=re.sub(r'\b'+n+r'(\.\*)?\.'+f+r'\b',lambda m:n+(m[1] or '')+'.'+part+'.'+f,s)
 if file=='Mir.silk':
  for f,part in fields.items():
   s=re.sub(r'\.function\.'+f+r'\b','.function.'+part+'.'+f,s)
  # Helpers are MirDraft entries, not the enclosing Builder.
  for f,part in fields.items():
   s=re.sub(r'(\bhelpers\[[^\]]+\])\.'+f+r'\b',r'\1.'+part+'.'+f,s)
 s=s.replace('MirFunction','MirDraft')
 if file=='Mir.silk':
  start=s.index('/// The answer for one instance.');a=s.index('pub struct MirDraft {',start);b=end_brace(s,s.index('{',a))
  oldstruct=s[a:b+1]
  defs={}
  for m in re.finditer(r'  pub (\w+): ([^\n]+),',oldstruct):defs[m[1]]=m[2]
  assert set(defs)==set(fields)|{'key'},set(defs)
  def struct(name,ns):return 'pub struct '+name+' {\n'+''.join('  pub '+n+': '+defs[n]+',\n' for n in ns)+'}\n'
  new='''/// Executable instructions and metadata, frozen after all MIR transformations.
'''+struct('ExecutableBody',body)+'''\n/// Exact semantic evidence of one logical instance, independent of its executable payload.
'''+struct('LogicalMir',logical)+'''
/// Mutable lowered MIR, owned until optimization and verification finish.
pub struct MirDraft {
  pub key: InstanceKey,
  pub logical: LogicalMir,
  pub body: ExecutableBody,
}

/// A completed exact logical instance with an immutable executable payload.
pub struct MirInstance {
  pub key: InstanceKey,
  pub logical: LogicalMir,
  pub body: Frozen<ExecutableBody>,
}

/// Shared inspection of a draft or completed instance without copying its instructions.
pub struct MirView<'a> {
  pub key: &'a InstanceKey,
  pub logical: &'a LogicalMir,
  pub body: &'a ExecutableBody,
}

impl MirInstance {
  /// Borrows this exact instance and its immutable instructions together.
  pub fn view<'a>(self: &'a Self) -> MirView<'a> {
    return MirView {key: &self.key, logical: &self.logical, body: Frozen<ExecutableBody>.get(&self.body)}
  }
}
'''
  s=s[:start]+new+s[b+1:]
  s=s.replace('impl MirDraft {','''impl MirDraft {
  /// Borrows this mutable draft for read-only analysis.
  pub fn view<'a>(self: &'a Self) -> MirView<'a> {
    return MirView {key: &self.key, logical: &self.logical, body: &self.body}
  }

  /// Publishes a finished draft with a uniquely allocated immutable body.
  pub effect fn freeze(self: Self) -> MirInstance ! OutOfMemoryError ? &mut Allocator {
    return MirInstance {key: move self.key, logical: move self.logical,
      body: run Frozen<ExecutableBody>.make(move self.body)}
  }
''',1)
  s=s.replace('successors(function: &MirDraft,','successors(function: &MirView,').replace('appendSuccessors(function: &MirDraft,','appendSuccessors(function: &MirView,')
 if file=='MirInline.silk':s=s.replace('&MirDraft','&MirView')
 if file=='ExecutableTemplate.silk':
  s=s.replace('source: &MirDraft','source: &MirView')
  s=s.replace('run copy(&source, move second)','run copy(&MirDraft.view(&source), move second)')
 if file!='Mir.silk':
  # Imports split types where constructors exist, plus view readers.
  s=s.replace('  MirDraft,','  MirDraft, MirView, LogicalMir, ExecutableBody,') if file!='ExecutableTemplate.silk' else s.replace('{MirDraft,','{MirDraft, MirView, LogicalMir, ExecutableBody,')
 if file=='MirCoalesce.silk':
  s=re.sub(r'MirDraft\.(successors|appendSuccessors)\(function,',r'MirDraft.\1(&MirDraft.view(function),',s)
  s=s.replace('MirVerification.resultBorrowedBefore(function,','MirVerification.resultBorrowedBefore(&MirDraft.view(function),')
 p.write_text(s)
 print(file,len(matches),'literals/views updated')
