from pathlib import Path
import re
root=Path('/workspace/silk/.scratch/shared-typed-bodies/compiler/src')
schemas={}
def clean(s):return re.sub(r'//[^\n]*','',s)
def extract(file,name,alias=None):
 s=clean((root/file).read_text());m=re.search(r'pub (struct|union|enum) '+name+r'\s*\{',s);assert m,(file,name)
 start=m.end();depth=1;i=start
 while depth:
  if s[i]=='{':depth+=1
  if s[i]=='}':depth-=1
  i+=1
 content=s[start:i-1]
 def fields(c):return [(x.strip(),y.strip()) for x,y in re.findall(r'pub\s+(\w+)\s*:\s*([^,]+)',c)]
 if m[1]=='struct':data=fields(content)
 elif m[1]=='enum':data=[(x.strip(),[]) for x in content.split(',') if x.strip()]
 else:
  data=[];pos=0
  while pos<len(content):
   n=re.match(r'\s*,?\s*(\w+)\s*',content[pos:])
   if not n:break
   pos+=n.end();fs=[]
   if pos<len(content) and content[pos]=='{':
    end=content.index('}',pos);fs=fields(content[pos+1:end]);pos=end+1
   data.append((n[1],fs))
 schemas[alias or name]=(m[1],data)
bodyfile=Path('semantic/TypedBody.silk');source=clean((root/bodyfile).read_text())
for name in re.findall(r'pub (?:struct|union|enum) (\w+)',source):
 if name not in ['TypedBody','InterfaceCallInputs','CallableCallInputs','IntrinsicCallInputs','RunOperand','CallArgument','BorrowStatus']:extract(bodyfile,name)
