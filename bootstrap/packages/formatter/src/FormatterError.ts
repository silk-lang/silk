import type * as Diagnostic from '@silklang/compiler/Diagnostic'
import type * as CodeFence from '@silklang/docgen/CodeFence'
import * as Data from 'effect/Data'

export type SourceRange = CodeFence.CodeFence['source']

export type Reason =
  | {
      readonly _tag: 'OuterSyntax'
      readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
    }
  | {
      readonly _tag: 'EmbeddedSyntax'
      readonly fence: SourceRange
      readonly nestedPath: ReadonlyArray<SourceRange>
      readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
    }
  | {
      readonly _tag: 'MalformedActiveFence'
      readonly fence: SourceRange
      readonly nestedPath: ReadonlyArray<SourceRange>
    }
  | {
      readonly _tag: 'DocumentationInfrastructure'
      readonly details: string
      readonly error?: CodeFence.CodeFenceError
    }

/** Expected refusal from canonical whole-source formatting. */
export class FormatterError extends Data.TaggedError('FormatterError')<{
  readonly operation: 'Formatter.format'
  readonly sourceId: string
  readonly message: string
  readonly reason: Reason
}> {}

/** Tests whether a failure is caused by user-authored source rather than formatter infrastructure. */
export const isSourceDamage = (self: FormatterError): boolean =>
  self.reason._tag !== 'DocumentationInfrastructure'
