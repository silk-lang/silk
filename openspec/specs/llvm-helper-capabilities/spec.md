# llvm-helper-capabilities Specification

## Purpose

Make compiler-introduced support dependencies explicit, auditable and closed under the selected target's helper capabilities before final artifact linking.

## Requirements

### Requirement: Post-legalization requirements explain actual object references

The compiler MUST reconcile emitted native object external references with declared foreign imports, explicit language runtime contracts and selected compiler helper requirements. Reports MUST identify object origin/content, symbol and ABI, family, provider identity, target availability, linkage, visibility and retention. Unknown references MUST fail before final linking with their origin.

#### Scenario: Ordinary foreign import remains ordinary

- **WHEN** a program object references an explicitly declared foreign symbol
- **THEN** the report accounts for that foreign declaration without inferring an OS policy or automatically selecting a compiler helper by spelling

#### Scenario: Legalization adds a helper

- **WHEN** object generation introduces a verified memory or arithmetic helper reference
- **THEN** the report records its target-specific contract and provider before constructing the final link plan

#### Scenario: Unexplained reference

- **WHEN** an emitted external reference has no admitted declaration, runtime contract or helper provider
- **THEN** compilation rejects the reference with its object and symbol origin before final linking

### Requirement: Capability families select only necessary providers

Memory, arithmetic, atomics, stack probes, stack protection, sanitizers and unwind MUST be independent families. Only verified initial memory and hosted remainder helpers SHALL be admitted. Unsupported or incompatible requests MUST diagnose. A family MUST NOT implicitly enable another family, libc or libm.

#### Scenario: Helper-free object

- **WHEN** an object has no compiler helper references
- **THEN** it acquires no memory provider or libm requirement

#### Scenario: Hosted arithmetic

- **WHEN** an admitted GNU hosted object requires fmod or fmodf
- **THEN** its plan includes the selected libc-compatible math provider and only its justified physical inputs

#### Scenario: Hosted memory

- **WHEN** an admitted hosted native object requires a memory helper
- **THEN** the platform C library already selected for the link supplies it, and no source helper object is realized or linked

#### Scenario: Unavailable family

- **WHEN** an object or request needs an unimplemented family or a native libc provider under a no-libc/Wasm profile
- **THEN** selection fails explicitly without host discovery or a fallback provider

### Requirement: Source support closures cannot recursively depend on themselves

Source memory providers MUST serve only native profiles without libc. They MUST compile through a restricted no-entry, no-runtime, no-libc object profile that is optimized whatever the program's optimization mode. Their selected exports MUST be retained explicitly. Their emitted dependencies MUST conform to their declared provider graph, and direct, transitive and legalization-induced cycles MUST fail with deterministic origin paths. Optimization restrictions MUST be specific to bootstrap recursion and MUST NOT replace post-object verification.

#### Scenario: Freestanding source memory helper

- **WHEN** a debug or optimized program without libc selects a source memory routine
- **THEN** the routine is compiled optimized, and its actual object closes without unexplained libc/runtime references and retains the required C export

#### Scenario: Recursive provider graph

- **WHEN** provider dependencies form a direct or transitive cycle
- **THEN** selection rejects the complete cycle path before final linking

#### Scenario: Reintroduced self-call

- **WHEN** legalization of a provider introduces a reference to its own support contract or an undeclared provider
- **THEN** object verification rejects it even if the source dependency graph was acyclic

### Requirement: Physical plans and identities contain helper closure

The final artifact plan MUST expose the selected support roots, contracts and physical objects/libraries. Its identity MUST account for provider contracts and concrete content. Intermediate objects and archives MUST expose unresolved helper needs honestly. Unverified LTO MUST be rejected before linking.

#### Scenario: Provider changes

- **WHEN** the selected provider contract or emitted provider object changes
- **THEN** the final artifact identity changes and cached artifacts from the earlier closure are not admitted

#### Scenario: LTO request

- **WHEN** a caller requests an LTO mode without post-LTO helper verification
- **THEN** the request is rejected rather than treating pre-LTO inspection as sufficient

### Requirement: Conformance proves selected helper ABIs and preserves Wasm

Required Darwin ARM64 and GNU x86-64/ARM64 lanes MUST produce actual target objects and independent C ABI fixtures, account hosted helper requests to the platform C library, inspect the optimized no-libc helper inventories for debug and optimized programs, and execute the distinguishing cases on available runners. Missing supplies and skipped required cases MUST fail. The admitted LLVM-to-Wasm helper set MUST remain usable through an explicit target-compatible provider without native OS dependencies.

#### Scenario: Required target lane

- **WHEN** a designated helper conformance lane runs
- **THEN** it verifies selected tool/supply pins, actual helper objects, C semantics and closed provider dependencies without replacing them with simulated target facts

#### Scenario: Portable Wasm consumer

- **WHEN** an existing portable Wasm consumer requires its admitted memory helper
- **THEN** the target-compatible provider satisfies that helper without selecting native libc or OS services

### Requirement: Raw address observation

The compiler SHALL expose target-neutral `Intrinsic.pointerAddress<P>(pointer: P) -> usize` for data pointers only. The result SHALL be the unsigned address in the selected target's pointer width. Observation SHALL NOT read the pointee, create a loan, or permit integer-to-pointer reconstruction. Runtime address observation SHALL NOT be admitted as a static value.

#### Scenario: Select an overlap-safe direction

- **WHEN** an ordinary source memory provider compares two raw addresses
- **THEN** it can select forward or backward copying without a compiler-known memory-provider declaration.

#### Scenario: Reject non-pointer observation

- **WHEN** a caller instantiates address observation with an integer or function value
- **THEN** semantic analysis rejects the call before lowering.

### Requirement: Target-specific memory idioms

LLVM-generated `bcmp` on GNU and `bzero` on Darwin SHALL select the platform C library on hosted profiles and source providers with their exact C ABI without libc. They SHALL remain unavailable on the Wasm bootstrap.

#### Scenario: Optimized comparison and zero fill

- **WHEN** optimized GNU equality introduces `bcmp`, or optimized Darwin zero fill introduces `bzero`
- **THEN** the emitted dependency is resolved by the platform C library on a hosted profile, or by the corresponding audited source provider without libc.
