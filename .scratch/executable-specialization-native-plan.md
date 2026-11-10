# Executable Count prototype native gates (pending candidate bootstrap)

Source: `.scratch/executable-specialization-fixtures/count.silk`. User-authored
`measure_slots<T>` directly uses the sealed intrinsic and carries `@inlineNever`.
It reads actual nonzero header counts for u8 and a differently laid-out array;
result must be 42. This tests a structural certificate without stdlib spelling.

1. Same binary feature off/on, O0 full debug and O2: outputs 42; opted-in
   trace must show certified Count and text reuse. Inspect LLVM definition counts
   and mapped caller names, not only runtime output. Own-body/callee fingerprints
   must select one canonical user definition, with no duplicate-symbol conflict.
2. Reverse call order and repeat a fresh opted-in build. Canonical user function
   bytes, symbols, and opaque debug parameter must be identical. Full artifact
   engagement later exercises separate retained workers and duplicate checking.
3. One cache, separate processes: off -> on -> off. Feature mode is a target
   stamp input, so no incompatible emitted or caller answer can be adopted.
4. One opted-in cache: direct Count -> Count + 1 -> direct Count. Result must
   change 42 -> 44 -> 42. Repeat fresh feature-off compilation for each stage;
   caller references must track both certificate loss and gain. No manual priming.
5. Change header to a noncandidate signature and adjust calls, then restore;
   compare native output and ordered diagnostics with fresh feature-off compiler.
6. Named parameter's exact authored line/scope and machine stack location must be
   present and DWARF verify must pass. Its type is explicitly RawBuffer<opaque>,
   with no first-specialization T claimed. Implementation can expose fixed header
   fields, not per-element contents. Until this debug patch is validated, the initial artificial Count checkpoint had NO source stepping. The current source
   restores it, but native verification must pass before calling it usable debug.
7. Existing structural fixture refuses unchecked body, extra cleanup/unreachable
   work, wrong storage, own-pointer rebinding, wrong parameter ordinal/result, and
   changed computation. Ordinary native startup always observes. The current Count source retains its
   Observer/Cause/Site ABI and actual report-root frame while emitting no events.
   Add native observer/export/provider controls; authored effect/export/provider
   bodies are still rejected, while the globally observing ABI is supported.

No timing claim from these correctness gates. Count-only infrastructure is not
sufficient for promotion or the 3x task: measure actual logical MIR work bypassed,
canonical LLVM bodies, native input volume, and first/subsequent edits before
extending Resize/acyclic forwarding.

Failed preliminary evidence remains intact: `6iortbkj` (nonzero allocated buffers)
and `s6jqlwzc` (pure empty buffers) both compiled and ran42, but had5 checking-MIR
certifications and0 canonical text emissions/reuses. Their final artifacts were
globally observing, so the original ABI exclusion correctly prevented sharing.
These are NOT successful specialization gates. First prototype binary SHA
83e15c2e01f9648ee6c2d90afb7cf67542da42ae31478005033c14b6edc14837 remains archived.
