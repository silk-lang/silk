import type * as AddrSpace from '../AddrSpace.js'
import type * as Alignment from '../Alignment.js'
import type * as ByteString from '../ByteString.js'
import type * as PackedBody from './PackedBody.js'

export type Linkage =
  | 'external'
  | 'private'
  | 'internal'
  | 'available_externally'
  | 'linkonce'
  | 'weak'
  | 'common'
  | 'appending'
  | 'extern_weak'
  | 'linkonce_odr'
  | 'weak_odr'

export type Visibility = 'default' | 'hidden' | 'protected'
export type Preemption = 'dso_preemptable' | 'dso_local'
export type DllStorage = 'default' | 'dllimport' | 'dllexport'
export type ThreadLocalModel =
  | 'none'
  | 'generaldynamic'
  | 'localdynamic'
  | 'initialexec'
  | 'localexec'

export type UnnamedAddress = 'none' | 'local_unnamed_addr' | 'unnamed_addr'

export interface Common {
  readonly name: ByteString.ByteString
  readonly addressSpace: AddrSpace.AddrSpace
  readonly linkage: Linkage
  readonly visibility: Visibility
  readonly preemption: Preemption
  readonly dllStorage: DllStorage
  readonly unnamedAddress: UnnamedAddress
  readonly section: ByteString.ByteString
  readonly alignment: Alignment.Alignment
}

export interface GlobalDescription extends Common {
  readonly _tag: 'Global'
  readonly kind: 'Variable' | 'Alias' | 'Function'
  readonly actorIndex: number
  readonly replacement: number | undefined
  readonly deleted: boolean
}

export interface VariableDescription {
  readonly _tag: 'Variable'
  readonly global: number
  readonly valueType: number
  readonly initializer: number | undefined
  readonly constant: boolean
  readonly threadLocal: ThreadLocalModel
  readonly externallyInitialized: boolean
  readonly debugExpressions: ReadonlyArray<number>
}

export interface AliasDescription {
  readonly _tag: 'Alias'
  readonly global: number
  readonly valueType: number
  readonly aliasee: number
}

export interface FunctionDescription {
  readonly _tag: 'Function'
  readonly global: number
  readonly type: number
  readonly callingConvention: number
  readonly attributes: number | undefined
  readonly garbageCollector: ByteString.ByteString
  readonly prefix: number | undefined
  readonly prologue: number | undefined
  readonly personality: number | undefined
  readonly addressSpace: AddrSpace.AddrSpace
  readonly body: PackedBody.PackedBody | undefined
}
