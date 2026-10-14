# B11 part 1: native diagnostic producers (checkpoint)

Goal: give every catalog code listed in `compiler/diagnostic-coverage.json` a native producer
at the bootstrap's span, with a native Case asserting the code and span. Otherwise record why
not. Skip OWN codes and anything about lifetimes or borrowing; other sessions own those.

## How a producer is added (pattern used so far)

1. Add a `RejectionCode` member in `compiler/src/semantic/Rejection.silk` (doc comment names the
   code and rule).
2. Add a `name` arm.
3. Add a `stableCode` arm preceded by `// bootstrap: <constantName>`, where the constant comes from
   `packages/compiler/src/Diagnostic.ts`.
4. Reject at the producer in `compiler/src/semantic/Semantic.silk` (or in the parser, for PAR
   codes) with the bootstrap's span.
5. Remove the code from `compiler/diagnostic-coverage.json` by hand. It is checked, not
   generated. Then run `node compiler/scripts/DiagnosticCatalog.mjs`.
6. Add a Case to an existing `*Cases.silk` root using `rejectsSpan(&answer, RejectionCode.X, text,
   "<spelling>", occurrence)`.

## Validation commands (run from the repository root)

- Native cases, using any recent native `silkc` (ARM64 local build):
  `silkc test $PWD/compiler/src/semantic/<Root>.silk -o /tmp/x --stdlib $PWD/packages/compiler/stdlib --optimization none --no-cache`.
  A semantic root takes about 2 minutes on an unloaded machine.
- **Required before any DDC dispatch** (the T1 DDC builds the compiler with the TS bootstrap):
  build the CLI with `pnpm install --frozen-lockfile && pnpm --filter @silklang/cli... run build`.
  Then run `(cd compiler && node ../packages/cli/dist/bin.js check --manifest-path silk.toml --target x86_64-unknown-linux-gnu; echo exit=$?)`.
  It must report no `error[...]`. Watch for OWN0012/OWN0019, which come from borrowing an element
  of a temporary slice; bind the slice to a local first.
- Probe a single program: make a package directory with `silk.toml`
  (`[package] name="probe" version="0.1.0" root="src/Main.silk"`) and `src/Main.silk` (which
  needs `pub fn main() -> i32`).
  - Native: `silkc build src/Main.silk -o out.ll --emit llvm-ir --stdlib <repo>/packages/compiler/stdlib`.
  - Bootstrap: `node <repo>/packages/cli/dist/bin.js check`. It prints line:col only. For exact
    spans, patch `packages/cli/dist/Report.js` so the message format also prints
    `${self.span.start}-${self.span.end}`.
- DDC: `gh workflow run selfhost.yml --ref <branch>`, then
  `gh run list --workflow selfhost.yml --branch <branch>`. Merge only on green.

## PR1: #1673, branch `selfhost-native-producers-1`, head d18a8cf3f (rebased onto selfhost c960d3469)

Codes: PAR0003, PAR0004 and MOD0002.

- PAR0003: `parser/Expression.silk` (`reservedTemplate`).
- PAR0004: `parser/Import.silk` (`reservedFinalSegment`).
- Both are plumbed as new parser `Diagnostic` variants through `CauseCode`,
  `SourceIndex.syntaxProblems`, the SyntaxTree dump, `format/SourceSyntax` and
  `compiler/scripts/test-parser.mjs`.
- MOD0002: `resolveImport` in Semantic.silk (`RejectionCode.SelfImport`).
- The stdlib-root fixture and `.github/scripts/check-stdlib-root.mjs` now alias keyword final
  segments (`import silk.effect as effectModule`).

History:

- First DDC (run 38573451726) FAILED because the TS bootstrap rejected `Import.silk:81-86`
  (OWN0012/OWN0019).
- Fix commit d18a8cf3f binds the node slice first and reads the last element by value. It is
  pushed.
- The bootstrap `check` on the fixed tree is NOT yet confirmed. Two local runs were killed by
  memory pressure or session restarts.

**Next:**

1. Run the bootstrap check above on this branch.
2. If it is clean, dispatch the DDC.
3. Merge with `gh pr merge 1673 --merge` when green.

Native cases passed before the fix: hir/LoweringCases 59/59, SourceIndexCases 12/12,
SemanticSignatureCases 40/40.

## PR2: branch `selfhost-native-producers-2` (no PR yet), one WIP commit 7da2955fe on selfhost 7885c6871

Codes:

- SEM0156/SEM0157: `missingInfixCode` in `checkSourceInfixExpression`. Enum==int now also
  reports SEM0155 instead of SEM0135, matching the bootstrap.
- SEM0085: new `CauseCode.InvalidStaticLiteral` in `hir/Draft.silk` for undecodable text, char
  and bytes literals. `SourceIndex.authoredHasCause` lets the `Unavailable` expression route
  reject with `RejectionCode.InvalidStaticLiteral`, and `Rejection.causeCode` maps the cause.
- SEM0143: `WrittenSignature.testConflict` generalized to `headerConflict: Option<HeaderConflict>`.
  A `mut` parameter of an interface or service operation gives `MutableContractParameter` at
  the parameter span (bootstrap span = whole parameter).

Cases added:

- SemanticLoweringCases, in the expected-value-reasons test: `crossEnum`, `orderedEnum`,
  `enumEqualsInteger`, `badCharacter`, `badText`.
