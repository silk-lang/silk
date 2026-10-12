// The native seed chain's pin and its verified seed. Every seed is an earlier published native
// compiler; recovery from a broken chain pins an older published release.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Console from 'effect/Console'
import { hash } from './SourceSnapshot.mjs'

export class NativeSeedError extends Data.TaggedError('NativeSeedError') {}
const invalid = (message) => Effect.fail(new NativeSeedError({ message }))
export const seedAsset = 'silk-compiler-x86_64-unknown-linux-gnu'
const Hex = (length) => Schema.String.check(Schema.isPattern(new RegExp(`^[a-f0-9]{${length}}$`)))
/**
 * `compiler/native-seed.json`: the only authority for the compiler that builds N1. Every published
 * candidate carries this pin as its `native-seed.json`, so recovery commits an older one verbatim.
 */
export const PinSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  seed: Schema.TaggedStruct('Release', {
    target: Schema.Literal('x86_64-unknown-linux-gnu'),
    tag: Schema.String.check(Schema.isPattern(/^native-seed-[a-f0-9]{40}$/)),
    asset: Schema.Literal(seedAsset),
    sha256: Hex(64),
    sourceCommit: Hex(40),
    runId: Schema.String.check(Schema.isPattern(/^\d+$/)),
  }),
})
const encodePin = Schema.encodeEffect(Schema.fromJsonString(PinSchema))

export const readPin = Effect.fn('NativeSeed.readPin')(
  /** @param {string} path */
  function* (path) {
    const fs = yield* FileSystem.FileSystem
    const pin = yield* Schema.decodeEffect(Schema.fromJsonString(PinSchema))(
      yield* fs.readFileString(path),
    )
    if (pin.seed.tag !== `native-seed-${pin.seed.sourceCommit}`)
      return yield* invalid('Native seed tag must name its source commit')
    return pin
  },
)

/** Checks downloaded bytes against the pin before they become an executable. */
export const verifySeed = Effect.fn('NativeSeed.verifySeed')(
  /** @param {{pin:string,download:string,destination:string}} options */
  function* ({ pin: pinPath, download, destination }) {
    const fs = yield* FileSystem.FileSystem
    const pin = yield* readPin(pinPath)
    const bytes = yield* fs.readFile(download)
    if (hash(bytes) !== pin.seed.sha256)
      return yield* invalid(
        `Downloaded seed SHA-256 ${hash(bytes)} differs from pinned ${pin.seed.sha256}`,
      )
    if (yield* fs.exists(destination)) return yield* invalid('Seed destination must be fresh')
    yield* fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o555 })
    yield* fs.chmod(destination, 0o555)
    if (hash(yield* fs.readFile(destination)) !== pin.seed.sha256)
      return yield* invalid('Seed changed while it was installed')
    return pin
  },
)

/** The ready-to-commit pin for a published fixpoint compiler; publication never commits it. */
export const candidate = Effect.fn('NativeSeed.candidate')(
  /** @param {{sha256:string,sourceCommit:string,runId:string}} options */
  function* ({ sha256, sourceCommit, runId }) {
    const pin = {
      schemaVersion: 1,
      seed: {
        _tag: 'Release',
        target: 'x86_64-unknown-linux-gnu',
        tag: `native-seed-${sourceCommit}`,
        asset: seedAsset,
        sha256,
        sourceCommit,
        runId,
      },
    }
    return yield* Schema.decodeUnknownEffect(PinSchema)(pin)
  },
)

const BuildReceiptSchema = Schema.Struct({
  status: Schema.Literal('passed'),
  output: Schema.Struct({ generation: Schema.String, sha256: Hex(64) }),
  inputs: Schema.Struct({ sourceCommit: Hex(40) }),
  fixpoint: Schema.Struct({ producerIrSha256: Hex(64), outputIrSha256: Hex(64) }),
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second, third] = process.argv.slice(2)
  const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  const printPin = (pin) => Effect.flatMap(encodePin(pin), Console.log)
  let program
  // GitHub step outputs: the pinned release's coordinates.
  if (command === 'outputs' && first && !second)
    program = Effect.gen(function* () {
      const { seed } = yield* readPin(resolve(first))
      yield* Console.log(`tag=${seed.tag}\nasset=${seed.asset}\nsha256=${seed.sha256}`)
    })
  else if (command === 'verify' && first && second && third)
    program = Effect.flatMap(
      verifySeed({
        pin: resolve(first),
        download: resolve(second),
        destination: resolve(third),
      }),
      printPin,
    )
  else if (command === 'candidate' && first && second && !third)
    program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(BuildReceiptSchema))(
        yield* fs.readFileString(resolve(first)),
      )
      if (receipt.fixpoint.producerIrSha256 !== receipt.fixpoint.outputIrSha256)
        return yield* invalid('A seed candidate requires an IR fixpoint')
      yield* printPin(
        yield* candidate({
          sha256: receipt.output.sha256,
          sourceCommit: receipt.inputs.sourceCommit,
          runId: second,
        }),
      )
    })
  else
    program = invalid(
      'usage: node NativeSeed.mjs outputs <pin> | verify <pin> <download> <destination> | candidate <fixpoint-build-receipt> <run-id>',
    )
  await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
}
