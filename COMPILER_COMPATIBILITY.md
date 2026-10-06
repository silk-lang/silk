# Compiler compatibility

## Nominal qualification requires an inherent member

CALL-003 and STYLE-002 require a nominal-qualified function to be published in that type's
inherent `impl`. A top-level function whose first parameter is that type is not an inherent
member. Operator mappings follow the same ordinary lookup rule (OP-009).

The TypeScript bootstrap currently accepts the old `operator-interface-contract` fixture's
`Vector.scale` and `Vector.dot` mappings even though those functions were top-level declarations.
The native acceptance job in [run 36627847695](https://github.com/julia-script/silk/actions/runs/36627847695)
confirmed that acceptance. The self-hosted frontend correctly rejects those unpublished members.
The fixture now declares both functions in `impl Vector`, retaining its expected result of 42.
The bootstrap is frozen during backend development; retire this entry when it enforces the
same owner lookup rule.

## Explicit synchronous source startup

The bootstrap can select `silk/native_start_sync` through ordinary runtime composition for an i32
Effect requiring shared or mutable `HostInput`. It captures an owned argument/environment snapshot, lends a
lexical provider, returns successful status unchanged, and drops typed initialization or application
failures before returning one. It installs no Execution or diagnostic observer. The default
`silk/native_start` and its broader application signatures retain their existing behavior.

This source addition does not remove the self-hosted compiler's generated plain-i32 entry or claim
native source-runtime support. Ordinary plain-i32 adaptation belongs to
[#931](https://github.com/julia-script/silk/issues/931); native routing and adapter removal follow
main-first integration of both contracts. See
[the source startup contract](compiler/docs/source-synchronous-startup.md) for selection, ownership,
and validation details. Fatal traps retain their existing behavior and do not promise cleanup.