for name in ['Access','CallableMode','PrefixOperator','InfixOperator']:extract(Path('hir/Hir.silk'),name)
extract(Path('semantic/StaticValue.silk'),'IntegerType','StaticIntegerType')
for name in ['KeptRegions','KeptSlot','KeptStep','KeptStepKind']:extract(Path('semantic/Type.silk'),name)
extract(Path('semantic/Specialization.silk'),'StaticSlot')
extract(Path('semantic/SourceLocations.silk'),'Location')
extract(Path('backend/CAbi.silk'),'VariadicArgument','CAbi.VariadicArgument')
extract(Path('semantic/StorageOperation.silk'),'StorageOperation')
for name in ['Member','Primitive']:extract(Path('semantic/Intrinsic.silk'),name)
for name in ['ScalarOperation','Scalar','Code']:extract(Path('semantic/ScalarOperation.silk'),name)
# Public payload fields use imported aliases.
body_names=[n for n in schemas if n in re.findall(r'pub (?:struct|union|enum) (\w+)',source)]
header='''//! Portable ordinary typed-body payloads with receiver-local interned dictionaries.
//!
//! Capsules preserve checking stage and complete body metadata. The caller independently
//! authenticates the full provider dependency graph before publishing the decoded query answer.
//! Neither successful decoding nor ContractTyped is a runtime closure or borrow-check proof.

import semantic.BodyWire
import semantic.BodyTypes
import semantic.TypedBody {'''+', '.join(body_names+['TypedBody'])+'''}
import semantic.Type {Type, Binding, Argument, KeptRegions, KeptSlot, KeptStep, KeptStepKind}
import semantic.Types {Types}
import semantic.Lifetime {Lifetime}
import semantic.Specialization {Application, StaticSlot}
import semantic.StaticValue {Value as StaticData, IntegerType as StaticIntegerType}
import semantic.DeclarationId {DeclarationId}
import semantic.SourceLocations {Location}
import semantic.Intrinsic {Member, Primitive}
import semantic.ScalarOperation {ScalarOperation, Scalar, Code}
import semantic.StorageOperation {StorageOperation}
import hir.Hir {Access, CallableMode, PrefixOperator, InfixOperator}
import backend.CAbi
import semantic.StableKey
import semantic.RuntimeEncoding
import silk.collections.bytes {Bytes}
import silk.collections.list {List}
import silk.core.option {Option}
import silk.mem.allocator {Allocator, OutOfMemoryError}
import silk.mem.shared {Shared}
import silk.mem.frozen {Frozen}
import silk.mem.interned {Interned}
import silk.num.usize
import silk.num.u64

union Atom {
  Word {value: u64},
  Type {value: Interned<Type>},
  Lifetime {value: Interned<Lifetime>},
  Application {value: Interned<Application>},
  StaticData {value: Interned<StaticData>},
  Declaration {value: DeclarationId},
  Binding {value: Binding},
  Bytes {value: Shared<Bytes>},
}

struct Plan {
  atoms: List<Atom>,
  counting: bool,
  failed: bool,
  count: usize,
  depth: usize,
  nodes: usize,
  locals: usize,
}

struct Decode {
  types: BodyTypes.Decoder,
  nodeLimit: usize,
  localLimit: usize,
  nodes: usize,
  locals: usize,
}

fn atom(plan: &mut Plan, value: Atom) -> () {
  if plan.failed { return () }
  if plan.count >= BodyWire.STEP_LIMIT { plan.failed = true
    return () }
  plan.count = plan.count + usize.ONE
  if !plan.counting && !List<Atom>.appendWithinCapacity(&mut plan.atoms, move value) { plan.failed = true }
}

fn number(plan: &mut Plan, value: u64) -> () { atom(&mut plan.*, Atom.Word {value: value}) }

fn enter(plan: &mut Plan) -> bool {
  if plan.failed || plan.depth >= BodyWire.DEPTH_LIMIT { plan.failed = true
    return false }
  plan.depth = plan.depth + usize.ONE
  return true
}

fn leave(plan: &mut Plan) -> () { plan.depth = plan.depth - usize.ONE }

'''
out=[header];done=set()
def ident(t):return re.sub(r'[^A-Za-z0-9]','_',t)
def fail(t):return f'input.failed = true\n    return Option<{t}>.none()'
def unbox(expr,t,n,ret):return f'let {n} = match move {expr} {{ Option<{t}>.Some {{value: decoded}} => move decoded _ => {{ input.failed = true\n    return Option<{ret}>.none() }} }}'
def gen(t):
 if t in done:return
 done.add(t);id=ident(t)
 w=[];r=[]
 atommap={'Interned<Type>':'Type','Interned<Lifetime>':'Lifetime','Interned<Application>':'Application','Interned<StaticData>':'StaticData','DeclarationId':'Declaration','Binding':'Binding'}
 generic=re.fullmatch(r'(List|Option|Shared|Frozen)<(.+)>',t)
 if t in ['usize','u64','bool']:
  w=['number(&mut plan.*, '+('usize.toU64(value.*)' if t=='usize' else 'value.*' if t=='u64' else 'if value.* { 1 } else { 0 }')+')']
  r=['let raw = BodyWire.readWord(bytes, &mut input.*)']
  if t=='bool':r+=['if raw > 1 { '+fail(t)+' }','let result = raw == 1']
  elif t=='usize':r+=['if raw > usize.toU64(usize.MAX) { '+fail(t)+' }','let result = u64.toUsize(raw)']
  else:r+=['let result = raw']
 elif t in atommap:
  a=atommap[t]
  copy='DeclarationId.copy(value)' if a=='Declaration' else 'Binding {declaration: Interned<DeclarationId>.clone(&value.declaration), ordinal: value.ordinal, value: Argument.copy(&value.value)}' if a=='Binding' else t+'.clone(value)'
  w=[f'atom(&mut plan.*, Atom.{a} {{value: {copy}}})']
  r=[f'return run BodyTypes.read{a}(&mut state.types, bytes, &mut input.*)']
 elif t=='Interned<DeclarationId>':
  gen('DeclarationId');w=['planDeclarationId(&mut plan.*, Interned<DeclarationId>.get(value))']
  r=[unbox('run BodyTypes.readDeclaration(&mut state.types, bytes, &mut input.*)','DeclarationId','declaration',t),'let result = run Types.internDeclaration(move declaration)']
 elif t=='Shared<Bytes>':
  w=['atom(&mut plan.*, Atom.Bytes {value: Shared<Bytes>.clone(value)})']
  r=['let span = BodyWire.readField(bytes, &mut input.*)','if input.failed { return Option<Shared<Bytes>>.none() }','let copied = run Bytes.copy(StableKey.view(bytes, span))','let result = run Shared<Bytes>.make(move copied)']
 elif generic:
  g,inner=generic.groups();gen(inner);child=ident(inner)
  if g=='List':
   w=['let entries = List<'+inner+'>.asSlice(value)','if entries.length > BodyWire.NODE_LIMIT { plan.failed = true\n    return () }','number(&mut plan.*, usize.toU64(entries.length))','let mut at = usize.ZERO','while at < entries.length && !plan.failed {',f'  plan{child}(&mut plan.*, &entries[at])','  at = at + usize.ONE','}']
   r=['let count = BodyWire.count(bytes, &mut input.*, BodyWire.NODE_LIMIT)',f'if input.failed {{ return Option<{t}>.none() }}',f'let mut result = run {t}.makeWithCapacity(count)','let mut at = usize.ZERO','while at < count {',unbox(f'run read{child}(&mut state.*, bytes, &mut input.*)',inner,'item',t),f'run {t}.append(&mut result, move item)','at = at + usize.ONE','}']
  elif g=='Option':
   w=['match &value.* {',f'  Option<{inner}>.None => number(&mut plan.*, 0)',f'  Option<{inner}>.Some {{value: held}} => {{ number(&mut plan.*, 1)\n    plan{child}(&mut plan.*, &held) }}','}']
   r=['let tag = BodyWire.readWord(bytes, &mut input.*)',f'if tag == 0 {{ return Option<{t}>.some({t}.none()) }}','if tag != 1 { '+fail(t)+' }',unbox(f'run read{child}(&mut state.*, bytes, &mut input.*)',inner,'item',t),f'let result = {t}.some(move item)']
  elif g=='Shared':
   w=[f'{t}.with<()>(value, fn(held: &{inner}) -> () {{ plan{child}(&mut plan.*, held) }})']
   r=[unbox(f'run read{child}(&mut state.*, bytes, &mut input.*)',inner,'item',t),f'let result = run {t}.make(move item)']
  else:
   w=[f'plan{child}(&mut plan.*, {t}.get(value))'];r=[unbox(f'run read{child}(&mut state.*, bytes, &mut input.*)',inner,'item',t),f'let result = run {t}.make(move item)']
 elif t=='TypedBody':return
 elif t in schemas:
  kind,data=schemas[t]
  if kind=='struct':
   for name,ft in data:
    gen(ft);w.append(f'plan{ident(ft)}(&mut plan.*, &value.{name})')
    r.append(unbox(f'run read{ident(ft)}(&mut state.*, bytes, &mut input.*)',ft,'field_'+name,t))
   if t=='NodeId':r.append('if field_index >= state.nodeLimit { '+fail(t)+' }')
   if t=='LocalId':r.append('if field_index >= state.localLimit { '+fail(t)+' }')
   if t=='StaticIteration':r.append('if field_nodeStart > field_nodeEnd || field_nodeEnd > state.nodeLimit || field_localStart > field_localEnd || field_localEnd > state.localLimit { '+fail(t)+' }')
   r.append('let result = '+t+' {'+', '.join(n+': move field_'+n for n,_ in data)+'}')
  else:
   w=['match &value.* {'];r=['let tag = BodyWire.readWord(bytes, &mut input.*)','let result = match tag {']
   for index,(name,fs) in enumerate(data):
    pat=t+'.'+name+(' {'+', '.join(n for n,_ in fs)+'}' if fs else '')
    w.append(pat+' => { number(&mut plan.*, '+str(index)+')')
    r.append(str(index)+' => {')
    if t=='NodeKind' and name=='Recovered':
     w.append('plan.failed = true')
     r.append('input.failed = true')
    for n,ft in fs:
     gen(ft);w.append(f'plan{ident(ft)}(&mut plan.*, &{n})');r.append(unbox(f'run read{ident(ft)}(&mut state.*, bytes, &mut input.*)',ft,'field_'+n,t))
    w.append('}');r.append(t+'.'+name+(' {'+', '.join(n+': move field_'+n for n,_ in fs)+'}' if fs else ''));r.append('}')
   w.append('}');r+=['_ => { '+fail(t)+' }','}']
 else:raise Exception('unknown '+t)
 # Scope wrapper bounds every recursive aggregate; primitive and dictionary atom operations have their own bound.
 scoped=t not in ['usize','u64','bool'] and t not in atommap and t!='Interned<DeclarationId>'
 if scoped:w=['if !enter(&mut plan.*) { return () }']+w+['leave(&mut plan.*)']
 # Decoder depth is guarded by wrapper; helper handles early returns without corrupting caller nesting.
 wh=f'fn plan{id}(plan: &mut Plan, value: &{t}) -> () {{\n  '+'\n  '.join(w)+'\n}\n'
 rh=f'effect fn read{id}Value(state: &mut Decode, bytes: &[u8], input: &mut BodyWire.Reader) -> Option<{t}>\n! OutOfMemoryError ? &mut Allocator | &mut Types {{\n  '+'\n  '.join(r)
 if not (t in atommap):rh+=f'\n  if input.failed {{ return Option<{t}>.none() }}\n  return Option<{t}>.some(move result)'
 rh+='\n}\n'
 wrapper=f'effect fn read{id}(state: &mut Decode, bytes: &[u8], input: &mut BodyWire.Reader) -> Option<{t}>\n! OutOfMemoryError ? &mut Allocator | &mut Types {{\n  if !BodyWire.enterRead(&mut input.*) {{ return Option<{t}>.none() }}\n  let result = run read{id}Value(&mut state.*, bytes, &mut input.*)\n  BodyWire.leaveRead(&mut input.*)\n  return move result\n}}\n'
 out.extend([wh,rh,wrapper])
