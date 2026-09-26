# Self-hosted Silk frontend

This directory contains the self-hosted lexer, parser, HIR lowering, semantic queries, and the
first demanded ordinary-body checks.
The current executable reads one Silk file and prints its flat AST and syntax diagnostics, or its
lowered module and declaration fingerprints in `hir` mode. It does not yet perform name resolution,
type checking, or code generation on that input. The TypeScript bootstrap compiler still builds it.

## Development branches and bootstrap

`selfhost` is the integration branch for the source-written compiler. Start native compiler work on
`selfhost-*` branches from the current `selfhost` tip, and target their pull requests at `selfhost`.
Use a hyphen after `selfhost`: Git cannot hold both the `selfhost` branch and a `selfhost/...`
branch. Keep the merged M1 history and later `main` work in this branch's ancestry.

Repairs to the TypeScript compiler, CLI, or standard library that the native compiler needs start
from a freshly fetched `main`. Review and merge each repair through a pull request targeting
`main`, with that branch's normal checks. Then fetch the merged `main` and merge it into a new
`selfhost-sync-*` branch based on the current `selfhost` tip. Review the merge and any conflict
resolution, run the focused native checks below, and target the synchronization pull request at
`selfhost`. Use a merge that retains both parents; do not copy repair commits into a private
bootstrap patch stream or reset `selfhost` onto another history. Update native feature branches
from the synchronized `selfhost` tip as needed.

For each bootstrap build, record the `selfhost` commit, the merged `main` repair commit it contains,
the host platform and LLVM target. The checkout supplies the bootstrap compiler and CLI sources in
`packages/compiler` and `packages/cli`, standard library sources in `packages/compiler/stdlib`,
and the native sources and manifest in `compiler`. Root `package.json` pins the pnpm version and
minimum Node version; `pnpm-lock.yaml` and `pnpm-workspace.yaml` determine the resolved workspace
dependencies. Install from that lockfile with `pnpm install --frozen-lockfile`, then build this
checkout's CLI with the command below. A built `dist` CLI or native executable is an output of
those recorded inputs, not an independent bootstrap source.

## In-memory semantic queries

`semantic.Semantic` resolves demanded facts from a held, immutable, in-memory
`semantic.SourceRevision.Revision`. Each public demand takes a `semantic.Semantic.Request` ledger;
a fresh ledger starts with no roots or discoveries, even when the store reuses a completed fact.
The source index parses the complete names in a requested module, but it opens an imported module
only when a demanded name needs that import. A completed answer retains direct nested dependencies,
transitive demand evidence, and exact present or absent source observations. A cache hit supplies those
facts to the new request without rerunning its nested providers. Replayed discovery appears in the
new request ledger; the event log records only queries actually started or hit. Source bytes belong
to the held revision, with no host file snapshot or mutable filesystem provider in this API.

`Semantic.revise` selects another immutable revision. The next demand validates retained source
bytes and absent paths before reuse, so changed imported headers or newly present paths recompute
affected facts and diagnostics against the new source. Unrelated source changes leave completed
facts reusable. A body can also retain its checked payload after a same-file or imported callee
body edit when its own declaration and the semantic results it consumed still match. That
validation starts a real query and records `Reuse`; it does not count as a `Hit`. Header and source
queries can run again. `Semantic.eventLog` records queries actually run or hit; replaying a completed
answer's evidence does not create synthetic nested hit events. `Semantic.sourceEvents` records source
reads and name observations. The focused source-written M1 checks use these records to prove
avoided provider reads and semantic demands; they do not measure speed. This API is not wired into
the inspection executable above.

