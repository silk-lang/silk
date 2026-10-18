# Selected source and platform catalogs

## SOURCE-TOOLING-001 — Availability belongs to source

Module static selection determines the declarations, imports and public surface available for a
compilation profile. Standard-library files follow the same rules as application files. A façade
can import its selected implementation. The bundled manifest records canonical source identities,
bytes, digests and descriptive inventory; it has no portable/provider category or provider target
list. Integrity validates those facts and actual compiler intrinsic implementations, without
selecting platform APIs.

The existing native OS provider declarations are selected only for their supported native
architecture/OS/ABI combinations. Their LLVM-to-Wasm surface is empty. Importing an empty module is
harmless; selecting a missing member receives ordinary structured resolution diagnostics. An
inactive import contributes neither a declaration nor runtime inventory.

## SOURCE-TOOLING-002 — Platform source has distinct responsibilities

Libc and SDK catalogs describe their external authorities. Kernel UAPI catalogs describe the kernel
boundary separately. Raw operations invoke those declarations or admitted machine primitives.
Shared POSIX policy adds useful common error/resource behavior. Service façades define reusable
contracts and source selection. Runtime-root modules compose artifact startup and providers.
These responsibilities do not confer compiler privilege and do not require empty placeholder APIs.
The existing OS modules retain their current operations until their individual service migrations.

## SOURCE-TOOLING-003 — Tooling results identify one profile

Compiler surfaces, source catalogs, auto-import candidates and generated documentation use the
same canonical profile normalization and source selection. A catalog identifies its completed
profile and selected content. Different package configuration values remain distinct even on the
same target. Equivalent inputs may reuse compatible results. Tooling discovery does not add all
discovered modules to an application's runtime closure.

Editor initialization and explicit configuration accept named profiles, full logical overrides or
target-triple shorthand, using the project default and then host selection only at the host edge.
A profile change supersedes old analysis and queries, refreshes diagnostics and semantic queries,
and replaces catalog candidates. Delayed old-profile results cannot publish in the new session.
Inactive presentation uses compiler-provided ranges. Generated documentation identifies the
profile availability of each declaration; incompatible surfaces are never presented as one API.

## SOURCE-TOOLING-004 — Provenance records describe evidence

A platform catalog record identifies hand-authored, generated or mixed production; exact authority
and header versions; logical target/deployment scope; admitted declarations and their applicable
constant, layout, signature and symbol evidence; fixture and tool versions; and update/drift-review
provenance. Missing or contradictory required provenance is invalid. Verified claims identify
their executed result; planned fixtures do not imply successful conformance.

These records neither choose provider availability nor replace Silk library ABI import/export
manifests. Each consuming catalog subset chooses its production method, physical supplies and
conformance fixtures. Validating the shared record shape alone does not verify any platform ABI.

Live `<silk-snippet>` examples select their target through the `target` attribute, defaulting to `wasm32-unknown-unknown`. Native examples state their native target explicitly. Changing the attribute discards the prior session and reanalyzes the same source under the new target.
