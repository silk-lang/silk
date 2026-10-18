export interface Owner {
  readonly token: symbol
}

export interface OwnedHandle {
  readonly owner: Owner
  readonly index: number
}

/** @internal */
export const makeOwner = (): Owner => ({ token: Symbol('llvm-builder-owner') })
