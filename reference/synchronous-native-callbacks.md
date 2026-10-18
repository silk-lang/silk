---
title: Synchronous native callbacks
description: Native code addresses, complete-call callback promises, reentrancy, and indirect invocation.
---

# Synchronous native callbacks

This contract completes the existing exported C-address boundary. A native function pointer is a
nonnull Copy address, with an exact C signature and behavioral contract. It has no captured Silk
environment. Borrowed data passed during invocation has a separate lifetime from the code address.

## Declaring callback invocation

The sealed `Intrinsic.foreign` declaration clause accepts `callbacks`, a tuple naming every native
function-pointer parameter. Each listed parameter promises synchronous invocation on the calling
thread, entirely within the enclosing call, without retention for later invocation. Omitting a
callback parameter does not imply that promise: unrestricted invocation is unadmitted and diagnoses.
Requests for escaping callbacks, another thread or permitted unwind also diagnose.

The function-pointer type itself accepts the same clause for its access behavior. In type clauses,
unnamed parameters are identified by decimal ordinal strings, starting at `"0"`. Declaration clauses
use the written parameter names. Property order and parameter names do not change normalized identity.

```silk,ignore
unsafe extern "C" fn qsort(
  base: ?[*]mut i32,
  count: usize,
  size: usize,
  compare: extern "C" fn(*const i32, *const i32) -> i32
    with Intrinsic.foreign(memory: "read", locality: "arguments"),
) -> () with Intrinsic.foreign(callbacks: ("compare",))
```

The selected platform's actual declaration and implementation justify the unsafe qsort assertion;
the compiler never recognizes its name. The comparator must not modify the array. The wrapper keeps
the array alive until qsort returns and prevents competing access. Forming a raw pointer does not
create a loan or prove that arbitrary native code obeys these obligations.

## Exported addresses and exact behavior

A named synchronous export without type or value generics supplies its real C thunk address.
Per-call lifetime binders are permitted. An ordinary, capturing, type-generic, effect, suspending
or naked machine callable cannot supply a native callback address. Imported foreign functions
remain callable by symbol; this contract does not add imported-symbol address conversion.

An export declaring stronger foreign promises requires `unsafe export "C" fn` and a sealed foreign
clause. Its author owns the truth of those promises. Address conversion compares that declared
contract with the expected pointer type; the expected type cannot silently grant narrower access.
Unannotated exports have conservative behavior and match conservative native pointer types.

## Indirect invocation and loans

Calling a native pointer value requires `unsafe`, exact arguments and a supported native target.
The address is called at runtime under the target C ABI. It does not become an ordinary specialized
Silk callable. Nullable native invocation is unadmitted; a native address must be nonnull and valid.

Single-value reference parameters require the `borrow` promise, just as direct foreign calls do.
Their loans last through the complete indirect invocation. Nested invocations may use independent
storage or ordinary valid reborrows; conflicting access to an active exclusive loan diagnoses.
Borrowed reference results remain unadmitted. Reference lifetimes bind separately for each call;
explicit `for<'a> extern "C" fn(&'a i32) -> i32` syntax names that binder. These proof-only binders
do not become runtime generic arguments.

An enclosing foreign contract that combines reference loans with callbacks must restrict callback
access to its arguments or to no memory. An externally accessing callback cannot establish that it
avoids the enclosing loan. The unsafe foreign implementation must pass valid callback arguments and
respect the borrowing contract. Raw pointers carry no inferred context mapping, pinning or ownership.

## Unwind and cleanup

Native indirect calls and exported callback entry enforce the existing forbidden-unwind outcome:
the supported native exception unwinder triggers fatal termination at the boundary, before an outer
foreign catch can receive the exception. This is enforced by a retained guard frame and fatal
personality, not merely a `nounwind` assumption.

C callback signatures have no Effect failure channel. A source wrapper may interpret ordinary C
results and return a typed source failure, with ordinary scoped cleanup on its normal or typed
failure exits. Fatal traps and forbidden unwind do not promise cleanup or become typed failures.

The complete contract participates in source/interface identity, caches and mismatch diagnostics.
C headers retain valid C syntax; the companion manifest retains the additional behavioral facts.
LTO remains explicitly unsupported. Retained registration, cross-thread invocation, permitted
unwind, captured callbacks and broader ABI forms require a separately admitted consumer.
