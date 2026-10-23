// Every runnable program in the silk-lang/docs pages builds, prints what the page shows and fails
// with the errors the page shows. Needs SILK_NEW_USER_DOCS, a silk-lang/docs checkout.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { checkAll, checkGuide, failing, wholeGuides } from './docs-samples.mjs'
import { docsRoot } from './lib.mjs'

// Known mismatches, by sample id, with the finding that tracks each.
const known = new Map([
  ['book/07-effects-and-failures.md:355', 'finding 9: stdlib frame line numbers drift'],
  ['reference/06-program-entry-and-termination.md:93', 'finding 9: stdlib frame line numbers drift'],
  ['appendix/03-diagnostic-codes.md:2705', 'finding 8: SEM0090 entry is stale'],
])

test('docs programs', { skip: docsRoot === '' ? 'set SILK_NEW_USER_DOCS to a silk-lang/docs checkout' : false, timeout: 3_600_000 }, async (t) => {
  const results = await checkAll(docsRoot, { all: process.env.SILK_NEW_USER_RUN_ALL === '1' })
  assert.ok(results.length > 100, `found only ${results.length} programs; did the docs layout change?`)
  for (const result of results) {
    await t.test(result.id, { todo: failing(result) && known.has(result.id) ? known.get(result.id) : undefined }, () => {
      assert.ok(!failing(result), `${result.outcome}\n${result.detail ?? ''}`)
    })
  }
})

test('guides whose blocks make one program print what they show', { skip: docsRoot === '' ? 'set SILK_NEW_USER_DOCS to a silk-lang/docs checkout' : false, timeout: 1_800_000 }, async (t) => {
  for (const id of wholeGuides) {
    await t.test(id, async () => {
      const { shown, debug, release } = await checkGuide(docsRoot, id)
      assert.equal(debug.status, 0, debug.stderr)
      assert.equal(release.status, 0, release.stderr)
      assert.ok(shown !== undefined, 'the guide shows no silk run output')
      assert.equal(debug.stdout.trimEnd(), shown)
      assert.equal(release.stdout, debug.stdout)
    })
  }
})