- SemanticConformanceCases `contractScopesAndOperationHeaders`: `Mutating.change` and
  `Counter.bump`.

The coverage JSON is updated and `DiagnosticCatalog.mjs` passes.

None of this is validated yet: no native cases run, no bootstrap check, no N1 probe.

**Next:**

1. Squash and reword the WIP commit.
2. Run the bootstrap check.
3. Run the SemanticLoweringCases and SemanticConformanceCases roots.
4. Open the PR, then dispatch the DDC after PR1 merges and you rebase.

Planned addition to PR2, not started (a half-done edit was reverted):

- SEM0164: in `resolveMembers`, in the `UnionHeader` branch, `variants.length == 0` gives
  `EmptyUnion` at `value.span`. The bootstrap span is the whole declaration, 0-14 for
  `union Empty {}`. The `UnionHeader` text occurs twice in Semantic.silk; edit the one in
  `resolveMembers`.
- SEM0166: in `recordMember`, for a `Variant` with `braces` and no field whose name is a
  `Node.Name`, report `EmptyUnionVariant` at the variant span (`B {}`).

## Survey results: bootstrap verdict vs native (minimal programs)

Each entry gives the native verdict first, then the bootstrap verdict and span.

### Producer needed or native code wrong (candidates)

Simple:

- SEM0164: native accepts `union Empty {}`. Bootstrap: span 0-14.
- SEM0166: native accepts `union U { A, B {} }`. Bootstrap: at `B {}`.
- SEM0175: native gives SEM0018 for `P { value: 1 }`, where `P` is a tuple. Fix in
  `recordFieldCount`.
- SEM0186: native accepts `extern "C" fn abs(...)` without `unsafe`. Bootstrap: at the name.
- SEM0190/SEM0191: native accepts an invalid or reserved foreign symbol. Bootstrap: at the `as`
  literal, or at the name. Fix in `foreignHeader`.
- SEM0205/SEM0206: native ignores `StructHeader.abi`. SEM0205: a generic C struct, at `<T>`.
  SEM0206: an unsupported field type, at the type annotation.
- SEM0197: native gives SEM0014 for `import silk.option { map }`. Fix in `resolveImport`: look
  the name up among inherent members.
- SEM0021: native gives SEM0028 at the field. The bootstrap reports SEM0021 at the whole
  literal when a field is inaccessible (STRUCT-002).
- SEM0093: native gives SEM0214 for `Intrinsic.assembly` on wasm32. Fix in `assemblyAdmitted`.
- SEM0141: native accepts a non-property conjunct on a representation bound, and `NonParking`
  on a plain type parameter. Fix in `declareBound`.
- SEM0068: native accepts `let mut pending = effect {...}`. Fix in `checkWrittenBinding`.
- SEM0059: native gives SEM0012 at the call for an array passed as `&[T]`. The bootstrap reports
  SEM0059 at the argument.
- SEM0203: native gives SEM0027 for a supplied interface member used as a value.
- SEM0207: native gives SEM0012 for a non-export fn as a C callback.
- SEM0222: native refuses `order.Ordering` as Unsupported.
- SEM0201: native accepts a suspending `export "C"` fn.

Medium:

- SEM0020: inline recursive struct at declaration time.
- SEM0080: callable identity join. Native gives SEM0037 or SEM0075.
- SEM0132: Effect join. Native gives SEM0049.
- SEM0145: deferred callable mutation in an effect block.
- SEM0089: native gives SEM0052.
- SEM0100: native gives SEM0012.
- SEM0104: native gives SEM0025.
- SEM0105: native accepts a representation join into a union.
- SEM0061: failure type must be detached.
- SEM0163: Effect block return join.
- SEM0174: native gives SEM0049.
- SEM0168: native refuses as Unsupported.
- SEM0122: native accepts.
- SEM0124: native gives SEM0123.
- SEM0128: native refuses as Unsupported.

### Not applicable, documented, or blocked (record as findings)

- SEM0041: the bootstrap has no producer (dead code).
- SEM0095: unreachable.
- SEM0101: internal only.
- SEM0127: unreachable; coherence rejects first with SEM0083.
- SEM0103/SEM0107: bootstrap layout fences; native supports these programs.
- SEM0199: native supports nested anonymous callables (COMPILER_COMPATIBILITY "Native anonymous
  bodies retain nested lexical captures").
- SEM0219: the bootstrap's own lowering limit.
- SEM0216/SEM0217: documented divergence in COMPILER_COMPATIBILITY (observer callback /
  observeUnhandled).
- SEM0106: documented. Native keeps SEM0076 at the constructor.
- LAY0001: reference INT-001 names SEM0002, which native reports. Question for Julia.
- SEM0169: follow-on to SEM0166.
- SEM0138/SEM0142: need allocation-provenance analysis (large).
- SEM0182: needs a static residual-growth budget.
- SEM0193/SEM0208: native refuses the whole wasm32 C ABI target.
- SEM0213 and OWN0020: skipped; other sessions own them.

## Questions for Julia

- LAY0001 vs SEM0002 for a usize literal beyond the target word: the reference says SEM0002.
- SEM0143 span: the reference says "at the keyword"; the bootstrap uses the whole parameter.
- SEM0041 has no producer in the bootstrap. Should it be removed from the catalog?