The current semantic subset resolves local names, ordinary namespace imports, selective imports,
explicit aliases, and a hybrid namespace alias with selected members. Qualified type names have
one namespace segment and one public member segment. Import paths map to slash-separated `.silk`
logical source paths within the importing module's source origin and package. Selected public import
chains resolve to the canonical declaration. The
store resolves nongeneric type aliases and nominal type identities without inspecting fields or
layout. Written nongeneric function signatures accept primitive,
unit, and named alias or nominal parameter and result types; they do not inspect function bodies.
The supported primitive spellings are `bool`, `char`, signed and unsigned integers through 64 bits
and pointer size, `f32`, `f64`, and `string`. A missing result means unit. Public contracts reject
private nominal types; missing modules, inaccessible members, collisions, and alias or import-name
cycles produce anchored semantic rejections.

Demanded generic applications, type modifiers, complex type forms, variadic or generic functions,
failure or requirement rows, constraints, and nonstandard callable header modifiers currently
return `Unsupported` rather than a provisional type. Unused declarations with these forms are
still indexed as written names and do not require semantic resolution. `Semantic.demandBody`
checks one requested ordinary function body with fixed-width integer, `bool`, or unit parameters
and result. It accepts exact integer, Boolean, and unit literals, parameter reads, immutable scalar
and unit locals, explicit returns, and unit fallthrough. An immediate return or local annotation
selects an exact integer literal's type, including through a resolved alias. Without context, an
integer literal defaults to `i32`. For example, demanding
`answer` succeeds without checking `broken`; demanding `broken` rejects the unknown name at its
written span:

```silk,ignore
fn answer() -> i32 { return 42 }
fn broken() -> i32 { return missing }
```

`fn fits() -> u8 { return 255 }` succeeds, while `fn tooLarge() -> u8 { return 256 }` rejects the
exact out-of-range value. `fn inferred() -> u8 { let value = 255 return value }` rejects because
`value` is already `i32`; `fn annotated() -> u8 { let value: u8 = 255 return value }` succeeds.
Initializers see preceding locals and parameters, but not the binding they initialize. A local
may shadow a parameter in the function body; a second local with the same name in that block
rejects. A full direct call to a same-module or imported ordinary nongeneric function checks each
argument against its written parameter type in source order. An exact integer literal uses that
parameter as its immediate type context; an already typed local keeps its fixed type. For example,
`fn pair(first: u8, second: i32) -> i32 { return second }` accepts `pair(255, 1)`, but rejects
passing a local initialized by `255` as its first argument because that local is already `i32`.
Too many arguments, a non-callable target, and an empty call of a function that needs arguments
receive distinct rejections. A valid nonempty partial application remains `Unsupported` in this
wave.

A unit function can return `()` or fall through an empty body. A reachable non-unit fallthrough,
incompatible return, or unsupported statement or expression is an anchored
rejection. A completed body answer retains typed nodes, the current source observation, callee signature
dependencies, and required runtime-body declarations for later closure. A body demand checks only
that declaration. Thus `fn caller() -> i32 { return leaf() }` can check successfully even when
`leaf` has an invalid body; a later build must validate that required body. Mutual calls with written
signatures do not force a body-query cycle. A body demand does not execute user code or prove that
the whole program is valid. Imported calls retain positive and negative name, import, and source
observations on fresh request hits.

For example, after checking `caller`, changing only `leaf` from `return 1` to `return 2`
keeps the caller's checked payload, including when both functions share a file:

```silk,ignore
fn leaf() -> i32 { return 1 }
fn caller() -> i32 { let value = leaf() return value }
```

The edit leaves the called signature and the caller's declaration unchanged. Changing `leaf` to
`fn leaf() -> bool { return true }` makes the caller's `i32` return invalid, so it is checked again
and rejected. Adding or removing a previously missing imported declaration also updates its actual
consumers. Reused bodies carry the current source observation and current dependency evidence.
If a source edit moves the caller's syntax positions, changes its declaration, makes its owner
mapping ambiguous, or changes a dependency whose result cannot be compared exactly in this scalar
wave, the checker runs again. A changed nominal type result takes that conservative path. These
events prove only checked semantic-body reuse;
they do not imply MIR, LLVM, object, link, or persistent-cache reuse.

