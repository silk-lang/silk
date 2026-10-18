# Raw Linux executables

The synchronous raw runtime supports x86-64 and ARM64 Linux with `libc = "none"`,
static linking and static relocation. Select `silk/raw_start` as a named runtime
module and `_start` as the loader entry. The application exports ordinary Silk
`pub fn main(inputs: &ProcessInputs) -> i32`, importing `ProcessInputs` from
`silk.raw_process_inputs`. No C startup object or generated hosted entry supplies
this composition.

The source entry captures the kernel stack before changing it, observes the
platform stack-alignment contract and calls the source initializer. The initializer
checks the argument terminator and auxiliary vector, requires exactly one positive
power-of-two AT_PAGESZ, and invokes the application once. Invalid required startup
facts exit with status 127. Normal application return terminates the process with
the low eight bits of its result through Linux exit_group.

`ProcessInputs` borrows the kernel-provided argument and environment strings for
the process lifetime. Its decoder is unsafe: the caller must supply the complete,
aligned, readable, terminated kernel stack image. Validation of required facts does
not make an arbitrary address safe to inspect. Accessors return nullable pointers
for missing indices and do not allocate or copy strings.

`silk.raw_linux` provides unsafe syscall0 through syscall6 and a non-returning
one-argument syscall operation. These follow Linux register conventions, declare
memory effects, and expose the machine-word result. `error` decodes unsigned -4095
through -1 into positive error numbers. `read` and `write` expose partial transfers,
EOF and errors directly; callers own retry and progress policy. Pointer conversion
uses typed target assembly and grants neither ownership nor memory validity.

`Mapping.allocate` in `silk.raw_mapping` reserves an anonymous private read/write
mapping. The page size must come from validated process inputs. Size must be
positive; alignment and page size must be powers of two. Checked arithmetic rejects
overflow before the syscall. Over-aligned allocations retain one complete mapping
and return an aligned usable range whose initial bytes are zero. An affine owner
releases the complete mapping on structured drop, or explicit `Mapping.release`
consumes it and reports the kernel result. Neither path retries release. Unsafe
pointer access must stay within the usable range and the owner's lifetime.

This composition supplies no execution-storage or terminal-reporting capability.
Artifacts requesting the retained generated language runtime fail before object
emission. The physical link planner provides no libc or CRT, and admitted source
memory helpers remain subject to post-object helper accounting. LTO remains
unsupported. Fatal traps do not promise cleanup or reporting.

The required raw Linux conformance fixture independently compiles pinned Linux
UAPI declarations, executes debug and optimized artifacts on both architectures,
and inspects object disassembly and final ELF closure. The final executable must
be ET_EXEC with no interpreter, dynamic dependency or undefined symbol.
