import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

/**
 * The workspace's test defaults only hold for packages that actually extend them, and the way this
 * repo has lost that property four times is not disagreement — it is a new package arriving with
 * no `vitest.config.ts`, silently taking Vitest's 5 s default, and becoming the first suite to be
 * reported as a timeout the next time the runner is busy. `packages/lsp` reached that state and
 * cost two pull requests a CI round before anyone looked at which packages had a config.
 *
 * So this is checked rather than remembered. A new package with tests fails the gate here, at the
 * point where it is cheap to fix, instead of failing somebody else's unrelated branch later.
 */

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sharedConfig = 'vitest.shared.js'

const directoriesIn = (group) => {
  const groupRoot = join(workspaceRoot, group)
  if (!existsSync(groupRoot)) return []
  return readdirSync(groupRoot)
    .map((entry) => join(groupRoot, entry))
    .filter((entry) => statSync(entry).isDirectory())
}

const testFilesIn = (directory) => {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.test.ts')) found.push(path)
    }
  }
  walk(directory)
  return found
}

const packagesWithTests = () =>
  [...directoriesIn('packages'), ...directoriesIn('apps')].filter((directory) => {
    const manifest = join(directory, 'package.json')
    if (!existsSync(manifest)) return false
    const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof scripts.test !== 'string' || !scripts.test.includes('vitest')) return false
    return testFilesIn(directory).length > 0
  })

void test('every package that runs vitest extends the workspace test defaults', () => {
  const offenders = packagesWithTests().filter((directory) => {
    const config = join(directory, 'vitest.config.ts')
    if (!existsSync(config)) return true
    return !readFileSync(config, 'utf8').includes(sharedConfig)
  })

  assert.deepEqual(
    offenders.map((directory) => relative(workspaceRoot, directory)),
    [],
    `Each of these runs vitest but does not extend ${sharedConfig}, so it silently takes vitest's ` +
      `5 s default timeout. Add a vitest.config.ts that re-exports the workspace defaults.`,
  )
})

/**
 * `packages/compiler` is the critical path of `pnpm check` and states its reason in its own config.
 * Every other package leaves the worker count to vitest, whose default is already host-derived and
 * leaves a spare core — #177 is what happens when that core is taken away.
 */
const mayChooseItsOwnWorkerCount = new Set(['packages/compiler'])

void test('only the critical-path package chooses its own worker count', () => {
  // Three packages carried a local `maxWorkers` before #173, each added after that package had
  // turned someone else's pull request red. A local cap looks like the bound, so the next person
  // adds a fourth instead of touching the workspace-level run. Whoever adds one now has to come
  // through here and write down why.
  const chosen = packagesWithTests()
    .filter((directory) => {
      const config = join(directory, 'vitest.config.ts')
      return existsSync(config) && readFileSync(config, 'utf8').includes('maxWorkers')
    })
    .map((directory) => relative(workspaceRoot, directory))

  assert.deepEqual(
    chosen.filter((name) => !mayChooseItsOwnWorkerCount.has(name)),
    [],
    'How many suites overlap is bounded for the whole run by scripts/concurrency.mjs; how many ' +
      "workers one suite uses is vitest's host-derived default. A package that needs to depart " +
      'from that states why, and is listed here.',
  )
})

const ciWorkflow = readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')

const ciJobBody = (name) => {
  const startMarker = `  ${name}:\n`
  const start = ciWorkflow.indexOf(startMarker)
  assert.notEqual(start, -1, `CI workflow is missing the ${name} job`)

  const remainder = ciWorkflow.slice(start + startMarker.length)
  const nextJob = /^  [a-z][a-z0-9-]+:\n/m.exec(remainder)
  const end = nextJob === null ? undefined : start + startMarker.length + nextJob.index
  return ciWorkflow.slice(start, end)
}