Ordinary runtime `if` statements require `bool` conditions and check both arms. For example,
`fn choose(flag: bool) -> i32 { if flag { return 1 } else { return 2 } }` has no reachable
fallthrough. `fn partial(flag: bool) -> i32 { if flag { return 1 } }` rejects because the false path
reaches the end, while a unit function may fall through. An arm with `return missing` rejects even
when a constant or a caller's known argument selects the other arm. A binding inside an arm stays
in that arm; another arm or a later statement cannot read it. Checked bodies retain both branch
nodes and whether each block can complete. Source after a return is still checked, although it
cannot make a completed path reachable again.

This native semantic API is not wired into the inspection executable above. Function values,
sections, methods, operators, pointer-sized types, effects, generic bodies, static evaluation,
conformance, layout, and code emission are outside the current body subset. For example,
`fn selected() -> i32 { static if true { return 1 } else { return 2 } }` produces `Unsupported`
when demanded; static selection does not use runtime branch checking. Unused declarations with
these forms remain indexed. The authored HIR keeps integer sign, radix, and exact decimal
magnitude beyond `u64`; body checking compares those digits without rounding through a
host number. Structured typed failures and cancellation release incomplete query reservations and
publication frames. A later demand can retry the same store. A fatal runtime trap ends the
process and has no such recovery guarantee. Compiler CLI integration, host-backed snapshots, and
later semantic and backend milestones remain future work.

## Inspect a source file

From the repository root:

```sh
pnpm exec silk run --manifest-path compiler/silk.toml -- compiler/src/main.silk
```

Pass one normalized relative path beneath the working directory. Absolute paths and `.`/`..`
components are rejected. File, allocation, host-input, and writer failures propagate from `main`.

The dump starts with `root #<id>`, then lists nodes in array order. Each node reports its kind and
half-open byte span. Indented lines contain child node IDs, token IDs with their kinds and spans,
or missing-token placeholders. The final section lists syntax diagnostics. Lexical diagnostics
are printed alongside invalid tokens. IDs belong to this tree only.

After a successful build, running the executable directly avoids rebuilding it. For example, on
Apple Silicon with the debug LLVM target:

```sh
compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler compiler/src/main.silk
```

## Inspect a lowered module

Prefix the path with `hir` to lower the file instead of dumping its syntax tree:

```sh
pnpm exec silk run --manifest-path compiler/silk.toml -- hir compiler/src/main.silk
```

Pass one normalized relative path, as in the syntax mode: `Path.joinUtf8` rejects absolute paths,
so an absolute argument fails with a file error rather than a lowering error.

The dump opens with the module's `//!` documentation and the declaration range, then lists every
arena node in postorder: `#<index> <kind> <start>..<end>`, one indented line per field, and a
`causes` line on any node that recorded recovery. Sections follow in a fixed order — `causes`,
`diagnostics`, `fingerprints` naming each declaration's owner key with its header and body digests
as hexadecimal, and `violations` reporting what `Hir.verify` found. Each section opens with its own
`<name> <count>` line, so a reader can check that a section holds what it announces.

A field occupies exactly one line. A child identity prints as `#id`, an absent child as `none`, a
child range as `[#a #b]`, a span as `start..end`, and an interned symbol as quoted text with `"`,
`\`, and the line breaks escaped, so a module documentation block or a text literal containing a
quote never closes its field early or opens a line the reader cannot classify. A `#<number>` inside
an owner key counts same-key siblings and is not an arena identity.

The text depends only on module content, so two builds of one file agree byte for byte. This is a
debug dump; the output is not a stable format.

## Representation and recovery

`SyntaxTree` owns the source `Bytes`, the complete token vector (including trivia), a flat node
vector, the root ID, and syntax diagnostics. A `NodeId` is exactly an index into that node vector.
Children are appended before parents; the source-file root is last. Nodes contain only their
kind, span, and direct `Element` vector. No child node or token payload is copied into a parent.

