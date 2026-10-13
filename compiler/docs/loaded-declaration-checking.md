# Loaded declaration checking (MODULE-004)

`main.silk` preloads the program through `ModuleSources.preloadProgram` before it
creates the semantic store. Both build and test compile through
`Semantic.buildRuntime`, whose `buildFrom` walk currently demands only executable
instances reached from active runtime and application exports. Syntax and selected
import diagnostics already have separate sweeps.

The declaration sweep will enumerate authored declarations from each loaded
`ModuleIndex`, follow active imports until no new source module is reached, and
use the existing query families for headers, aggregate members, implementation
contracts, constant initializers, and function bodies. Availability queries keep
inactive static arms out of checking. Anonymous bodies belong to their enclosing
body demand; declarations without bodies have only header demands. Generic bodies
are checked symbolically through the ordinary Body query, including its borrow
verdict and retained obligations.

The sweep will collect authentic rejections with their original modules and spans.
It will share the current profile and semantic cache with the executable walk, but
will not add LLVM emission roots. Unreferenced well-typed functions must remain
absent from emitted IR. Independent rejections should be reported once.

OWN0016 currently uses `localSharedEscapes` over concrete MIR `SuspensionSummary`
values. An analysis-only MIR closure can include otherwise unreferenced concrete
functions and their callback/call dependencies without requesting LLVM text. Open
templates and provider-dependent bodies have no complete named MIR instance. The
coordinator has been asked whether their retained safety obligations belong in a
separate abstract-summary task or must be discharged in this change. No concrete
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
