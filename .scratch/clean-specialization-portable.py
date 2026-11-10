import sys,re
from pathlib import Path
sys.path.insert(0,'/workspace/silk/.scratch')
from silk_edit_helpers import item_span,remove
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/Specialization.silk')
s=p.read_text()
def delete(pattern):
 global s
 a,b=item_span(s,pattern)
 # Include immediately preceding documentation/comments for deleted item.
 while a>0:
  line=s.rfind('\n',0,a-1)+1
  if s[line:a].lstrip().startswith('//'): a=line
  else: break
 s=s[:a]+s[b:]
for name in ['applicationIdentity','edgeWitnesses','witnessNonGrowing','ordinaryDescent','descentRelation','familySignature']:
 delete(r'^  pub (?:effect )?fn '+name+r'\(')
for name in ['selectedField','witnesses','provesField','fieldOnPath','witnessDescent','sameClosedFamily','nonGrowing','descends','descendsUnder','producedWithin','sameFamily','sameFamilyRight','familyAddress','sameFamilyProfile','sameFamilyTargets','portableFamily','familyProfile','familyArgumentKind','familyTargets','appendFamilyTarget','familyTypeAddress','familyTypeCompleteness','familyProducer','familyChildCount','familyChildAt','familyApplicationChild','portableFamilyExample','portableFamilyClaims','ordinaryDescentClaims']:
 delete(r'^(?:effect )?fn '+name+r'\(')
for name in ['frontierPortableFamiliesPreserveUnorderedEvidence','frontierOrdinaryDescentUsesExistingRules']:
 delete(r'^test effect fn '+name+r'\(')
for name in ['FamilySignature','FamilyProfile','FamilySlot','FamilyArgumentKind','FamilyCompleteness','FamilyTargets','FamilyProducer','FieldDescent']:
 delete(r'^(?:pub )?(?:struct|enum|union) '+name+r'\b')
delete(r'^impl FieldDescent\b')
s=s.replace('  FieldWitness {pub field: FieldDescent},\n','')
a=s.index('      Edge.FieldWitness {field} => Edge.FieldWitness {')
b=s.index('      Edge.Cleanup',a)
s=s[:a]+s[b:]
a=s.index('      Edge.FieldWitness {field} => {')
b=s.index('      Edge.Cleanup',a)
s=s[:a]+s[b:]
for line in ['import semantic.Query {Cycle}\n','import semantic.Semantic {Answer, Outcome, Request, Semantic, Value}\n','import semantic.SourceIndex {NoRejection, RevisionMismatch}\n','import semantic.ContentHash {ContentHash}\n']:
 s=s.replace(line,'')
s=re.sub(r'\n{3,}','\n\n',s)
p.write_text(s)
