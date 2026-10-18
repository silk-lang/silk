// Repository entry point for native documentation commands. SILK_COMPILER must name a compiler
// built from this checkout; this launcher never imports or falls back to the TypeScript compiler.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as NativeProcess from './NativeProcess.ts'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const program = Effect.gen(function* () {
  const compiler = resolve(yield* Config.NonEmptyString('SILK_COMPILER'))
  const invocation = args.includes('--stdlib-root')
    ? args
    : [...args, '--stdlib-root', `${repository}stdlib`]
  const result = yield* NativeProcess.execute(compiler, invocation, {
    cwd: repository,
    stdio: 'inherit',
  })
  if (result.signal !== null) {
    yield* Console.error(`Native documentation command terminated by ${result.signal}`)
    return 2
  }
  return result.status ?? 2
}).pipe(
  Effect.catch((error) =>
    Console.error(
      `Cannot run native documentation: ${String(error)}\nSet SILK_COMPILER to a native compiler built from this checkout.`,
    ).pipe(Effect.as(2)),
  ),
)

process.exitCode = await Effect.runPromise(program)
