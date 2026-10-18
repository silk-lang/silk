# Foreign-call contracts

Define immediate native call behavior, unsafe optimization assertions, complete-call pointer loans and deterministic termination when a foreign exception crosses the Silk boundary.

### Requirement: Foreign calls carry an explicit conservative behavioral contract

Every foreign declaration SHALL carry normalized memory, locality, capture, borrow, returned-alias, return and forbidden-unwind facts. An omitted property clause SHALL mean external read/write memory, possible pointer capture, no borrowed parameters, no returned-alias assertion and normal return. Source MAY narrow those facts only through `with Intrinsic.foreign(...)` on an unsafe foreign declaration or export. Native function-pointer types carry the same normalized behavior. The admitted literal fields SHALL be memory (`none`, `read`, `write`, `readwrite`), locality (`external`, `arguments`), noCapture, borrow and callbacks (tuples of parameter names), returned (one parameter name) and noReturn (Boolean). Unknown or duplicate properties, wrong literal kinds, nonexistent parameters and invalid type/contract combinations SHALL diagnose at their source spans. Parameter sets SHALL normalize by ordinal; property order and renamed local parameters SHALL NOT alter behavioral identity. Each callbacks ordinal SHALL promise synchronous, same-thread invocation within the complete call without retention. Every function-pointer parameter SHALL be listed. Explicit permitted unwind, retention and thread migration SHALL be rejected. See [synchronous native callbacks](./synchronous-native-callbacks.md) for address conversion, reference loans and indirect invocation.

#### Scenario: Preserve an unannotated declaration

- **WHEN** a source declaration provides no behavior clause
- **THEN** semantic, executable and emitted contracts remain conservative and contain no optimistic memory, capture, returned-alias or no-return assertions

#### Scenario: Validate unsafe assertions

- **WHEN** source names a non-pointer parameter in noCapture, a raw pointer in borrow, a duplicate field, a nonexistent parameter or returned together with noCapture on that parameter
- **THEN** analysis rejects the declaration with the offending code/span and preserves declaration origins

### Requirement: Immediate borrowed C parameters retain ordinary complete-call obligations

A single-value `&T` or `&mut T` parameter SHALL be admitted as a C pointer only when named by borrow. This unsafe assertion SHALL promise no capture and no freeing for the complete call. The caller SHALL retain ordinary initialized-state, shared/exclusive access, aliasing, liveness and cleanup obligations through the entire call. Slices and reference results SHALL remain unadmitted. Raw pointers SHALL remain non-owning; noCapture SHALL NOT create a loan, preserve an owner, imply nofree or initialize output storage. Returned aliases SHALL require an identical raw-pointer result type and SHALL NOT confer ownership.

#### Scenario: Borrow for one call

- **WHEN** a checked initialized local is passed by an admitted reference parameter
- **THEN** its loan covers all argument evaluation and the call, conflicts with overlapping incompatible arguments, and ends after the call

#### Scenario: Reject capture-capable reference parameters

- **WHEN** a foreign declaration accepts a reference without the borrow promise or a caller borrows uninitialized or incompatibly loaned storage
- **THEN** analysis rejects the declaration or call without manufacturing raw-pointer lifetime guarantees

### Requirement: Native optimization preserves declared memory behavior and error reads

Only explicit admitted assertions SHALL justify narrowed memory/locality, capture, returned or no-return attributes. Default calls SHALL preserve externally observable operation/accessor/read ordering and visibility of foreign writes. Error-accessor spelling SHALL have no compiler significance. An explicit noReturn declaration SHALL have a unit result and no successful continuation. Ordinary loads SHALL NOT become globally volatile and ordering SHALL NOT require a hardware fence.

#### Scenario: Read renamed native error state

- **WHEN** an ordinary fixture operation changes native state and an immediately following renamed accessor exposes it for a read
- **THEN** debug and optimized native executions observe the operation's state, and an intervening deliberate state change produces the correspondingly different result

#### Scenario: Emit only asserted properties

- **WHEN** separately declared functions assert read-only, argument-local, no-capture, returned-alias or no-return behavior
- **THEN** structural native output reflects precisely those admitted facts and conservative neighbors keep their required memory effects

### Requirement: Visible behavioral contracts participate in native identity

Normalized behavioral contracts SHALL enter semantic surfaces, executable/MIR inventories, native interfaces and affected cache identities. Visible declarations with the same native symbol and machine signature but different behavioral contracts SHALL diagnose a mismatch relating both origins. Equivalent contracts SHALL agree. Cross-unit validation SHALL compare supplied interface records without claiming to infer unavailable behavior from arbitrary object code. Unsupported LTO requests SHALL reject explicitly.

