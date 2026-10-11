# PR #1359 handoff

Updated 2026-10-11. PR: https://github.com/silk-lang/silk/pull/1359
Branch: `selfhost-per-declaration-invalidation-note`. Base: `selfhost` at `3682c9e6`.
The commit containing this document is the current takeover checkpoint. The earlier published
implementation checkpoint was `7ca671b634cd32a6b31c50c9a874e4968108e624`.

The user requested: **refine, validate, then implement**. Their latest instruction was to push
all progress and write a handoff. The PR remains draft; do not describe this checkpoint as fully
validated or merge it before finishing the focused acceptance checks. All test/build processes
started by this session were stopped for handoff.

## Implemented

- Canonical declaration identities replace current declaration ordinals in scoped cache addresses.
  Anonymous or ambiguous owner chains retain revision scoping and exact-source selection proofs.
- `SourceRead` captures typed presence, selection, header, body, name-bucket and module-shape
  projections, including negative inputs and enclosing lexical dependencies.
- All semantic families use one validator: own source reads first, then ordered direct query
  dependencies, stopping at the first mismatch. Validation is memoized per source epoch.
- Complete result identities support dependency cutoff. Frontend facts and ordinary refusals
  have structural comparators. Trace-bearing refusals conservatively require the same handle.
  Backend comparison covers exact MIR types/instances, origins, admission edges, safety,
  region-selection sensitivity, layout child types, origin plans, emission content and LLVM text.
- `InstanceRecipe.exact` retains instruction operand lifetimes for semantic equality; runtime
  recipe encoding keeps its existing erasure contract.
- Request discovery follows the current validated dependency graph rather than treating captured
  transitive provenance as cache validity. Body hits can refresh immutable answer metadata with
  `Query.refresh`; previously returned handles remain unchanged.
- `BodyInput`, body-candidate matching, special payload-reuse events and the old body-only
  validator were deleted, with callers and tests migrated.
- The design note was rewritten around this implementation and its measured provider counts.

Locations remain deliberately conservative. `SourceUnit` indexes line starts; source-read
location digests include syntax IDs, byte spans, line and column. Moving consumed syntax forces
recomputation. Declaration-local location maps and general position-shift reuse are **not**
implemented. There is no project-wide latency or retained-memory claim.

## Evidence: passing runs versus pending checks

| Run                                   | Result             | Scope and limitation                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-implementation invalidation probe | 1 passed           | Same-width leaf edit restarted 4 Body and 4 MIR providers; 3 old body payloads were reused after restarting.                                                                                                                                  |
| Earlier implementation probe          | 3 passed, 0 failed | Two invalidation cases plus the imported Semantic case; same-width edit started 1 Body and 1 MIR, trailing comment started neither. Warm/fresh comparisons passed. This predates final equality, selection-proof and line-coordinate changes. |
| Earlier source-index root             | 7 passed, 0 failed | Predates the final source-read proof/location changes; rerun on the checkpoint.                                                                                                                                                               |
| Query root                            | 8 passed, 0 failed | Includes completed metadata refresh, retained-handle immutability, active/absent refresh rejection, cancellation, retries and existing cache cases. Query logic has not changed since this run.                                               |
| New-actor formatter checks            | Passed             | `SourceRead`, `MirIdentity`, `InvalidationCases`, `QueryCases`. SourceRead's formatting change was independently checked for identical non-comma tokens.                                                                                      |
| Markdown formatting and whitespace    | Passed             | Design note and `git diff --check`; the handoff is checked before push.                                                                                                                                                                       |

The current invalidation root has **four tests**, two of which are new and have not run:
`unchangedByteOffsetsStillObserveChangedLineCoordinates` and
`completeMirEqualityIncludesSafetyRegionsAndReportingOrigins`. The earlier two must also rerun
against the latest implementation. The imported Semantic case may make five discovered tests.

Broader acceptance has not passed. A complete four-actor root and a reduced root containing 31
selected affected tests plus core tests both exhausted a 12 GiB Node heap during bootstrap
compilation. No compiler diagnostics preceded those heap failures. A further split root
(excluding lowering tests) ran with `--max-old-space-size=14500` and was stopped after roughly
20 minutes at the user's handoff request, before producing a binary or runtime results. A short
profile showed `strictCleanupSubtermUnder` / instance unfolding and garbage collection as major
costs. This cancelled run is neither a pass nor an assertion failure.

Historical documentation-only CI run 38019698586 failed on the unrelated `http-client-tls:
IncompatibleWitness` corpus case and experimental N1 self-build. It does not validate this head.

## Resume here

