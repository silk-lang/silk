import type * as Elaboration from './Elaboration.js'
import type * as Ownership from './Ownership.js'

/** One module-owned immutable semantic artifact suitable for adjacent-revision sharing. */
export interface ModuleSemantics {
  readonly _tag: 'ModuleSemantics'
  readonly module: string
  readonly elaboration: Elaboration.Result
  readonly ownership: Ownership.ModuleOwnership
}

/** Closes one module's elaboration and ownership facts into their reusable ownership boundary. */
export const make = (
  module: string,
  elaboration: Elaboration.Result,
  ownership: Ownership.ModuleOwnership,
): ModuleSemantics => ({ _tag: 'ModuleSemantics', module, elaboration, ownership })
