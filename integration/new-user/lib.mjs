// Shared helpers for the new-user integration tests. Every test works in a throwaway HOME so it
// sees Silk the way a fresh machine does: no ~/.silk, no settings, nothing on PATH but the
// toolchain the test installed.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(here, '../..')

// SILK_NEW_USER_DOCS points at a silk-lang/docs checkout; the docs tests skip without one.
export const docsRoot = process.env.SILK_NEW_USER_DOCS ?? ''

// SILK_NEW_USER_INSTALLER is the install.sh to run: the repository's copy by default, or a URL
// (the published one is https://raw.githubusercontent.com/silk-lang/silk/main/install.sh).
const installer = process.env.SILK_NEW_USER_INSTALLER ?? join(repoRoot, 'install.sh')

// SILK_NEW_USER_COMPILER is a local compiler, for example a build of main, laid out as
// <dir>/bin/silk (or bin/silkc) with its stdlib at <dir>/lib/silk/stdlib. Each home gets a copy as
// the toolchain `0.0.0-local`, and commands select it with SILK_TOOLCHAIN. install.sh still runs,
// so the install and toolchain tests keep testing the release.
export const compiler = process.env.SILK_NEW_USER_COMPILER ?? ''
export const localVersion = '0.0.0-local'

// SILK_NEW_USER_TOOL is a local build of the silk tool (tool/ in the repository), for testing it
// before a release ships it. After install.sh, addLocalTool() puts it at ~/.silk/bin/silk, where
// install.sh puts the tool of a release that has one.
export const toolBinary = process.env.SILK_NEW_USER_TOOL ?? ''

// Release to install, as a tag. Empty means "whatever install.sh picks", like a new user.
export const release = process.env.SILK_RELEASE ?? ''

// A per-run home folder. Tests share one install (installing takes a few seconds and a network
// round trip) unless they ask for their own with freshHome().
let shared
export function sharedHome() {
  if (shared === undefined) {
    shared = freshHome()
    const result = install(shared)
    if (result.status !== 0) throw new Error(`install.sh failed:\n${result.stdout}${result.stderr}`)
  }
  return shared
}

// Each test file's homes are removed when it exits; SILK_NEW_USER_KEEP=1 keeps them to look at.
const roots = []
process.on('exit', () => {
  if (process.env.SILK_NEW_USER_KEEP) return
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

export function freshHome() {
  const root = mkdtempSync(join(process.env.SILK_NEW_USER_TMP ?? tmpdir(), 'silk-new-user-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const work = join(root, 'work')
  mkdirSync(work)
  return { root, home, work, silkHome: join(home, '.silk') }
}

// The environment a new user's shell has after following the Install page: HOME, PATH with
// ~/.silk/bin first, and nothing Silk-specific unless the test adds it.
export function userEnv(h, extra = {}) {
  const env = {
    HOME: h.home,
    PATH: `${join(h.silkHome, 'bin')}:${process.env.PATH}`,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
  }
  if (compiler !== '') {
    localToolchain(h)
    env.SILK_TOOLCHAIN = localVersion
  }
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GITHUB_TOKEN', 'SILK_CLANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}

// Copies SILK_NEW_USER_COMPILER into the home's store. The tool only runs regular files, so the
// compiler is copied rather than linked.
function localToolchain(h) {
  const root = join(h.silkHome, 'toolchains', localVersion)
  if (existsSync(join(root, 'bin/silkc'))) return
  const from = dirname(dirname(compiler))
  mkdirSync(join(root, 'bin'), { recursive: true })
  copyFileSync(compiler, join(root, 'bin/silkc'))
  cpSync(join(from, 'lib/silk/stdlib'), join(root, 'lib/silk/stdlib'), { recursive: true })
}

export function install(h, extra = {}) {
  // Before the install, ~/.silk/bin is not on the user's PATH yet.
  const env = { ...userEnv(h, release === '' ? extra : { SILK_RELEASE: release, ...extra }), PATH: process.env.PATH }
  const script = /^https?:/.test(installer) ? `curl -fsSL '${installer}' | sh` : `sh '${installer}'`
  return sh(h, script, { env })
}

// Runs a shell command line as the user would type it, in `cwd` (default: the work folder).
export function sh(h, line, { cwd = h.work, env = userEnv(h), input, timeout = 600_000 } = {}) {
  const result = spawnSync('sh', ['-c', line], { cwd, env, input, timeout, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', signal: result.signal }
}

// Whether this home runs the silk tool: since the rename to silkc, ~/.silk/bin/silk is the tool,
// a real file, and no longer a link to a toolchain's compiler.
export function hasTool(h) {
  const front = join(h.silkHome, 'bin/silk')
  return existsSync(front) && !lstatSync(front).isSymbolicLink()
}

// Puts SILK_NEW_USER_TOOL at ~/.silk/bin/silk of an installed home, over the release's own tool.
export function addLocalTool(h) {
  if (toolBinary === '') return hasTool(h)
  const front = join(h.silkHome, 'bin/silk')
  rmSync(front, { force: true })
  copyFileSync(toolBinary, front)
  chmodSync(front, 0o755)
  return true
}

export function silk(h, args, options = {}) {
  return sh(h, ['silk', ...args].map(quote).join(' '), options)
}

export function quote(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

export function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

export function read(path) {
  return readFileSync(path, 'utf8')
}

export { existsSync, join }

// `silk init <name>` in the work folder, returning the package folder.
export function initPackage(h, name, flags = []) {
  const result = silk(h, ['init', name, ...flags])
  if (result.status !== 0) throw new Error(`silk init ${name} failed:\n${result.stderr}`)
  return join(h.work, name)
}

// Formats a command result for assertion messages.
export function show(result) {
  return `exit ${result.status}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`
}