The parser reads significant tokens but retains trivia in the original token vector. Source bytes
allow contextual identifiers such as `where`, `with`, and `operator` to remain ordinary identifiers
elsewhere. `Parser.parse` takes ownership of both the bytes and their corresponding token vector;
those inputs must describe the same file.

Missing tokens produce zero-width placeholders and diagnostics. Unexpected source is retained in
error nodes. List and block loops enforce cursor progress, and recursive rules have a stack-safety
bound with iterative recovery. A malformed child does not invalidate valid siblings. Syntax
problems are result values, not effect failures; allocation failure is still an effect failure.
The AST inspection executable intentionally prints the recovered result instead of stopping at
its first syntax diagnostic. A future compilation driver can stop on that diagnostic.

## Lowered representation

`hir/Hir.silk` defines the target of lowering: a `Module` is one postorder node arena where a
`HirId` is exactly an index and children precede parents. A node owns no heap vector — single
children are `HirId`, optional children are `HirRef`, and lists are `Range` runs into one shared
child vector. Every byte string is interned through `hir/Intern.silk`, so a module holds no source
bytes and no `SyntaxTree`; `spans` and `nodeCauses` run parallel to `nodes` and keep coordinates
only. Every tagged record of the bootstrap `AuthoredHir` has a counterpart variant; the module doc
comment lists each deliberate difference.

`Hir.write` dumps a module as indented text and `Hir.render` produces the same bytes in an owned
buffer, so a test can compare a lowered module against expected text. `Hir.verify` reports the
arena invariants a module violates rather than asserting them, which replaces the bootstrap's
structured-clone publication step: `spans` and `nodeCauses` have the same length as `nodes`, every
child identity precedes the node referencing it and stays inside the arena, every child range,
cause range, symbol, and top-level declaration identity lies inside its storage, and every missing
or invalid node records at least one cause. `Hir.writeViolations` runs it and prints the result as
the dump's last section, so the `hir` mode reports a defect instead of printing a broken arena
silently. It verifies arena consistency, not lowering fidelity.

One reference is deliberately not an ownership edge. `IdentifierExpression.binding` names the
binder the identifier resolves to, which the block, parameter list, or pattern that declares it
already owns, so a binder is pointed at once per reader. Following it would reach a node twice.
Every other reference is an ownership edge, which makes the arena a forest rooted in the
declaration range.

That forest property — every node reached exactly once from the declaration range, and every
child's span inside its parent's — is the one arena invariant `Hir.verify` does not check. Proving
it needs a second traversal carrying a per-node owner count through all 132 variants of the
exhaustive field walk, only to distinguish the single resolution edge from every ownership edge.
`lower-corpus.mjs` below proves it instead, over every fixture, self-hosted source, and standard
library module, which is where an orphan would actually appear.

`hir/Draft.silk` owns the module while it is being built. Every node enters the arena through
`Draft.append`, which pushes one `nodes`, one `spans`, and one `nodeCauses` entry together, so the
three parallel vectors cannot drift. Child lists and recovery-cause runs are collected on scratch
vectors and copied into the module's shared storage when they close. Lexical binders use one flat
vector with a frame-start stack, so opening and closing a scope truncates rather than allocates.
The syntax accessors, the recovery-cause selection, and the name, path, and literal lowerings port
the bootstrap `AuthoredLowering` helpers of the same names; the literal decoders port
`internal/IntegerLiteral`, `internal/DurationLiteral`, `LiteralForm`, `StaticText`, and
`internal/Escape`. Integer magnitudes are exact interned decimal digits; their sign and written
radix stay separate. Floating and duration magnitudes remain `u64` and can have overflow causes.

`hir/LowerType.silk` lowers every type operand, generic binder list, row, `where` constraint, and
callable contract. `LowerType.lowerType` is the one type entry point: it unwraps grouping
parentheses in place, so a parenthesized type leaves no node, and retains a lifetime, a bare
requirement, or a damaged region in a type position as an invalid type. `LowerType.rowOperand`
selects between a type and a written requirement wherever a row admits both.
`LowerType.callableContract` reads the contract pieces directly off a callable header, because the
grammar attaches them there rather than to a node of their own.