# Body aggregate fields are serialized after leading node/local counts so all references validate.
fields=[('declaration','DeclarationId','TypedBody.declarationId(value)'),('environment','Option<Environment>','TypedBody.environmentOf(value)'),('locals','List<Local>',None),('nodes','List<Node>',None),('root','NodeId',None),('dependencies','List<SignatureDependency>',None),('required','List<DeclarationId>',None),('stage','Stage','TypedBody.checkingStage(value)'),('iterations','List<StaticIteration>',None),('resolutions','List<Resolution>',None)]
done.add('TypedBody')
for _,t,_ in fields:gen(t)
# Shared typed body was generated with calls to these forward functions.
bodyplan='''fn planTypedBody(plan: &mut Plan, value: &TypedBody) -> () {
  if !enter(&mut plan.*) { return () }
  let locals = TypedBody.localSlice(value)
  let nodes = TypedBody.nodeSlice(value)
  if nodes.length > BodyWire.NODE_LIMIT - plan.nodes || locals.length > BodyWire.ENTRY_LIMIT - plan.locals {
    plan.failed = true
    leave(&mut plan.*)
    return ()
  }
  plan.nodes = plan.nodes + nodes.length
  plan.locals = plan.locals + locals.length
  number(&mut plan.*, usize.toU64(nodes.length))
  number(&mut plan.*, usize.toU64(locals.length))
  planDeclarationId(&mut plan.*, TypedBody.declarationId(value))
  planOption_Environment_(&mut plan.*, TypedBody.environmentOf(value))
'''
slices={'locals':'TypedBody.localSlice(value)','nodes':'TypedBody.nodeSlice(value)','dependencies':'TypedBody.signatureDependencies(value)','required':'TypedBody.runtimeBodies(value)','iterations':'TypedBody.staticIterations(value)','resolutions':'TypedBody.resolutionSlice(value)'}
for n,t,access in fields[2:]:
 if n in slices:
  inner=t[5:-1];bodyplan+=f'  let {n}Values = {slices[n]}\n  number(&mut plan.*, usize.toU64({n}Values.length))\n  let mut {n}At = usize.ZERO\n  while {n}At < {n}Values.length && !plan.failed {{\n    plan{ident(inner)}(&mut plan.*, &{n}Values[{n}At])\n    {n}At = {n}At + usize.ONE\n  }}\n'
 elif n=='root':bodyplan+='  let root = TypedBody.rootNode(value)\n  planNodeId(&mut plan.*, &root)\n'
 else:bodyplan+=f'  plan{ident(t)}(&mut plan.*, {access})\n'
