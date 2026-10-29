---
title: Native callbacks
description: Native code addresses, immediate and deferred callback promises, reentrancy, and indirect invocation.
---

# Native callbacks

This contract completes the existing exported C-address boundary. A native function pointer is a
nonnull Copy address, with an exact C signature and behavioral contract. Its nullable form,
`?extern "C" fn(...) -> R`, may hold NULL and cannot be called until it is refined. It has no captured Silk
environment. Borrowed data passed during invocation has a separate lifetime from the code address.

## Declaring callback invocation

The sealed `Intrinsic.foreign` declaration clause accepts `callbacks`, a tuple naming every native
function-pointer parameter or callback field in a by-value C aggregate. Each listed callback promises
synchronous invocation on the calling thread, entirely within the enclosing call, without retention
for later invocation. Omitting a callback does not imply that promise: an incomplete contract
diagnoses even when the declaration is never called.

Use `deferredCallbacks` for retention followed by invocation during later calls on the registering
thread, or `threadCallbacks` for invocation on any thread. A declaration may give each mode one
list, so one registration can take a deferred completion callback and an any-thread error
callback; together the lists must name every callback exactly once, and a callback in two lists
diagnoses. Each callback's mode is part of the declaration's native identity. These invocation
clauses do not narrow memory
access, locality or pointer capture and cannot be combined with those narrowing promises.

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

## Callbacks that run on another thread

`Intrinsic.foreign(threadCallbacks: ("start",))` is the alternative to `callbacks` for a callback
that native code may invoke on any thread, during the call or after it returns, such as the start
routine of `pthread_create`. Its tuple names every native function-pointer parameter or by-value
aggregate callback field exactly once, and the resolved C signature is authenticated again. A
listed callback may take no reference parameter, since no loan of the caller can last until it runs.

```silk,ignore
unsafe extern "C" fn pthread_create(
  thread: *mut usize,
  attributes: ?*const u8,
  start: extern "C" fn(?*mut u8) -> ?*mut u8,
  argument: ?*mut u8,
) -> i32 with Intrinsic.foreign(threadCallbacks: ("start",))
```

The export itself needs nothing more: it has no captured environment, and Silk has no thread-local
or mutable global storage, so its body runs the same on a new thread. Whatever reaches it through
its raw-pointer arguments is the unsafe caller's obligation, typically an owned value moved with
`Pointer.take` (see the native pointer boundary) whose type is `Transferable` (THREAD-001).

## Deferred callbacks on the registering thread

`Intrinsic.foreign(deferredCallbacks: ("info.callback",))` permits native code to retain a callback
after registration returns. Native code may invoke it only during a later call marked
`Intrinsic.foreign(invokesDeferredCallbacks: true)`, on the thread that registered it. Registration
does not itself invoke the deferred callback. Event-pump, wait and cancellation calls that can invoke
retained callbacks must carry the marker. The marker is a literal `true`, not an expression or `false`.

```silk,ignore
extern "C" struct CallbackInfo {
  nextInChain: ?*mut u8,
  mode: u32,
  callback: extern "C" fn(u32, ?*mut u8, ?*mut u8) -> (),
  userdata1: ?*mut u8,
  userdata2: ?*mut u8,
}

unsafe extern "C" fn requestAdapter(instance: ?*mut u8, info: CallbackInfo) -> u64
  with Intrinsic.foreign(deferredCallbacks: ("info.callback",))

unsafe extern "C" fn processEvents(instance: ?*mut u8) -> ()
  with Intrinsic.foreign(invokesDeferredCallbacks: true)
```

The compiler records the invocation mode and the event-pump marker as behavior, but does not match
registrations to a named pump or infer a native library's execution policy. The unsafe binding author
must justify the same-thread and invocation-extent promises from that library's contract. A runtime
callback mode that allows spontaneous or cross-thread invocation requires `threadCallbacks` instead.

Deferred callbacks take no references or slices. Registration and marked invocation calls also take
no references or slices: retained userdata has no compiler-proved relationship to a later call's
loans. The raw-pointer userdata need not be `Transferable` solely because of deferred invocation.
The unsafe owner must keep its storage alive and at a stable address, prevent conflicting access
during reentry, and drain or cancel all pending invocations before freeing it. Same-thread invocation
does not extend a borrow or establish ownership.

## Callbacks in by-value aggregates

A callback path starts with the written parameter name and follows C struct fields separated by
dots, for example `"request.info.callback"`. Type aliases do not hide callbacks. Every callback
leaf in the resolved by-value argument must be listed exactly once; omitted, duplicate, unknown
and non-callback paths diagnose. The rule applies across all of a declaration's callback lists.
A nullable `?extern "C" fn` parameter or field is a callback leaf too, and is listed like any other;
native code must test it before calling it. Fixed-array fields containing callbacks are rejected;
indexed callback paths are not admitted.
Arrays without callback leaves retain their ordinary C ABI rules.

Traversal stops at raw pointers. A path cannot cross `nextInChain`, an opaque handle or a userdata
pointer. Such storage, including any callbacks reachable through it, remains the unsafe binding
author's explicit responsibility; the compiler neither discovers its runtime layout nor proves its
lifetime. A binding should expose a typed by-value registration boundary when it needs checked
callback coverage.

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
Silk callable. A `?extern "C" fn` value is not callable: test it with `Intrinsic.pointerIsNull`, then
refine it with `unsafe Intrinsic.pointerRequalify` to the nonnull type with the same signature and
behavior. A called native address must be nonnull and valid.

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
LTO remains explicitly unsupported. Permitted unwind and captured callbacks require a separately
admitted consumer. Retained callbacks use the deferred same-thread or any-thread contracts above.