`hir/LowerExpression.silk`, `hir/LowerPattern.silk`, and `hir/LowerStatement.silk` lower bodies.
They import one another the way the parser modules do, because an expression holds blocks, a block
holds statements, and a statement holds patterns and expressions. `LowerExpression.lowerExpression`
unwraps grouping parentheses in place, resolves every identifier against the draft's frame stack,
and leaves an unbound one absent for a later resolution phase. `LowerStatement.lowerBlock` opens
one frame per block, and a binding statement binds only after its initializer is lowered, so
`let x = x` reads the outer `x`. An `else if` chain nests: the chained conditional is the
`elseBranch` of the one before it, never a flat list. `LowerExpression.propertyClauses` lowers the
`with ns.op(key: value)` clauses a declaration or a foreign function type writes, keeping written
order and duplicate keys for a later validation phase.

`hir/LowerDeclaration.silk` lowers one declaration into three nodes: a header, a body, and the
`Declaration` that pairs them with an `OwnerKey`. The key is the declaration's source-independent
logical name — a category, an interned name, and the occurrence among same-key siblings — so moving
a declaration within its file does not rename it. Occurrence counting is per parent, not per module:
a `Scope` holds the keys already issued under one parent, and every members body opens a fresh one,
so two same-named functions in different implementations both take occurrence zero. A declaration
also interns the `///` block attached to it, following the bootstrap `DocBlock.ofNode` attachment
rules: exactly one line break between the block and the declaration, and every comment on its own
line. A static conditional lowers both arms, including the one its condition will not select.

`hir/Lower.silk` is the one HIR entry point. `Lower.lower(&SyntaxTree)` interns the leading `//!`
block as the module documentation, lowers every top-level declaration under one key scope, copies
the lexical and parser diagnostics into module coordinates, and answers a `Module` that refers to
nothing in the tree, which the caller then drops.

`hir/Fingerprint.silk` turns a lowered declaration into the content key a later incremental cache
compares. `Fingerprint.header` and `Fingerprint.body` encode a declaration's two halves as a flat
sequence of tag-and-length frames: a node frames its grammar category and then one frame per field
in declared order, a symbol frames the bytes it interns rather than its index, a child frames
inline rather than as an arena identity, a recovery cause frames its code without its span, and a
binder reference frames the binder's preorder ordinal within the declaration. Spans, `HirId`
values, sibling declarations, trivia, and the string table's layout never reach the bytes, so
reordering two declarations or interning extra strings beforehand leaves both encodings untouched.
`Fingerprint.headerDigest` and `Fingerprint.bodyDigest` are the SHA-256 of those bytes, and
`Fingerprint.moduleDigest` covers the module documentation and every declaration's two digests in
written order, which is the one place declaration order does count. The cache itself is out of
scope; these are its primitives.

CST construction remains postponed. The token vector retains source information, but there is no
second concrete-syntax tree to maintain.

Recursive rules share a budget of 32 active grammar operations. This counts parser operations,
not just parentheses: nested blocks, types, patterns, and expressions share the same budget.
Siblings restore their parent's depth. Exceeding the budget reports `NestingLimit` and skips the
damaged branch without recursive recovery. The budget is an implementation resource limit, not
a Silk grammar restriction or a limit on file size. The previous value of 256 exceeded the
available stack in the bootstrap-generated debug executable before recovery could run.

## Grammar modules

