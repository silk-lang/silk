import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'

export type Operation = 'Storage.read' | 'Storage.publish'

export type StorageErrorReason =
  | {
      readonly _tag: 'InvalidAddress'
      readonly component: 'namespace' | 'key'
      readonly value: string
    }
  | { readonly _tag: 'InvalidLimit'; readonly maximumBytes: number }
  | {
      readonly _tag: 'Oversize'
      readonly maximumBytes: number
      readonly actualBytes: bigint
    }
  | { readonly _tag: 'ReadFailure'; readonly cause: unknown }
  | { readonly _tag: 'PublishFailure'; readonly cause: unknown }

export class StorageError extends Data.TaggedError('StorageError')<{
  readonly operation: Operation
  readonly namespace: string
  readonly key: string
  readonly message: string
  readonly reason: StorageErrorReason
}> {}

export interface Address {
  readonly _tag: 'StorageAddress'
  readonly namespace: string
  readonly key: string
}

export interface Service {
  readonly read: (
    address: Address,
    maximumBytes: number,
  ) => Effect.Effect<Option.Option<Uint8Array>, StorageError>
  readonly publish: (
    address: Address,
    bytes: Uint8Array,
    maximumBytes: number,
  ) => Effect.Effect<void, StorageError>
}

export class Storage extends Context.Service<Storage, Service>()('@silklang/compiler/Storage') {}

const maximumComponentLength = 160
const componentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const addressError = (
  operation: Operation,
  namespace: string,
  key: string,
  component: 'namespace' | 'key',
  value: string,
): StorageError =>
  new StorageError({
    operation,
    namespace,
    key,
    message: `Invalid storage ${component} ${JSON.stringify(value)}`,
    reason: { _tag: 'InvalidAddress', component, value },
  })

const validateComponent = (
  operation: Operation,
  namespace: string,
  key: string,
  component: 'namespace' | 'key',
  value: string,
): Effect.Effect<string, StorageError> =>
  value.length > 0 &&
  value.length <= maximumComponentLength &&
  value !== '.' &&
  value !== '..' &&
  componentPattern.test(value)
    ? Effect.succeed(value)
    : Effect.fail(addressError(operation, namespace, key, component, value))

const validateAddress = Effect.fnUntraced(function* (
  operation: Operation,
  namespace: string,
  key: string,
): Effect.fn.Return<Address, StorageError> {
  yield* validateComponent(operation, namespace, key, 'namespace', namespace)
  yield* validateComponent(operation, namespace, key, 'key', key)
  return { _tag: 'StorageAddress', namespace, key }
})

const validateLimit = (
  operation: Operation,
  namespace: string,
  key: string,
  maximumBytes: number,
): Effect.Effect<number, StorageError> =>
  Number.isSafeInteger(maximumBytes) && maximumBytes > 0
    ? Effect.succeed(maximumBytes)
    : Effect.fail(
        new StorageError({
          operation,
          namespace,
          key,
          message: `Invalid maximum storage record size ${maximumBytes}`,
          reason: { _tag: 'InvalidLimit', maximumBytes },
        }),
      )

const oversize = (
  operation: Operation,
  address: Address,
  maximumBytes: number,
  actualBytes: bigint,
): StorageError =>
  new StorageError({
    operation,
    namespace: address.namespace,
    key: address.key,
    message: `Storage record ${address.namespace}/${address.key} has ${actualBytes.toString()} bytes, exceeding ${maximumBytes}`,
    reason: { _tag: 'Oversize', maximumBytes, actualBytes },
  })

const external = (operation: Operation, address: Address, cause: unknown): StorageError =>
  new StorageError({
    operation,
    namespace: address.namespace,
    key: address.key,
    message: `${operation === 'Storage.read' ? 'Reading' : 'Publishing'} storage record ${address.namespace}/${address.key} failed`,
    reason:
      operation === 'Storage.read'
        ? { _tag: 'ReadFailure', cause }
        : { _tag: 'PublishFailure', cause },
  })

/** Reads one complete opaque record within the caller's allocation bound. */
export const read = Effect.fn('Storage.read')(function* (
  namespace: string,
  key: string,
  maximumBytes: number,
): Effect.fn.Return<Option.Option<Uint8Array>, StorageError, Storage> {
  const address = yield* validateAddress('Storage.read', namespace, key)
  const limit = yield* validateLimit('Storage.read', namespace, key, maximumBytes)
  const storage = yield* Storage
  return yield* storage.read(address, limit)
})

