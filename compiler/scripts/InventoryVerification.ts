import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import type * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Inventory from './BootstrapClosureInventory.js'

/** Explicit transport only; the collector owns all source and selected-fact validation. */
export const Request = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  directory: Schema.NonEmptyString,
  inputs: Inventory.InputSnapshotSchema,
  bootstrap: Schema.Struct({
    commit: Schema.NonEmptyString,
    runId: Schema.NonEmptyString,
    file: Schema.NonEmptyString,
    sha256: Schema.NonEmptyString,
    stdlibDigest: Schema.NonEmptyString,
  }),
  profile: Schema.Struct({
    name: Schema.Literal('release-with-debug'),
    target: Schema.NonEmptyString,
    optimization: Schema.Literal('speed'),
    debug: Schema.Literal(true),
  }),
})

/** Emit the complete collector transport before rejecting incomplete selected realization. */
export const runConfigured = Effect.fn('InventoryVerification.runConfigured')(
  function* (): Effect.fn.Return<
    void,
    Inventory.InventoryError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem
    const file = yield* Config.NonEmptyString('SILK_INVENTORY_REQUEST').pipe(
      Effect.mapError(
        (cause) =>
          new Inventory.InventoryError({
            operation: 'read inventory request',
            message: cause.message,
            reason: 'InvalidInput',
          }),
      ),
    )
    const request = yield* Schema.decodeEffect(Schema.fromJsonString(Request))(
      yield* fs.readFileString(file),
      { onExcessProperty: 'error' },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Inventory.InventoryError({
            operation: 'decode inventory request',
            message: cause.message,
            reason: 'InvalidInput',
          }),
      ),
    )
    const inventory = yield* Inventory.analyze(request)
    const encoded = yield* Inventory.encode(inventory)
    // NodeRuntime may terminate immediately after failure. Await the stdout callback so
    // even a large Incomplete transport is fully drained before the red exit.
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(`${encoded}\n`, (error) => {
            if (error !== null && error !== undefined) reject(error)
            else resolve()
          })
        }),
      catch: (cause) =>
        new Inventory.InventoryError({
          operation: 'write inventory transport',
          message: 'Could not write the complete inventory JSON',
          reason: 'WrappedFailure',
          cause,
        }),
    })
    if (inventory.status !== 'Complete')
      return yield* new Inventory.InventoryError({
        operation: 'publish selected inventory',
        message: 'Selected inventory is Incomplete; executable readiness is not established',
        reason: 'UnavailableProvenance',
      })
  },
)
