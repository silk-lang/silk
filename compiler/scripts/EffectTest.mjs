// `it` and `assert` for the script tests on `node:test`. `it.effect` runs a scoped Effect as a
// test; `it.layer(layer)` hands its callback an `it` whose effects get that layer.
import nodeAssert from 'node:assert/strict'
import { it as test } from 'node:test'
import * as Effect from 'effect/Effect'

const timeout = 3000
const effectIt = (provide) => {
  const it = (name, body) => test(name, { timeout }, body)
  it.effect = (name, body) =>
    test(name, { timeout }, () => Effect.runPromise(provide(Effect.scoped(Effect.suspend(body)))))
  it.layer = (layer) => (register) => register(effectIt((effect) => Effect.provide(effect, layer)))
  return it
}
export const it = effectIt((effect) => effect)

export const assert = {
  ...nodeAssert,
  deepEqual: nodeAssert.deepStrictEqual,
  isTrue: (value, message) => nodeAssert.strictEqual(value, true, message),
  isFalse: (value, message) => nodeAssert.strictEqual(value, false, message),
  isAtMost: (value, limit, message) =>
    nodeAssert.ok(value <= limit, message ?? `expected ${value} to be at most ${limit}`),
  instanceOf: (value, type, message) => nodeAssert.ok(value instanceof type, message),
  include: (haystack, needle, message) =>
    nodeAssert.ok(haystack.includes(needle), message ?? `expected to include ${String(needle)}`),
  notInclude: (haystack, needle, message) =>
    nodeAssert.ok(!haystack.includes(needle), message ?? `expected not to include ${String(needle)}`),
}
