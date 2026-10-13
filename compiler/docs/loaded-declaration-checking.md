# Loaded declaration checking (MODULE-004)

`main.silk` preloads the program through `ModuleSources.preloadProgram` before it
creates the semantic store. Both build and test compile through
`Semantic.buildRuntime`, whose `buildFrom` walk currently demands only executable
instances reached from active runtime and application exports. Syntax and selected
import diagnostics already have separate sweeps.

The declaration sweep enumerates authored declarations from each loaded
`ModuleIndex`, follow active imports until no new source module is reached, and
use the existing query families for headers, aggregate members, implementation
contracts, constant initializers, and function bodies. Availability queries keep
inactive static arms out of checking. Anonymous bodies belong to their enclosing
body demand; declarations without bodies have only header demands. Generic bodies
are checked symbolically through the ordinary Body query, including its borrow
verdict and retained obligations.

The sweep collects authentic rejections with their original modules and spans.
It will share the current profile and semantic cache with the executable walk, but
will not add LLVM emission roots. Unreferenced well-typed functions must remain
absent from emitted IR. Independent rejections should be reported once.

OWN0016 uses `localSharedEscapes` over concrete MIR `SuspensionSummary`
values. An analysis-only MIR closure can include otherwise unreferenced concrete
functions and their callback/call dependencies without requesting LLVM text. Open
templates and provider-dependent bodies have no complete named MIR instance. The
coordinator approved retaining those obligations in this change and splitting
universal abstract OWN0016 summaries into a follow-up (Spike question #4). No concrete
providers or specializations will be fabricated to make an abstract body appear
checked.

Validation will compare base and changed self-build wall time and peak RSS using
at least three ABBA rounds, and do the same for the native corpus. A self-build
regression above about 5% requires a coordinator decision before optimization.
New compiler-source and standard-library diagnostics will be inventoried; source
fixes stay in this selfhost change, while library fixes go through main. Focused
Cases will cover unreachable invalid and valid declarations, imported modules,
conditional availability, unchanged emission reachability, and relevant safety
analysis. Final evidence includes the pinned seed chain, identical N1/N2 IR,
entry builds, touched Cases timing checks, formatting, corpus, and gap guard.

The coordinator additionally approved structural static-template deferral (question
8). Static function inputs, explicitly static parameters, and expansions dependent
on reflected generic parameters cannot be assigned invented values. The header is
checked first, and the body is classified before any Body refusal is available.
Every deferred declaration is retained as coverage evidence and listed by
`--stats`; selected applications still check their exact bodies. Ticket 18 covers
checking the non-static parts of those unspecialized templates.

Bootstrap parity was probed from main commit `d87bafb85`, using the exact selfhost
standard-library bytes: all 114 format bodies and seven reflect bodies were
checked with no diagnostics. An intentionally invalid non-static return in
`hasPositionalField` and in `borrowField` each produced SEM0129. Thus the bootstrap
checks non-static structure even in templates whose expansions await input; the
whole-body deferral in this native slice is an explicit temporary coverage gap.