bodyplan+='  leave(&mut plan.*)\n}\n';out.append(bodyplan)
read='''effect fn readTypedBody(state: &mut Decode, bytes: &[u8], input: &mut BodyWire.Reader) -> Option<TypedBody>
! OutOfMemoryError ? &mut Allocator | &mut Types {
  if !BodyWire.enterRead(&mut input.*) { return Option<TypedBody>.none() }
  let oldNodes = state.nodeLimit
  let oldLocals = state.localLimit
  let result = run readTypedBodyValue(&mut state.*, bytes, &mut input.*)
  state.nodeLimit = oldNodes
  state.localLimit = oldLocals
  BodyWire.leaveRead(&mut input.*)
  return move result
}

effect fn readTypedBodyValue(state: &mut Decode, bytes: &[u8], input: &mut BodyWire.Reader) -> Option<TypedBody>
! OutOfMemoryError ? &mut Allocator | &mut Types {
  let nodes = BodyWire.count(bytes, &mut input.*, BodyWire.NODE_LIMIT - state.nodes)
  let locals = BodyWire.count(bytes, &mut input.*, BodyWire.ENTRY_LIMIT - state.locals)
  if input.failed || nodes == usize.ZERO { return Option<TypedBody>.none() }
  state.nodes = state.nodes + nodes
  state.locals = state.locals + locals
  state.nodeLimit = nodes
  state.localLimit = locals
'''
for n,t,_ in fields:read+='  '+unbox(f'run read{ident(t)}(&mut state.*, bytes, &mut input.*)',t,'body_'+n,'TypedBody')+'\n'
read+='''  if List<Node>.length(&body_nodes) != nodes || List<Local>.length(&body_locals) != locals || input.failed {
    input.failed = true
    return Option<TypedBody>.none()
  }
  let body = run TypedBody.make(&body_declaration, move body_locals, move body_nodes, body_root,
    move body_dependencies, move body_required, move body_stage, move body_iterations)
  let withNames = TypedBody.withResolutions(move body, move body_resolutions)
  return Option<TypedBody>.some(TypedBody.withPortableEnvironment(move withNames, move body_environment))
}
''';out.append(read)
footer='''
/// Encodes one complete body with exact application/profile/source context supplied by the caller.
/// Unsupported type evidence or any resource limit returns none; no query is published here.
pub effect fn encode(body: &TypedBody, context: &[u8]) -> Option<Bytes>
! OutOfMemoryError ? &mut Allocator {
  if context.length > BodyWire.BYTE_LIMIT { return Option<Bytes>.none() }
  let mut plan = Plan {atoms: List<Atom>.make(), counting: true, failed: false,
    count: usize.ZERO, depth: usize.ZERO, nodes: usize.ZERO, locals: usize.ZERO}
  planTypedBody(&mut plan, body)
  if plan.failed { return Option<Bytes>.none() }
  let count = plan.count
  plan.atoms = run List<Atom>.makeWithCapacity(count)
  plan.counting = false
  plan.count = usize.ZERO
  plan.nodes = usize.ZERO
  plan.locals = usize.ZERO
  planTypedBody(&mut plan, body)
  if plan.failed || plan.count != count { return Option<Bytes>.none() }
  let mut output = BodyWire.writer()
  run BodyWire.field(&mut output, b"typed-body-capsule-v1")
  run BodyWire.field(&mut output, context)
  let mut types = BodyTypes.encoder()
  let values = List<Atom>.asSlice(&plan.atoms)
  let mut at = usize.ZERO
  while at < values.length && !output.failed {
    match &values[at] {
      Atom.Word {value} => run BodyWire.word(&mut output, value)
      Atom.Type {value} => run BodyTypes.writeType(&mut types, &mut output, &value)
      Atom.Lifetime {value} => run BodyTypes.writeLifetime(&mut types, &mut output, &value)
      Atom.Application {value} => run BodyTypes.writeApplication(&mut types, &mut output, &value)
      Atom.StaticData {value} => run BodyTypes.writeStaticData(&mut types, &mut output, &value)
      Atom.Declaration {value} => run BodyTypes.writeDeclaration(&mut types, &mut output, &value)
      Atom.Binding {value} => run BodyTypes.writeBinding(&mut types, &mut output, &value)
      Atom.Bytes {value} => {
        let count = Shared<Bytes>.with<usize>(&value, Bytes.length)
        if count > BodyWire.BYTE_LIMIT { output.failed = true }
        else {
          let mut copied = run Bytes.zeroed(count)
          Shared<Bytes>.with<()>( &value, fn(held: &Bytes) -> () {
            let from = Bytes.asSlice(held)
            let into = Bytes.asMutSlice(&mut copied)
            let mut position = usize.ZERO
            while position < from.length { into[position] = from[position]
              position = position + usize.ONE }
          })
          run BodyWire.field(&mut output, Bytes.asSlice(&copied))
        }
      }
    }
    at = at + usize.ONE
  }
  if output.failed { return Option<Bytes>.none() }
  return Option<Bytes>.some(move output.bytes)
}

/// Reconstructs owned body data and receiver-local interned types after exact context matching.
/// Failure never installs a semantic answer; the caller must validate the separate provider guard.
pub effect fn decode(bytes: &[u8], expectedContext: &[u8]) -> Option<TypedBody>
! OutOfMemoryError ? &mut Allocator | &mut Types {
  let mut input = BodyWire.reader(bytes)
  let magic = BodyWire.readField(bytes, &mut input)
  let context = BodyWire.readField(bytes, &mut input)
  if input.failed || !RuntimeEncoding.equals(StableKey.view(bytes, magic), b"typed-body-capsule-v1") ||
    !RuntimeEncoding.equals(StableKey.view(bytes, context), expectedContext) { return Option<TypedBody>.none() }
  let mut state = Decode {types: BodyTypes.decoder(), nodeLimit: usize.ZERO,
    localLimit: usize.ZERO, nodes: usize.ZERO, locals: usize.ZERO}
  let body = run readTypedBody(&mut state, bytes, &mut input)
  if !BodyWire.finished(bytes, &input) { return Option<TypedBody>.none() }
  return move body
}
''';out.append(footer)
(root/'semantic/BodyCapsule.silk').write_text('\n'.join(out));print('functions',len(done),'lines',sum(x.count('\n') for x in out))
