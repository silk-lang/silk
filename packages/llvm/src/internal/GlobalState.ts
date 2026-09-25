import * as Result from 'effect/Result'
import * as AddrSpace from '../AddrSpace.js'
import * as Alignment from '../Alignment.js'
import * as ByteString from '../ByteString.js'
import type * as Global from '../Global.js'
import { invalidInput, invalidState, type LlvmError } from '../LlvmError.js'
import type * as BuilderState from './BuilderState.js'
import * as CanonicalKey from './CanonicalKey.js'
import type * as GlobalDescription from './GlobalDescription.js'
import * as Handle from './Handle.js'
import type * as OwnedHandle from './OwnedHandle.js'

export interface CommonOptions {
  readonly addressSpace?: AddrSpace.AddrSpace
  readonly linkage?: GlobalDescription.Linkage
  readonly visibility?: GlobalDescription.Visibility
  readonly preemption?: GlobalDescription.Preemption
  readonly dllStorage?: GlobalDescription.DllStorage
  readonly unnamedAddress?: GlobalDescription.UnnamedAddress
  readonly section?: ByteString.ByteString
  readonly alignment?: Alignment.Alignment
}

/** @internal */
const defaults = (
  name: ByteString.ByteString,
  options: CommonOptions,
): GlobalDescription.Common => ({
  name,
  addressSpace: options.addressSpace ?? AddrSpace.defaultAddrSpace,
  linkage: options.linkage ?? 'external',
  visibility: options.visibility ?? 'default',
  preemption: options.preemption ?? 'dso_preemptable',
  dllStorage: options.dllStorage ?? 'default',
  unnamedAddress: options.unnamedAddress ?? 'none',
  section: options.section ?? ByteString.empty,
  alignment: options.alignment ?? Alignment.defaultAlignment,
})

/** @internal */
const availableAnonymousName = (state: BuilderState.MutableState): ByteString.ByteString => {
  while (true) {
    const name: ByteString.ByteString = {
      _tag: 'ByteString',
      bytes: Array.from(String(state.globals.nextAnonymous), (character) =>
        character.charCodeAt(0),
      ),
    }
    state.globals.nextAnonymous += 1
    if (!state.globals.entries.keys.has(CanonicalKey.bytes(name))) return name
  }
}

/** @internal */
export const allocate = (
  state: BuilderState.MutableState,
  owner: OwnedHandle.Owner,
  name: ByteString.ByteString,
  kind: GlobalDescription.GlobalDescription['kind'],
  actorIndex: number,
  options: CommonOptions,
  operation: string,
): Result.Result<{ readonly index: number; readonly handle: Global.Global }, LlvmError> => {
  const resolvedName = name.bytes.length === 0 ? availableAnonymousName(state) : name
  const key = CanonicalKey.bytes(resolvedName)
  const occupied = state.globals.entries.keys.get(key)
  if (occupied !== undefined) {
    return Result.fail(
      invalidState({
        operation,
        message: 'LLVM global name is already occupied',
        state: { name: resolvedName, occupied },
      }),
    )
  }
  const index = state.globals.entries.descriptions.length
  const handle = Handle.make('Global', owner, index)
  state.globals.entries.descriptions.push({
    _tag: 'Global',
    ...defaults(resolvedName, options),
    kind,
    actorIndex,
    replacement: undefined,
    deleted: false,
  })
  state.globals.entries.handles.push(handle)
  state.globals.attachments.push([])
  state.globals.entries.keys.set(key, index)
  return Result.succeed({ index, handle })
}

/** @internal */
export const resolveIndex = (
  state: BuilderState.MutableState,
  index: number,
  operation: string,
): Result.Result<number, LlvmError> => {
  let visited: globalThis.Set<number> | undefined
  let current = index
  while (true) {
    const description = state.globals.entries.descriptions[current]
    if (description === undefined) {
      return Result.fail(
        invalidState({ operation, message: 'Global table entry is missing', state: current }),
      )
    }
    if (description.replacement === undefined) return Result.succeed(current)
    visited ??= new globalThis.Set<number>()
    if (visited.has(current)) {
      return Result.fail(
        invalidInput({ operation, message: 'Global replacement cycle detected', input: index }),
      )
    }
    visited.add(current)
    current = description.replacement
  }
}

/** @internal */
export const resolve = (
  builder: import('../Builder.js').Builder,
  state: BuilderState.MutableState,
  owner: OwnedHandle.Owner,
  self: Global.Global,
  operation: string,
): Result.Result<
  { readonly index: number; readonly description: GlobalDescription.GlobalDescription },
  LlvmError
> => {
  const original = Handle.resolve(builder, owner, self, 'Global', operation)
  if (Result.isFailure(original)) return Result.fail(original.failure)
  const index = resolveIndex(state, original.success, operation)
  if (Result.isFailure(index)) return Result.fail(index.failure)
  const description = state.globals.entries.descriptions[index.success]
  if (description === undefined || description.deleted) {
    return Result.fail(invalidInput({ operation, message: 'Global has been deleted', input: self }))
  }
  return Result.succeed({ index: index.success, description })
}

/** @internal */
export const handleAt = (
  state: Pick<BuilderState.MutableState, 'globals'>,
  index: number,
  operation: string,
): Result.Result<Global.Global, LlvmError> => {
  const handle = state.globals.entries.handles[index]
  if (handle === undefined) {
    return Result.fail(
      invalidState({ operation, message: 'Global table handle is missing', state: index }),
    )
  }
  return Result.succeed(handle)
}
