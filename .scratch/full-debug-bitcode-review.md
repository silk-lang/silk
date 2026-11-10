# Full-debug native build path review

The default native build already writes full-debug binary LLVM bitcode directly. There is no textual LLVM round-trip to remove. Several comments still call the debug representation “line-table” information, but the implementation includes source variables and their type trees.

## Actual paths

- Split/default native build: `main.compileUnits` prepares fragment/debug jobs; `driver.CodegenCache.runEach` calls `Bitcode.compileDebug`, writes those bytes to a `.bc` input, then submits Clang with `-x ir`. That Clang option accepts binary bitcode and does not imply text input.
- Monolithic native build: `main` calls `Bitcode.compileProgramDebug` and writes the returned bitcode before Clang runs.
- Failed worker retry also calls `Bitcode.compileDebug` directly.
- `BitcodeText.printDebug` in `main` is confined to explicit `Stage.LlvmIr` (`--emit llvm-ir`). The 580.7 MB baseline textual compiler census therefore does not describe a default native build intermediate.

Inspected source: `/workspace/silk/.scratch/finite-integration/compiler/src/main.silk` around 1866, 2222, 2335 and 3524; `driver/CodegenCache.silk` around 233; `backend/Bitcode.silk` around 2357 and 3882.

## Debug fidelity already encoded

`Module.encodeDebug` builds `DebugTable` then feeds the ordinary binary `Module.encodeWith` writer. `DebugTable.build` emits a full-debug compile unit, distinct function subprograms and distinct local variables. Variable markers carry source name, declaration location, parameter position and a type tree. `typeRecord` encodes basic, pointer/derived, structure and member type metadata. `writeFunctions` writes function-local slot metadata, debug-declare records, instruction locations and subprogram attachments.

Ordinary type/tuple metadata is interned. Distinct compile units, subprograms and variables retain separate identities. These are the existing debugger semantics; this review does not claim additional lexical-scope fidelity beyond what current markers express.

## Existing artifact evidence

Native Clang wrapper records under `.scratch/benchmarks/devtrace` show:

| Trace | Binary bitcode compile inputs | Text `.ll` inputs | Clang compile CPU |
|---|---:|---:|---:|
| Original module groups | 517 | 0 | 23.274 s |
| Global groups | 64 | 0 | 17.598 s |
| Interned debug metadata | 64 | 0 | 16.463 s |

These are historical diagnostic measurements, not new candidate timing claims. The extra compile job in each directory is platform C support. Captured `.bc` files were subsequently reclaimed for disk space; JSON commands, analysis summaries and measurement reports remain.

`devtrace/DEV-BUILD.md` records binary bitcode shrinking from 155.937 MB to 91.878 MB after exact debug metadata interning, with complete ELF files byte-identical off/on. One representative unit retained all 2,313 local variables and 624 subprograms while canonicalizing duplicate type records. This optimization is already integrated; it must not be counted again.

## Consequence

A new direct-bitcode/full-metadata design would duplicate the existing writer and cannot provide the hypothesized text parsing win. Remaining native-input costs are fragment/module merging, debug metadata construction, binary serialization and LLVM code generation. The existing writer emits unabbreviated records, which is a possible separate binary-writer investigation, but these artifacts do not establish a material further speedup from abbreviations. No new implementation or compiler/profile run was performed for this review.