/** Atomically publishes one complete opaque record within the caller's size bound. */
export const publish = Effect.fn('Storage.publish')(function* (
  namespace: string,
  key: string,
  bytes: Uint8Array,
  maximumBytes: number,
): Effect.fn.Return<void, StorageError, Storage> {
  const address = yield* validateAddress('Storage.publish', namespace, key)
  const limit = yield* validateLimit('Storage.publish', namespace, key, maximumBytes)
  if (bytes.length > limit)
    return yield* oversize('Storage.publish', address, limit, BigInt(bytes.length))
  const storage = yield* Storage
  return yield* storage.publish(address, bytes, limit)
})

const storageKey = (address: Address): string => `${address.namespace}\u0000${address.key}`

/** Constructs an isolated in-memory service value for explicit dependency injection. */
export const memoryService = (): Service => {
  const records = new Map<string, Uint8Array>()
  return Storage.of({
    read: Effect.fn('Storage.memory.read')(function* (address, maximumBytes) {
      const bytes = records.get(storageKey(address))
      if (bytes === undefined) return Option.none()
      if (bytes.length > maximumBytes)
        return yield* oversize('Storage.read', address, maximumBytes, BigInt(bytes.length))
      return Option.some(Uint8Array.from(bytes))
    }),
    publish: Effect.fn('Storage.memory.publish')(function* (address, bytes, maximumBytes) {
      if (bytes.length > maximumBytes)
        return yield* oversize('Storage.publish', address, maximumBytes, BigInt(bytes.length))
      records.set(storageKey(address), Uint8Array.from(bytes))
    }),
  })
}

/** Provides a fresh isolated in-memory Storage service. */
export const memory: Layer.Layer<Storage> = Layer.sync(Storage, memoryService)

/** Constructs one rooted atomic-filesystem service using the current platform capabilities. */
export const fileSystemService = Effect.fn('Storage.fileSystemService')(function* (
  configuredRoot: string,
): Effect.fn.Return<Service, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(configuredRoot)
  const recordPath = (address: Address): string => path.join(root, address.namespace, address.key)
  const namespacePath = (address: Address): string => path.join(root, address.namespace)
  return Storage.of({
    read: Effect.fn('Storage.fileSystem.read')(function* (address, maximumBytes) {
      const file = recordPath(address)
      const info = yield* fileSystem.stat(file).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            cause.reason._tag === 'NotFound'
              ? Effect.succeedNone
              : Effect.fail(external('Storage.read', address, cause)),
          onSuccess: Effect.succeedSome,
        }),
      )
      if (Option.isNone(info)) return Option.none()
      if (info.value.size > BigInt(maximumBytes))
        return yield* oversize('Storage.read', address, maximumBytes, info.value.size)
      const bytes = yield* fileSystem
        .readFile(file)
        .pipe(Effect.mapError((cause) => external('Storage.read', address, cause)))
      if (bytes.length > maximumBytes)
        return yield* oversize('Storage.read', address, maximumBytes, BigInt(bytes.length))
      return Option.some(bytes)
    }),
    publish: Effect.fn('Storage.fileSystem.publish')(function* (address, bytes, maximumBytes) {
      if (bytes.length > maximumBytes)
        return yield* oversize('Storage.publish', address, maximumBytes, BigInt(bytes.length))
      const directory = namespacePath(address)
      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError((cause) => external('Storage.publish', address, cause)))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* Effect.acquireRelease(
            fileSystem
              .makeTempFile({ directory, prefix: `.${address.key}-`, suffix: '.tmp' })
              .pipe(Effect.mapError((cause) => external('Storage.publish', address, cause))),
            (temporary) =>
              fileSystem
                .remove(path.dirname(temporary), { recursive: true, force: true })
                .pipe(Effect.ignore),
          )
          yield* fileSystem
            .writeFile(temporary, bytes)
            .pipe(Effect.mapError((cause) => external('Storage.publish', address, cause)))
          yield* fileSystem
            .rename(temporary, recordPath(address))
            .pipe(Effect.mapError((cause) => external('Storage.publish', address, cause)))
        }),
      )
    }),
  })
})

/** Provides one rooted atomic-filesystem Storage service. */
export const fileSystem = (
  root: string,
): Layer.Layer<Storage, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Storage, fileSystemService(root))
