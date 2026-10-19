// Syntax only: version ordering and bumping belong to Silk's Version module.
const numeric = '(?:0|[1-9][0-9]*)'
const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const build = '[0-9A-Za-z-]+'
// Unlike $, this end assertion also rejects a trailing newline.
const syntax = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+${build}(?:\\.${build})*)?(?![\\s\\S])`,
)

/** Checks an unprefixed SemVer version, including prerelease and build identifiers. */
export const isVersion = (/** @type {string} */ version) => syntax.test(version)
