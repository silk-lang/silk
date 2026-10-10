import { assert, it } from '@effect/vitest'
import * as ExecutionTransition from '../src/ExecutionTransition.js'

const edge = (result: ExecutionTransition.Result): ExecutionTransition.Edge => {
  assert.strictEqual(result._tag, 'ExecutionTransitionEdge')
  if (result._tag !== 'ExecutionTransitionEdge') throw new RangeError('expected transition edge')
  assert.deepEqual(ExecutionTransition.verifyEdge(result), [])
  return result
}

it('starts, relinquishes, resumes, and completes one activation chain', () => {
  const started = edge(ExecutionTransition.drive(ExecutionTransition.initialize(2, 7)))
  const relinquished = edge(ExecutionTransition.relinquish(started.after))
  const resumed = edge(ExecutionTransition.drive(relinquished.after))
  const completed = edge(ExecutionTransition.complete(resumed.after))

  assert.strictEqual(started.event, 'Start')
  assert.strictEqual(resumed.event, 'Resume')
  assert.deepEqual(completed.cleanup, ['Frames', 'Endpoint', 'Authority'])
  assert.strictEqual(completed.after.execution, 'Completed')
  assert.notInclude(ExecutionTransition.encode(completed), 'offset')
})

it('traps a nested drive and cancels only unstarted or relinquished packages', () => {
  const running = edge(ExecutionTransition.drive(ExecutionTransition.initialize(0, 1))).after
  assert.strictEqual(ExecutionTransition.drive(running)._tag, 'FatalExecutionTrap')
  assert.strictEqual(ExecutionTransition.cancel(running)._tag, 'ExecutionTransitionViolation')

  const relinquished = edge(ExecutionTransition.relinquish(running)).after
  const cancelled = edge(ExecutionTransition.cancel(relinquished))
  assert.deepEqual(cancelled.cleanup, ['Frames', 'Endpoint', 'Authority'])
  assert.strictEqual(
    ExecutionTransition.drive(cancelled.after)._tag,
    'ExecutionTransitionViolation',
  )
})

it('verifies only the canonical package authority table', () => {
  const authority = ExecutionTransition.authority(3, 4)
  assert.deepEqual(ExecutionTransition.verifyAuthority(authority), [])
  assert.include(
    ExecutionTransition.verifyAuthority({ ...authority, edges: authority.edges.slice(1) }),
    'IncompleteTransitionAuthority',
  )
})
