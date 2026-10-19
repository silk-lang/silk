# Changelog

Auto-generated from `.changes/releases/*.toml`. Manual edits are overwritten on the next release; edit the authoritative TOML files instead.

## 0.1.0

### Minor

Prepare and publish compiler releases from the native compiler/changes workspace, with GitHub notes taken from TOML history.

#### Migration

From the virtual workspace root, select the package explicitly with silk changes --dir compiler. Prepare compiler release opens a reviewable version PR; after merging it, run Selfhost Silk on main with publish enabled. Publication refuses pending changes, broken history, a mismatched version or changed release artifacts. Stable releases and explicit beta/rc releases share this flow. The changes library remains a separate workspace member; releases do not yet coordinate multiple packages automatically.

Introduce native changes and migration history for Silk packages and the compiler.

#### Migration

Add one change file per contribution with silk changes add and describe API, behavior and default changes with --migration. Commit authoritative .changes/releases/*.toml records; CHANGELOG.md is generated and manual edits are overwritten. Before upgrading, run silk changes since for the compiler or silk changes since DEPENDENCY for an installed library. Use --to VERSION to select a target and update package.silk-version only after migrating and verifying the project.

Release the self-hosted compiler with one version across its manifest, executable, initialized projects and native archives.

#### Migration

Prepare versions with silk changes --dir compiler version, optionally --tag beta or --tag rc, instead of editing a version literal or using commit-count development tags. The generated ReleaseVersion module is committed with the manifest and TOML history. The installer now selects the latest stable release; set SILK_RELEASE=vVERSION to opt into a published prerelease. This is the first authoritative compiler history: older development binaries reported 0.1.0 without identifying their source revision. Use --from 0.0.0 to review this initial release explicitly rather than treating those old recorded versions as a reliable upgrade baseline.

