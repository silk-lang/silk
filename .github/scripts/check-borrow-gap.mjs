// Holds the bodies native borrow checking leaves unchecked to compiler/borrow-check-gap.txt.
//
//   check-borrow-gap.mjs corpus <corpus log>
//     Compares each corpus program's SELFHOST_BORROW_GAP receipt with its baseline line, and the
//     invalid programs the run carried as BORROW_CHECK_GAP (SELFHOST_BORROW_CARRY receipts) with the
//     baseline's `carried` lines. A new carry fails: a checker that stops checking a body must not
//     quietly turn a rejected invalid program into a gap. A recorded carry the run no longer makes
//     fails too, until `update` retires it. Any
//     difference, a rise or a fall, fails until `update` records it, and so does a program that ran
//     without a line. A line whose program did not run is only a notice, since a run filtered to
//     some programs measures only those.
//   check-borrow-gap.mjs update [--prune] <corpus log>
//     Rewrites the baseline from a corpus log, with one line for every program that ran. A line whose
//     program did not run is kept and listed as "not run", so regenerating from a filtered run never
//     loses a line; `--prune` drops those lines instead, for programs the corpus no longer has. It
//     refuses to write from a run with a failed program or with no program at all, since such a run
//     measures nothing. It is the only writer of the file. The baseline must match CI, so regenerate
//     from the corpus job's `selfhost-corpus-timings` artifact (or its log) whenever a local run
//     disagrees.
//   check-borrow-gap.mjs diff <old baseline> <new baseline>
//     Prints the per-program transition table between two baselines, for a PR body.
//   check-borrow-gap.mjs self-build <receipt directory>
//     Prints every SILK_GAP borrow-check line the self-build stages wrote, as a receipt.
//   check-borrow-gap.mjs self-test
//     Checks the corpus comparison rules against fixed baselines and receipts.
//
// The baseline has one physical line per program, `<name> <reason>=<count> ...` (a bare name when
// nothing is unchecked), one `carried <program>` line per carried invalid program, plus one
// `retired <reason> ...` line. Lines are self-contained and their order is irrelevant, so git
// merges concurrent edits with `merge=union`; totals are computed, never stored. Two lines for one
// program mean two branches changed it, and fail until `update` reruns on the merged tree.
//
// A retired reason must be zero everywhere: in every mode that reads receipts, any body unchecked
// for a retired reason fails. The self-build totals grow with the compiler, so they are printed,
// never recorded.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const baselineUrl = new URL('../../compiler/borrow-check-gap.txt', import.meta.url)
const updateHint = 'run `node .github/scripts/check-borrow-gap.mjs update <corpus log>`'
const gapPrefix = 'SILK_GAP borrow-check: '
const receiptPrefix = 'SELFHOST_BORROW_GAP='
const carryPrefix = 'SELFHOST_BORROW_CARRY='
const failures = []
const notices = []
const print = (line) => process.stdout.write(`${line}\n`)
const byText = (left, right) => Number(left > right) - Number(left < right)

// A baseline file's retired reasons and per-program counts. Repeated program lines are failures.
const parseBaseline = (text, where) => {
  const retired = new Set()
  const carried = new Set()
  const programs = new Map()
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [name, ...fields] = line.split(/\s+/)
    if (name === 'retired') {
      for (const reason of fields) retired.add(reason)
      continue
    }
    if (name === 'carried') {
      if (fields.length !== 1)
        throw new Error(`${where}:${index + 1}: a carried line names one program`)
      carried.add(fields[0])
      continue
    }
    const reasons = {}
    for (const field of fields) {
      const match = /^([a-z-]+)=(\d+)$/.exec(field)
      if (match === null) throw new Error(`${where}:${index + 1}: malformed field ${field}`)
      reasons[match[1]] = Number(match[2])
    }
    if (programs.has(name))
      failures.push(
        `${where}: ${name} has more than one line, so two changes to it were merged; keep the right one, or ${updateHint}`,
      )
    programs.set(name, reasons)
  }
  return { retired, carried, programs }
}

// Why a corpus log cannot become a baseline, or undefined when it can: a failed program, or a run
// without a single program, measures nothing. A log copied from the job view prefixes each line
// with a timestamp.
const refusal = (text, programs) => {
  const failed = text.split('\n').filter((line) => /^(?:\S+Z )?FAIL /.test(line)).length
  if (failed > 0) return `the corpus run failed ${failed} program(s); fix the run before updating`
  if (programs.size === 0) return 'the corpus log has no program receipts; nothing ran'
  return undefined
}

