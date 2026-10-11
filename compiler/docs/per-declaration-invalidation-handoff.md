# PR #1359 handoff

Updated 2026-10-11. PR: https://github.com/silk-lang/silk/pull/1359
Branch: `selfhost-per-declaration-invalidation-note`, merged with `selfhost` at `9834e15`.
Status: **parked as draft**. Focused correctness checks pass; the cold-build gate fails. The
design decision recorded in #567 must be made before more implementation work.

## Cold-build gate

Measured on one 4-core, 15 GiB container with nothing else running. The pinned seed
(`native-seed-6262fb95`) builds N1 from the head and from its base. Each N1 then rebuilds its own
source:
`build src/main.silk --emit executable --optimization speed --debug false`.

| N1 builds itself     | Wall  | User   | Peak RSS |
| -------------------- | ----- | ------ | -------- |
| base `9834e15`       | 10:30 | 612 s  | 4.71 GB  |
| head `949a4e2`       | 22:23 | 1307 s | 6.27 GB  |

The head wall time includes about one minute of gdb sampling pauses. Before `8f833c9` the head
was more than 10 times slower; CI's N2 fixpoint and native corpus jobs both hit their 45-minute
timeout on `585f503`. The gate allows at most 3% more time and 5% more peak RSS.

Fixed module-sized work per read or edge (profiled with gdb; hashed symbols named by grepping the
seed's `--emit llvm-ir` output of the same source):

- `8f833c9`: each parsed source caches its typed projections (SHA-256 was about 22% of samples).
- `b98758f`: ambiguity checks look up each owner prefix by hash instead of scanning the module.
- `949a4e2`: a per-source node-to-owner table replaces the span scan in `sourceSyntax`.

After these the profile is flat. The remaining overhead is distributed bookkeeping: projection
keys and lookups, retained read vectors and dependency ledgers, location digests, result
identities and validation evidence. The extra RSS is that retained evidence.

## Decision required before resuming

These options are recorded in #567. Do not implement either without that decision.

- (a) Record no validation evidence in a store that will never be revised, such as a one-shot
  `build`.
- (b) Make projection digests lazy: retain the observed exact source and compute projections
  only when validating a changed module.

## Correctness state

- `92df2d6`: `sealedProfileQueriesSelectStaticIf` failed because raw-syntax helpers and the
  static machine's authored cursor recorded whole-module Shape reads. Each consumer now records
  the projection it reads, and MixedBody records Name, Header, Body and Diagnostics reads.
- `4b2f15d`: SemanticStaticCases no longer compiled (stale `reused` import).

Bootstrap results on `92df2d6`/`4b2f15d`: InvalidationCases 4/4, SourceIndexCases 7/7.
Generated subset roots: signature 11/11, conformance 12/12, lowering 10/10, target 6/6. Counts
include the imported Semantic case, and the signature root also runs InvalidationCases.
`memberRevisionClaims` shows exactly 5 Body starts at runtime.

**Not yet rerun:** the semantic roots on the three memoization commits. Those commits have only
SourceIndexCases (7/7) and a full native compile by the seed. SemanticStaticCases has not run to
completion since `4b2f15d`.

## Resume here

1. Read the #567 decision on option (a) or (b), implement it, and remeasure the gate with the
   recipe above. The orchestrator's CI run on `45763bd` records fixpoint and corpus results; the
   base corpus is 410 PASS / 0 FAIL / 9 Unsupported.
2. Rerun on the final head, one root at a time with `NODE_OPTIONS=--max-old-space-size=12288`:
   InvalidationCases, SourceIndexCases, SemanticStaticCases, and the four subset roots below.
3. Record the results in the design note and the PR, delete this file, and mark the PR ready.

Bootstrap command, with LLVM 22.1.8 first on `PATH` and `SILK_TEST_CLANG` set:

```sh
node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml \
  --root src/semantic/InvalidationCases.silk --no-cache
```

Failure messages are not printed. To find a failing assertion, add `StderrWriter` notes in the
generated test copy only. Inside `Semantic.silk`, stderr I/O makes the validator suspending
(OWN0020); use marker events in the traced event log instead.

## Temporary subset generator

`--filter` does not remove unrelated test bodies from bootstrap compilation, so the affected tests
run from generated roots. Run this from the repository root; it writes
`src/semantic/Invalidation{SemanticSignature,SemanticConformance,SemanticLowering,Target}Cases.silk`
and `src/InvalidationAcceptance.silk`. Never commit the generated files; delete them afterwards.

```python
from pathlib import Path
import re
root=Path('compiler/src/semantic')
filters={
 'SemanticSignatureCases':lambda n:any(w in n.lower() for w in ['revision','negative','invalidates','genericparameterkindedit','defersunused']),
 'SemanticConformanceCases':lambda n:any(w in n.lower() for w in ['revision','bodyreuses','bodyrechecks','contractreusesecondconsumer']),
 'SemanticLoweringCases':lambda n:any(w in n.lower() for w in ['revision','recomputesafter','diagnosticreplay','reuseacrossbuild','reuseafterleafedit','signatureedit','regionsensitivitycloses','instancekeyscanonicallynumber','staticfirstsplits']),
 'TargetCases':lambda n:any(w in n.lower() for w in ['profilerevision','registeredmissing','finalprofileselects','skipsoverridden','sealedprofilequeries']),
}
def block_end(s,start):
 i=s.index('{',start);depth=0
 while i<len(s):
  if s.startswith('"""',i):
   end=s.index('"""',i+3);i=end+3;continue
  if s[i]=='"':
   i+=1
   while i<len(s):
    if s[i]=='\\':i+=2
    elif s[i]=='"':i+=1;break
    else:i+=1
   continue
  if s.startswith('//',i):
   i=s.find('\n',i)
   if i<0:raise ValueError('Unclosed declaration')
   continue
  if s.startswith('/*',i):i=s.index('*/',i+2)+2;continue
  if s[i]=='{':depth+=1
  if s[i]=='}':
   depth-=1
   if depth==0:return i+1
  i+=1
 raise ValueError('Unclosed declaration')
imports=['import semantic.InvalidationCases','import semantic.SourceIndexCases','import semantic.QueryCases']
for actor,predicate in filters.items():
 s=(root/f'{actor}.silk').read_text();ranges=[];chosen=[]
 for m in re.finditer(r'^test effect fn ([A-Za-z_][A-Za-z_0-9]*)',s,re.M):
  if predicate(m[1]):chosen.append(m[1])
  else:ranges.append((m.start(),block_end(s,m.end())))
 for a,b in reversed(ranges):s=s[:a]+s[b:]
 s=s.replace('import semantic.BorrowFieldCases\n','').replace('import semantic.ProfileAssemblyCases\n','')
 target=f'Invalidation{actor}';(root/f'{target}.silk').write_text(s)
 imports.append(f'import semantic.{target}')
 print(actor,len(chosen),len(ranges),'unrelated test bodies excluded')
Path('compiler/src/InvalidationAcceptance.silk').write_text('\n'.join(imports)+'\n')
```