| Module                                         | Responsibility                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lexer/`                                   | Pull-based byte scanner, tokens, spans, and lexical diagnostics                                                                                |
| `parser/ParseState.silk`                       | Ownership-threaded cursor, node construction, contextual spelling, and recovery primitives                                                     |
| `parser/Parser.silk`                           | Source-file loop and final tree assembly                                                                                                       |
| `parser/Import.silk`                           | Module paths, aliases, selected members, and public imports                                                                                    |
| `parser/Declaration.silk`                      | Nominal declarations, functions, constants, parameters, services/interfaces, implementations, native headers, and static declaration groups    |
| `parser/Type.silk`                             | Type paths, generics, lifetimes, references, arrays, pointers, callable types, effect rows, and constraints                                    |
| `parser/Expression.silk`                       | Literals, constructors, calls, projections, prefix/infix precedence, pipelines, effects, anonymous callables, and matches                      |
| `parser/Pattern.silk`                          | Nominal/applied patterns, whole-value bindings, field shorthand/rest, enum/integer cases, and wildcards                                        |
| `parser/Statement.silk`                        | Bindings, assignments, control flow, transfers, static loops, unsafe blocks, and block recovery                                                |
| `parser/Property.silk`                         | Sealed function/module property syntax                                                                                                         |
| `parser/Grammar.silk`, `parser/Lookahead.silk` | Shared boundaries, precedence, and non-consuming ambiguity checks                                                                              |
| `parser/SyntaxTree.silk`                       | Tree ownership and flat AST printing                                                                                                           |
| `hir/Intern.silk`                              | Deduplicated byte-string storage: `Symbol` identities and the `StringTable` that produces them                                                 |
| `hir/Hir.silk`                                 | The flat HIR vocabulary, the `Module` arena, its debug dump writer, and its arena verifier                                                     |
| `hir/Draft.silk`                               | The in-progress module a lowering builds: arena appends, interning, binder frames, syntax accessors, and the name, path, and literal lowerings |
| `hir/LowerType.silk`                           | Types, generic parameters, rows, `where` constraints, and callable contracts                                                                   |
| `hir/LowerExpression.silk`                     | Expressions, match arms, anonymous callables, field initializers, and written property clauses                                                 |
| `hir/LowerPattern.silk`                        | Patterns, pattern fields and shorthand bindings, and member selectors                                                                          |
| `hir/LowerStatement.silk`                      | Statements, conditional chains, and the blocks that scope their bindings                                                                       |
| `hir/LowerDeclaration.silk`                    | Declaration headers and bodies, owner keys and occurrence counting, and attached documentation                                                 |
| `hir/Lower.silk`                               | The module entry point: documentation, top-level declarations, and copied frontend diagnostics                                                 |
| `hir/Fingerprint.silk`                         | The canonical content encoding of one declaration, its SHA-256 digests, and the module digest                                                  |

Grammar rules are ordinary Silk functions. They consume `State` and return it with either an
unfinished element list or a completed node ID. Replacement values are evaluated before assigning
them back to a local owner, as required by Silk's ownership rules.

## Verification

Build this checkout's bootstrap CLI, then run the M1 source-written cases. The M1 discovery root
imports the existing query, source-index, and semantic cases. The focused HIR run checks exact
integer magnitudes and fingerprints without pulling the full HIR suite into the semantic binary.
`--no-cache` executes assertions even if a previous run stored passing results. The focused Linux
workflow runs these commands for pull requests targeting `selfhost` and pushes to `selfhost`.
Other pull-request targets and main pushes keep their existing broad CI. Native work branches are
named `selfhost-*`; pushing one does not start a second CI run before its pull request.

```sh
CI=true node scripts/turbo.mjs run build --filter=@silklang/cli...
NODE_OPTIONS=--max-old-space-size=6144 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/M1Cases.silk --no-cache
node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/hir/LoweringCases.silk --filter integer --no-cache
```

The cases inspect query and source events, retained request evidence, and rejection codes and byte
spans. They cover an unused missing import and invalid declaration, demanded import and written
signature, memoized reuse, relevant and unrelated revisions, negative observations, exact integer
HIR, typed-failure retry, nested query cancellation with same-store retry, and source-publication
rollback. The cancellation proof combines the executed nested query case with reviewed semantic
publication boundaries; it does not claim an executed full-semantic cancellation fixture.

Keep this loop lean: each new case needs behavioral evidence that its neighbors cannot provide.
Use the existing source-written roots, shared runners and fixtures, and the cheapest assertions
that can falsify the claim. Cover representative integration and failure boundaries rather than
adding per-feature native recompilations or exhaustive matrices. Run broader parser, HIR, corpus,
fuzz, stress, and benchmark work when a milestone or a specific regression calls for it. The
focused CI records separate step durations for dependency/toolchain setup, bootstrap compilation,
and each source-written compile-and-run command. Those last commands include native compilation and
test execution; their combined duration is not a runtime-only measurement. Compare actual cold and
warm CI runs before setting a time target; five minutes is an aspiration, not a correctness bound.

Check the self-hosted program with the bootstrap compiler when changing source outside that
focused entry:

```sh
pnpm exec silk check --manifest-path compiler/silk.toml
```

Run the source-written parser tests with the default project root:

```sh
pnpm exec silk test --manifest-path compiler/silk.toml
```

These tests parse source strings, including malformed syntax, and assert self-hosted parser
behavior. `src/main.silk` imports them for test discovery; normal builds do not execute tests.
The JavaScript harness below remains the TypeScript-versus-self-hosted comparison.

After building the executable, run the parser corpus with its path:

```sh
node compiler/scripts/test-parser.mjs compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler
```

The harness reuses one built executable. It compares significant AST structure with the bootstrap
parser across grammar fixtures, the self-hosted sources, and the standard library. It also checks
postorder IDs, source spans, reachability, unique token ownership, and preservation of following
declarations after malformed syntax. Extra file paths after the executable select a smaller corpus.
The JavaScript harness imports the bootstrap package's built `dist` modules.

The default run also executes the behavioral cases in `scripts/parser-cases.mjs`, adapted from
the bootstrap parser tests. These compare acceptance and require specific valid constructs to
survive damage in both parsers. They do not compare diagnostic wording, diagnostic counts, error
tree shapes, or the two implementations' numerical resource budgets. Every native tree must
still satisfy the flat-tree invariants, and every diagnostic must address a valid source span.
The existing valid-file corpus retains its significant-tree comparison as a separate regression
check; a representation change can update that check without changing the behavioral cases.

Run only the behavioral cases, or select individual cases by name:

```sh
node compiler/scripts/test-parser.mjs compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler --cases
node compiler/scripts/test-parser.mjs compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler --cases missing-parameter-comma overdeep-call
```

Each case uses a temporary source file beneath `compiler/fixtures/`, which the harness removes
after success or failure. The native executable is built once, not once per test. The nesting
cases exercise both accepted inputs and diagnostic recovery, including depth-budget reuse by
sibling expressions and a following declaration after unclosed delimiters.

Lower the same corpus and check the arena the lowering produces:

```sh
node compiler/scripts/lower-corpus.mjs compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler
```

This harness reuses one built executable too, and imports nothing from the bootstrap package: every
assertion is a property of the self-hosted dump alone, never a comparison against
`AuthoredLowering`. It runs `hir` mode over the grammar fixtures, the self-hosted sources, and the
standard library, and asserts that the process exits cleanly, that the dump reads back with each
section holding the number of entries it announces, that `violations` is empty, that every child
identity precedes its parent, that one traversal from the declaration range reaches every node
exactly once, that a child's span lies inside its parent's, that every identifier resolves to a
binder, and that a file the parser accepts lowers without a recovery cause. Extra file paths after
the executable select a smaller corpus.

`fixtures/parser/` contains syntax-only programs: names need not resolve and operations need not
typecheck. `recovery.silk` deliberately contains syntax errors. The other files directly under
`fixtures/` exercise lexical categories and are not necessarily complete Silk programs.

Bootstrap issues encountered while developing this frontend are recorded in [BUGS.md](BUGS.md).