// The nonzero per-reason counts of every program receipt in a corpus log's text.
const receiptsOf = (text) => {
  const programs = new Map()
  for (const line of text.split('\n')) {
    // A log copied from the job view prefixes each line with a timestamp.
    const at = line.indexOf(receiptPrefix)
    if (at < 0) continue
    const receipt = JSON.parse(line.slice(at + receiptPrefix.length))
    const reasons = Object.fromEntries(
      Object.entries(receipt.reasons).filter(([, count]) => count > 0),
    )
    programs.set(receipt.name, reasons)
  }
  return programs
}

// The invalid programs a corpus log's run carried as BORROW_CHECK_GAP.
const carriesOf = (text) => {
  const carried = new Set()
  for (const line of text.split('\n')) {
    const at = line.indexOf(carryPrefix)
    if (at >= 0) carried.add(JSON.parse(line.slice(at + carryPrefix.length)).name)
  }
  return carried
}

// Records a failure for every carry the baseline does not hold, and for every baseline carry of a
// program that ran without being carried.
const compareCarries = (baseline, carried, ran) => {
  for (const name of [...carried].sort(byText))
    if (!baseline.carried.has(name))
      failures.push(
        `${name}: newly carried as BORROW_CHECK_GAP; a checker that stopped checking its offending body is a regression, and a deliberate carry needs ${updateHint}`,
      )
  for (const name of [...baseline.carried].sort(byText))
    if (ran.has(name) && !carried.has(name))
      failures.push(`${name}: is no longer carried; ${updateHint}`)
}

// The program names a corpus log's run reported a result for.
const ranOf = (text) => {
  const ran = new Set()
  for (const line of text.split('\n')) {
    const match = /(?:^|\s)(?:PASS|FAIL|UNSUPPORTED) (\S+?)(?::|$)/.exec(line)
    if (match !== null) ran.add(match[1])
  }
  return ran
}

const format = (reasons) =>
  Object.keys(reasons)
    .sort(byText)
    .map((reason) => `${reason}=${reasons[reason]}`)
    .join(' ')

const totals = (programs) => {
  const sums = {}
  for (const reasons of programs.values())
    for (const [reason, count] of Object.entries(reasons))
      sums[reason] = (sums[reason] ?? 0) + count
  return sums
}

const checkRetired = (retired, where, reasons) => {
  for (const [reason, count] of Object.entries(reasons))
    if (retired.has(reason) && count > 0)
      failures.push(`${where}: ${count} bodies unchecked for retired reason ${reason}`)
}

// Records the failures and notices of one corpus run against a baseline.
const compare = (baseline, actual) => {
  for (const [name, reasons] of actual) checkRetired(baseline.retired, name, reasons)
  const names = [...new Set([...baseline.programs.keys(), ...actual.keys()])].sort(byText)
  for (const name of names) {
    const expected = baseline.programs.get(name)
    const measured = actual.get(name)
    if (measured === undefined)
      notices.push(`${name}: has a baseline line but did not run in this corpus`)
    else if (expected === undefined)
      failures.push(`${name}: ran without a baseline line; ${updateHint}`)
    else if (format(expected) !== format(measured))
      failures.push(
        `${name}: unchecked bodies are [${format(measured)}], baseline [${format(expected)}]; ${updateHint}`,
      )
  }
}

// The program lines `update` writes, and the baseline programs absent from the run, which are kept
// unless pruned.
const updatedLines = (current, actual, prune) => {
  const programs = new Map(actual)
  const absent = [...current.programs.keys()].filter((name) => !actual.has(name)).sort(byText)
  if (!prune) for (const name of absent) programs.set(name, current.programs.get(name) ?? {})
  const lines = [...programs.keys()]
    .sort(byText)
    .map((name) => `${name} ${format(programs.get(name) ?? {})}`.trimEnd())
  return { lines, absent }
}

// The carried programs `update` writes: the run's carries, plus recorded carries of programs that
// did not run, unless pruned.
const updatedCarries = (current, carried, ran, prune) => {
  const kept = new Set(carried)
  if (!prune) for (const name of current.carried) if (!ran.has(name)) kept.add(name)
  return [...kept].sort(byText)
}