void test('every Linux native test job selects the complete verified LLVM toolchain', () => {
  for (const job of ['package-tests', 'native-acceptance', 'compiler-tests']) {
    assert.match(
      ciJobBody(job),
      /uses: \.\/\.github\/actions\/setup-linux-llvm/,
      `${job} must select the complete LLVM installation rather than the runner default`,
    )
  }
  const setup = readFileSync(
    join(workspaceRoot, '.github/actions/setup-linux-llvm/action.yml'),
    'utf8',
  )
  assert.match(setup, /sha256sum -c -/, 'Downloaded tools must be checked against a pinned digest')
  assert.match(
    setup,
    /bin.*GITHUB_PATH/,
    'Generic clang invocations must use the selected installation',
  )
  assert.match(setup, /SILK_TEST_CLANG=.*\/bin\/clang/)
  assert.match(setup, /SILK_TEST_LLVM_AR=.*\/bin\/llvm-ar/)
})

void test('exact-head full verification remains explicit and complete', () => {
  assert.match(
    ciWorkflow,
    /^      full_verification:\n        description:[^\n]+\n        required: true\n        type: boolean\n        default: false$/m,
  )
  assert.match(
    ciWorkflow,
    /^      expected_sha:\n        description:[^\n]+\n        required: true\n        type: string$/m,
  )
  const full = ciJobBody('full-verification')
  assert.match(
    full,
    /^    if: github\.event_name == 'workflow_dispatch' && inputs\.full_verification$/m,
  )
  assert.match(full, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(full, /^          EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}$/m)
  assert.match(full, /test "\$\{\{ github\.sha \}\}" = "\$EXPECTED_SHA"/)
  assert.match(full, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/)
  assert.match(full, /uses: \.\/\.github\/actions\/setup-linux-llvm/)
  assert.match(full, /^      - run: pnpm check$/m)
  assert.match(full, /timeout-minutes: 240/)
  const scenarios = [
    ...['push', 'pull_request', 'schedule'].map((event) => ({
      event,
      full: false,
      workload: '',
      enabled: ['platform-supplies'],
    })),
    {
      event: 'workflow_dispatch',
      full: false,
      workload: '',
      enabled: ['platform-supplies'],
    },
    {
      event: 'workflow_dispatch',
      full: false,
      workload: 'a'.repeat(40),
      enabled: ['selfhost-bootstrap-plan'],
    },
    {
      event: 'workflow_dispatch',
      full: true,
      workload: '',
      enabled: ['full-verification'],
    },
    {
      event: 'workflow_dispatch',
      full: true,
      workload: 'a'.repeat(40),
      enabled: ['full-verification'],
    },
  ]
  for (const scenario of scenarios) {
    const enabled = ['full-verification', 'selfhost-bootstrap-plan', 'platform-supplies'].filter(
      (job) => {
        const condition = /^    if: ([^\n]+)$/m.exec(ciJobBody(job))?.[1]
        assert.ok(condition, `${job} must declare its event gate`)
        // These repository-owned GitHub gates use the shared JavaScript boolean/string operators.
        return runInNewContext(condition, {
          github: { event_name: scenario.event },
          inputs: { full_verification: scenario.full, selfhost_sha: scenario.workload },
        })
      },
    )
    assert.deepEqual(enabled, scenario.enabled, JSON.stringify(scenario))
  }
})

void test('TLS client smoke coverage uses only the bounded focused witnesses', () => {
  for (const name of [
    'authenticated-tls-client-core',
    'authenticated-tls-client-demand-request',
    'authenticated-tls-client-key-update',
    'authenticated-tls-client-closure-control',
    'authenticated-tls-client-handshake-policy',
    'authenticated-tls-client-resource-policy',
  ]) {
    assert.match(ciWorkflow, new RegExp(`(?:^|,|"cases":")${name}(?:,|"})`))
  }
  assert.doesNotMatch(ciWorkflow, /authenticated-tls-client-(?:traffic|limits)/)
})