1. Read `AGENTS.md` and `COMPILER_COMPATIBILITY.md`. No OpenSpec change was requested. Do not
   restore the deleted legacy Body mechanism.
2. Build and run the latest invalidation root by itself before another large combined root.
   Then rerun SourceIndexCases. QueryCases already passed with the current query implementation.
3. Run the affected signature, conformance, lowering and target cases in smaller separate roots.
   The temporary subset generator below preserves every selected test body and all original
   helpers, excluding unselected top-level test functions and unrelated aggregate test imports.
   The selected counts are 6 signature, 11 conformance, 9 lowering and 5 target tests. The previous
   combined catalog was expected to contain 51 cases; it never executed.
4. Inspect any failures rather than relaxing assertions. In particular, the signature allocation
   failure/retry assertion in `memberRevisionClaims` was provisionally changed from 6 total Body
   starts to 5: failure now occurs during validation before the parent Body provider starts, and
   the retry should recompute that caller once. This expectation still needs runtime evidence.
5. Record the actual focused results, update the design note's status and PR description, delete
   generated temporary actor copies, audit, commit and push. On `selfhost`, AGENTS.md requires
   merging after focused checks succeed without waiting for CI. Leave draft while checks remain
   incomplete. No full-suite or fresh-process determinism run is needed as handoff ceremony.

## Commands and environment

Use `/workspace/silk` as the working directory. LLVM 22.1.8 was installed at
`/workspace/silk/.scratch/llvm-22.1.8/bin`; the default clang 18 cannot compile this branch's IR.
The environment has about 18 GiB RAM and no swap. A 12288 MiB Node old-space limit was too small
for the combined roots. The cancelled split used 14500 MiB; smaller roots are still preferable.
Use the built CLI directly: `pnpm exec` attempted package installation and failed without a TTY.

```sh
export PATH=/workspace/silk/.scratch/llvm-22.1.8/bin:$PATH
export NODE_OPTIONS=--max-old-space-size=14500
node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml \
  --root src/semantic/InvalidationCases.silk --no-cache
node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml \
  --root src/semantic/SourceIndexCases.silk --no-cache
```

After generating the temporary copies, run each of these roots separately with the same command:

```text
src/semantic/InvalidationSemanticSignatureCases.silk
src/semantic/InvalidationSemanticConformanceCases.silk
src/semantic/InvalidationSemanticLoweringCases.silk
src/semantic/InvalidationTargetCases.silk
```

Do not run native builds concurrently: they write the same test artifact. Runtime `--filter`
limits execution but does not remove unrelated test bodies from bootstrap compilation.

If reusing one compiled native test executable, it requires the CLI's private uncached plan and
receipt exchange. Direct execution without a plan returns status 2. Retain the new
`/tmp/silk-test-exchange-*/plan.bin` while the CLI runs, then use:

```sh
compiler/build/test/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler \
  --silk-test-plan /tmp/retained-plan.bin --silk-test-result /tmp/receipt.bin
```

An uncached plan identifies the complete catalog and permits changing the native runtime filter
for the same executable. Do not pass the CLI-only `--no-cache` flag directly to the native binary.
No completed plan was produced by the cancelled acceptance build.

Git push works. `gh pr view` GraphQL was forbidden by the managed network policy; use the
connected GitHub metadata/update/ready/merge tools. PR #1359 is already attached to the chat.

Relevant logs retained in this workspace (not Git artifacts):

```text
/tmp/invalidation-baseline.log
/tmp/invalidation-implementation3.log
/tmp/invalidation-source-cases2.log
/tmp/invalidation-query.log
/tmp/invalidation-acceptance7.log               # full-root heap failure
/tmp/invalidation-focused-acceptance2.log       # selected-root heap failure
/tmp/invalidation-acceptance-part1.log          # cancelled 14500 MiB split build
/tmp/invalidation-final-format-check.log
```

## Temporary subset generator

Save the following as `/tmp/make-invalidation-acceptance.py` and run it from the repository root.
It is a reproduction aid for the current test files, not a permanent test harness. Generated
files were removed before this handoff commit; do not commit the duplicate actors. The script
also creates a combined root for reference, but use separate actor roots to reduce memory.

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

Remove only these generated files after acceptance testing:

```sh
rm compiler/src/InvalidationAcceptance.silk \
  compiler/src/semantic/InvalidationSemanticSignatureCases.silk \
  compiler/src/semantic/InvalidationSemanticConformanceCases.silk \
  compiler/src/semantic/InvalidationSemanticLoweringCases.silk \
  compiler/src/semantic/InvalidationTargetCases.silk
```