#### Scenario: Detect equal machine types with different promises

- **WHEN** two visible declarations or supplied native interfaces assign incompatible behavior to one symbol
- **THEN** the compiler rejects the mismatch even though their C parameter/result classes agree

#### Scenario: Invalidate behavior changes

- **WHEN** a selected declaration changes only its admitted behavior clause
- **THEN** its semantic/native interface identity changes and incompatible cached results are not reused

### Requirement: A foreign unwind terminates at the Silk boundary

Foreign exception propagation SHALL be forbidden. When an admitted native platform unwinder reaches a Silk foreign-call boundary, execution SHALL take the compiler fatal-trap outcome before any enclosing foreign caller can catch the exception across Silk. A bare no-unwind optimizer promise SHALL NOT substitute for this behavior. Normal calls SHALL preserve their C results and memory effects. This contract SHALL NOT promise support for nonlocal jumps that bypass the platform exception unwinder.

#### Scenario: Throw toward a foreign catch above Silk

- **WHEN** a separately compiled C++ fixture calls an exported Silk function inside a catch and a foreign function invoked by Silk throws
- **THEN** Darwin ARM64 and GNU/Linux x86-64 and ARM64 debug/optimized executions terminate at the Silk boundary and do not reach the enclosing catch

#### Scenario: Require concrete native evidence

- **WHEN** the designated boundary verification lanes run
- **THEN** they compile, link, inspect and execute the admitted fixtures with pinned supplies and fail when required supplies or fixtures are missing

## Source properties

Use an optional contextual `with Intrinsic.foreign(...)` tail after the optional symbol rename. This is a compiler-owned declaration property, not a source function execution or a library actor recognized by name. Ordinary unsafe acknowledgement remains mandatory. Arguments are literal named properties, with exact field/type validation and source spans:

- `memory`: `"none" | "read" | "write" | "readwrite"`, default `"readwrite"`.
- `locality`: `"external" | "arguments"`, default `"external"`. `memory: "none"` canonicalizes locality to external because there are no accesses. Arguments means only memory reachable through pointer parameters; it does not permit hidden globals or inaccessible allocator state.
- `noCapture`: tuple of raw-pointer parameter names, default empty. The assertion forbids all pointer capture, including return capture; it does not promise non-freeing or make the pointer owning.
- `borrow`: tuple of single-value reference parameter names, default empty. Each named parameter asserts noncapture and non-freeing for the complete call. Every reference parameter requires this assertion. Slices and borrowed results remain unadmitted. This gives immediate native code one C pointer while keeping the existing reference loan checker and initialization rules authoritative.
- `returned`: one raw-pointer parameter name, absent by default. Result must have the identical pointer type. It asserts exact pointer equality, not fresh allocation or ownership. It conflicts with noCapture on the same parameter and with noReturn.
- `noReturn`: Boolean, default false; true requires a unit result. It permits no successful continuation. A foreign implementation that returns despite this unsafe assertion violates its declaration contract.

Unknown, duplicate, wrong-kind, unknown-parameter and conflicting properties diagnose at the property/parameter origin. Assertions on exported source functions and function-pointer types are not admitted by this clause; their delivered contracts remain conservative. No generalized attribute strings or arbitrary LLVM properties enter source. Named sets normalize to parameter ordinals, not source aliases or property order.

The alternative of treating raw pointer formation as a borrow is rejected: JUL-123 deliberately made raw pointers non-owning and loanless. Explicit reference parameters make the loan lifetime visible to existing checking without manufacturing provenance for arbitrary native pointers. Existing output storage still uses raw write-only pointers and explicit unsafe initialization acknowledgement; a memory assertion never initializes an owner.

## Supplied interfaces

Embedders pass ABI JSON snapshots in `Driver.CompileRequest.foreignInterfaces`, with a `SourceFile` identity for each supplied file. Schema 2 is strict and includes normalized contracts. The driver compares all supplied records with one another and with the reachable C inventory before invoking tools or reusing cached emission. A mismatch uses SEM0192 and relates the source declaration and supplied file; malformed/obsolete records use SEM0188. Missing interfaces do not authorize guesses about object-code behavior. Supplied interface bytes participate in the backend cache key. This API does not discover platform supplies or infer interfaces from linker inputs.