const [mode, ...operands] = process.argv.slice(2)
const prune = mode === 'update' && operands[0] === '--prune'
const [first, second] = prune ? operands.slice(1) : operands

if (mode === 'corpus') {
  const baseline = parseBaseline(readFileSync(baselineUrl, 'utf8'), 'compiler/borrow-check-gap.txt')
  const text = readFileSync(first, 'utf8')
  const actual = receiptsOf(text)
  compare(baseline, actual)
  compareCarries(baseline, carriesOf(text), ranOf(text))
  const sums = totals(actual)
  for (const reason of Object.keys(sums).sort(byText))
    print(`borrow-check ${reason}: ${sums[reason]}`)
} else if (mode === 'update') {
  // Repeated lines are what `update` repairs, so only the retired reasons can fail it.
  const current = parseBaseline(readFileSync(baselineUrl, 'utf8'), 'compiler/borrow-check-gap.txt')
  failures.length = 0
  const text = readFileSync(first, 'utf8')
  const actual = receiptsOf(text)
  const refused = refusal(text, actual)
  if (refused !== undefined) {
    process.stderr.write(`::error title=Borrow-check gap::update refused: ${refused}\n`)
    process.exit(1)
  }
  for (const [name, reasons] of actual) checkRetired(current.retired, name, reasons)
  const header = readFileSync(baselineUrl, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('#'))
  const { lines, absent } = updatedLines(current, actual, prune)
  for (const name of absent) print(`${prune ? 'pruned' : 'not run'}: ${name}`)
  const retired = [...current.retired].sort(byText).join(' ')
  const carries = updatedCarries(current, carriesOf(text), ranOf(text), prune)
  writeFileSync(
    baselineUrl,
    [
      ...header,
      `retired ${retired}`,
      ...carries.map((name) => `carried ${name}`),
      ...lines,
      '',
    ].join('\n'),
  )
} else if (mode === 'diff') {
  const before = parseBaseline(readFileSync(first, 'utf8'), first).programs
  const after = parseBaseline(readFileSync(second, 'utf8'), second).programs
  const reasons = [
    ...new Set([...Object.keys(totals(before)), ...Object.keys(totals(after))]),
  ].sort(byText)
  const rows = []
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort(byText)) {
    const old = before.get(name) ?? {}
    const now = after.get(name) ?? {}
    if (format(old) === format(now)) continue
    rows.push(
      `| ${name} | ${reasons.map((reason) => `${old[reason] ?? 0} → ${now[reason] ?? 0}`).join(' | ')} |`,
    )
  }
  const oldTotals = totals(before)
  const newTotals = totals(after)
  print(`| program | ${reasons.join(' | ')} |`)
  print(`| --- |${reasons.map(() => ' ---: |').join('')}`)
  for (const row of rows) print(row)
  print(
    `| total | ${reasons.map((reason) => `${oldTotals[reason] ?? 0} → ${newTotals[reason] ?? 0}`).join(' | ')} |`,
  )
} else if (mode === 'self-build') {
  const { retired } = parseBaseline(
    readFileSync(baselineUrl, 'utf8'),
    'compiler/borrow-check-gap.txt',
  )
  for (const name of readdirSync(first)
    .filter((file) => file.endsWith('-stderr.bin'))
    .sort(byText)) {
    for (const line of readFileSync(join(first, name), 'utf8').split('\n')) {
      if (!line.startsWith(gapPrefix)) continue
      print(`${name}: ${line}`)
      const match = /^(\d+) bodies not borrow-checked \(([^)]*)\)$/.exec(
        line.slice(gapPrefix.length),
      )
      if (match === null) throw new Error(`Malformed borrow-check gap line: ${line}`)
      const reasons = {}
      for (const part of match[2].split(';', 1)[0].split(', ')) {
        const reason = /^([a-z-]+) (\d+)$/.exec(part)
        if (reason !== null) reasons[reason[1]] = Number(reason[2])
      }
      checkRetired(retired, name, reasons)
    }
  }
} else if (mode === 'self-test') {
  const outcome = (baselineText, receipts) => {
    failures.length = 0
    notices.length = 0
    compare(parseBaseline(baselineText, 'fixture'), new Map(Object.entries(receipts)))
    return { failures: failures.length, notices: notices.length }
  }
  const expect = (label, actual, expected) => {
    if (actual.failures !== expected.failures || actual.notices !== expected.notices)
      throw new Error(`${label}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
  const baselineText = 'retired patterns\nalpha regions=2\nbeta\n'
  const agreeing = { alpha: { regions: 2 }, beta: {} }
  expect('agreeing run', outcome(baselineText, agreeing), { failures: 0, notices: 0 })
  expect('absent program', outcome(baselineText, { alpha: { regions: 2 } }), {
    failures: 0,
    notices: 1,
  })
  expect('program without a line', outcome(baselineText, { ...agreeing, gamma: {} }), {
    failures: 1,
    notices: 0,
  })
  expect('disagreeing line', outcome(baselineText, { ...agreeing, alpha: { regions: 1 } }), {
    failures: 1,
    notices: 0,
  })
  expect('repeated line', outcome(`${baselineText}beta\n`, agreeing), { failures: 1, notices: 0 })
  expect('retired reason', outcome(baselineText, { ...agreeing, beta: { patterns: 1 } }), {
    failures: 2,
    notices: 0,
  })
  const current = parseBaseline(baselineText, 'fixture')
  const ran = new Map(Object.entries({ beta: { regions: 1 } }))
  const kept = updatedLines(current, ran, false)
  const pruned = updatedLines(current, ran, true)
  if (kept.lines.join('|') !== 'alpha regions=2|beta regions=1')
    throw new Error(`update keeps a line whose program did not run: ${kept.lines.join('|')}`)
  if (pruned.lines.join('|') !== 'beta regions=1' || pruned.absent.join('|') !== 'alpha')
    throw new Error(`update --prune drops it: ${pruned.lines.join('|')}`)
  const receipt = (name) =>
    `SELFHOST_BORROW_GAP=${JSON.stringify({ name, reasons: { regions: 1 } })}`
  const passing = `PASS alpha\n${receipt('alpha')}\n`
  if (refusal(passing, receiptsOf(passing)) !== undefined)
    throw new Error('update accepts a run whose programs all passed')
  const failing = `${passing}2026-10-12T18:00:00.0000000Z FAIL beta: code=X\n${receipt('beta')}\n`
  if (refusal(failing, receiptsOf(failing)) === undefined)
    throw new Error('update refuses a run with a failed program')
  const empty = 'Selfhost corpus: pass=0 fail=0 unsupported=0 track=0\n'
  if (refusal(empty, receiptsOf(empty)) === undefined)
    throw new Error('update refuses a run with no program receipts')
  const carryBaseline = parseBaseline('carried alpha\nalpha\n', 'fixture')
  const carryFailures = (carried, ran) => {
    failures.length = 0
    compareCarries(carryBaseline, new Set(carried), new Set(ran))
    return failures.length
  }
  if (carryFailures(['alpha'], ['alpha']) !== 0) throw new Error('a recorded carry passes')
  if (carryFailures(['alpha', 'beta'], ['alpha', 'beta']) !== 1)
    throw new Error('a new carry fails')
  if (carryFailures([], ['alpha']) !== 1) throw new Error('a carry the run no longer makes fails')
  if (carryFailures([], []) !== 0) throw new Error('a carry whose program did not run is kept')
  const carryLog = `UNSUPPORTED beta: BORROW_CHECK_GAP: x\nSELFHOST_BORROW_CARRY={"name":"beta"}\nPASS alpha\n`
  if (
    [...carriesOf(carryLog)].join() !== 'beta' ||
    [...ranOf(carryLog)].sort(byText).join() !== 'alpha,beta'
  )
    throw new Error('carries and ran programs are read from the log')
  if (
    updatedCarries(carryBaseline, new Set(['beta']), new Set(['beta']), false).join() !==
    'alpha,beta'
  )
    throw new Error('update keeps a carry whose program did not run')
  failures.length = 0
  notices.length = 0
  print('borrow-gap guard self-test passed')
} else {
  throw new Error(
    'Usage: check-borrow-gap.mjs corpus <log> | update [--prune] <log> | diff <old> <new> | self-build <directory> | self-test',
  )
}

for (const notice of notices) process.stdout.write(`::notice title=Borrow-check gap::${notice}\n`)
if (failures.length > 0) {
  for (const failure of failures)
    process.stderr.write(`::error title=Borrow-check gap::${failure}\n`)
  process.exit(1)
}
