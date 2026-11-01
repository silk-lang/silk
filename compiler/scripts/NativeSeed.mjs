// The native seed chain's pin and its verified seed. Every seed is an earlier published native
// compiler, and the first, n0, is the bootstrap anchor's compiler built by the bootstrap; recovery
// from a broken chain pins an older published release.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Console from 'effect/Console'
import { hash } from './SourceSnapshot.mjs'
import { isVersion } from './SemVer.mjs'

export class NativeSeedError extends Data.TaggedError('NativeSeedError') {}
const invalid = (message) => Effect.fail(new NativeSeedError({ message }))
export const targets = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
]
export const TargetSchema = Schema.Literals(targets)
export const seedAsset = (target) =>
  `silk-compiler-${target}${target === 'x86_64-pc-windows-msvc' ? '.exe' : ''}`
const Hex = (length) => Schema.String.check(Schema.isPattern(new RegExp(`^[a-f0-9]{${length}}$`)))
// Compiler releases and frozen-bootstrap native seeds have distinct publication namespaces.
const isSeedTag = (tag) =>
  tag.startsWith('bootstrap-native-v')
    ? isVersion(tag.slice('bootstrap-native-v'.length))
    : tag.startsWith('v') && isVersion(tag.slice(1))
/**
 * `compiler/native-seed.json`: the only authority for the compiler that builds N1. Every published
 * candidate carries this pin as its `native-seed.json`, so recovery commits an older one verbatim.
 */
const ReleaseSchema = Schema.TaggedStruct('Release', {
  target: TargetSchema,
  tag: Schema.String,
  asset: Schema.String,
  sha256: Hex(64),
  sourceCommit: Hex(40),
  runId: Schema.String.check(Schema.isPattern(/^\d+$/)),
})
export const PinSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  seeds: Schema.Record(Schema.String, ReleaseSchema),
})
/** @typedef {import('effect/Schema').Schema.Type<typeof PinSchema>} Pin */
const validatePin = Effect.fnUntraced(
  /** @param {Pin} pin */
  function* (pin) {
    if (Object.keys(pin.seeds).length === 0)
      return yield* invalid('A pin must name at least one seed')
    for (const [target, seed] of Object.entries(pin.seeds)) {
      if (target !== seed.target) return yield* invalid('Native seed key must match its target')
      if (seed.asset !== seedAsset(seed.target))
        return yield* invalid('Native seed asset must name its target')
      if (!isSeedTag(seed.tag))
        return yield* invalid('Native seed tag must be v<semver> or bootstrap-native-v<semver>')
    }
    return pin
  },
)
export const selectSeed = Effect.fn('NativeSeed.selectSeed')(
  /** @param {Pin} pin @param {string} target */
  function* (pin, target) {
    yield* Schema.decodeEffect(TargetSchema)(target)
    yield* validatePin(pin)
    const seed = pin.seeds[target]
    if (!seed) return yield* invalid(`No native seed is pinned for ${target}`)
    return seed
  },
)
const encodePin = Schema.encodeEffect(Schema.fromJsonString(PinSchema))

export const readPin = Effect.fn('NativeSeed.readPin')(
  /** @param {string} path */
  function* (path) {
    const fs = yield* FileSystem.FileSystem
    const pin = yield* Schema.decodeEffect(Schema.fromJsonString(PinSchema))(
      yield* fs.readFileString(path),
    )
    return yield* validatePin(pin)
  },
)

/** Checks downloaded bytes against the pin before they become an executable. */
export const verifySeed = Effect.fn('NativeSeed.verifySeed')(
  /** @param {{pin:string,target:string,download:string,destination:string}} options */
  function* ({ pin: pinPath, target, download, destination }) {
    const fs = yield* FileSystem.FileSystem
    const pin = yield* readPin(pinPath)
    const seed = yield* selectSeed(pin, target)
    const bytes = yield* fs.readFile(download)
    if (hash(bytes) !== seed.sha256)
      return yield* invalid(
        `Downloaded seed SHA-256 ${hash(bytes)} differs from pinned ${seed.sha256}`,
      )
    if (yield* fs.exists(destination)) return yield* invalid('Seed destination must be fresh')
    yield* fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o555 })
    yield* fs.chmod(destination, 0o555)
    if (hash(yield* fs.readFile(destination)) !== seed.sha256)
      return yield* invalid('Seed changed while it was installed')
    return pin
  },
)

/** The ready-to-commit pin for a published fixpoint compiler; publication never commits it. */
export const candidate = Effect.fn('NativeSeed.candidate')(
  /** @param {{target:string,tag:string,sha256:string,sourceCommit:string,runId:string}} options */
  function* ({ target, tag, sha256, sourceCommit, runId }) {
    const pin = {
      schemaVersion: 2,
      seeds: {
        [target]: {
          _tag: 'Release',
          target,
          tag,
          asset: seedAsset(target),
          sha256,
          sourceCommit,
          runId,
        },
      },
    }
    return yield* validatePin(yield* Schema.decodeUnknownEffect(PinSchema)(pin))
  },
)

const BuildReceiptSchema = Schema.Struct({
  status: Schema.Literal('passed'),
  target: TargetSchema,
  output: Schema.Struct({ generation: Schema.String, sha256: Hex(64) }),
  inputs: Schema.Struct({ sourceCommit: Hex(40) }),
  fixpoint: Schema.Struct({ producerIrSha256: Hex(64), outputIrSha256: Hex(64) }),
})

/** Reads a passed fixpoint receipt before producing its ready-to-publish seed coordinates. */
export const readCandidate = Effect.fn('NativeSeed.readCandidate')(
  /** @param {{receipt:string,runId:string,tag:string}} options */
  function* ({ receipt: receiptPath, runId, tag }) {
    const fs = yield* FileSystem.FileSystem
    const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(BuildReceiptSchema))(
      yield* fs.readFileString(receiptPath),
    )
    if (receipt.fixpoint.producerIrSha256 !== receipt.fixpoint.outputIrSha256)
      return yield* invalid('A seed candidate requires an IR fixpoint')
    return yield* candidate({
      target: receipt.target,
      tag,
      sha256: receipt.output.sha256,
      sourceCommit: receipt.inputs.sourceCommit,
      runId,
    })
  },
)

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second, third, fourth, ...extra] = process.argv.slice(2)
  const require = createRequire(new URL('../../package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  const printPin = (pin) => Effect.flatMap(encodePin(pin), Console.log)
  let program
  // GitHub step outputs: the pinned release's coordinates.
  if (command === 'outputs' && first && second && !third)
    program = Effect.gen(function* () {
      const seed = yield* selectSeed(yield* readPin(resolve(first)), second)
      yield* Console.log(`tag=${seed.tag}\nasset=${seed.asset}\nsha256=${seed.sha256}`)
    })
  else if (command === 'verify' && first && second && third && fourth && extra.length === 0)
    program = Effect.flatMap(
      verifySeed({
        pin: resolve(first),
        target: second,
        download: resolve(third),
        destination: resolve(fourth),
      }),
      printPin,
    )
  else if (command === 'candidate' && first && second && third && !fourth)
    program = Effect.flatMap(
      readCandidate({ receipt: resolve(first), runId: second, tag: third }),
      printPin,
    )
  else
    program = invalid(
      'usage: node NativeSeed.mjs outputs <pin> <target> | verify <pin> <target> <download> <destination> | candidate <fixpoint-build-receipt> <run-id> <tag>',
    )
  await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
}
