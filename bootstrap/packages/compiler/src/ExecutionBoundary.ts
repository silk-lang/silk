import * as SuspensionMode from './SuspensionMode.js'

/** Static propagation facts published by one explicit Execution construction delimiter. */
export interface Delimiter {
  readonly _tag: 'ExecutionDelimiter'
  readonly body: SuspensionMode.Summary
  readonly owner: SuspensionMode.Summary
}

/** Retains the erased body's modes while stopping propagation into the owner-side drive caller. */
export const delimit = (body: SuspensionMode.Summary): Delimiter => ({
  _tag: 'ExecutionDelimiter',
  body,
  owner: SuspensionMode.direct,
})

export const encode = (self: Delimiter): string =>
  `ExecutionDelimiter<body=${SuspensionMode.encode(self.body)};owner=${SuspensionMode.encode(self.owner)}>`
