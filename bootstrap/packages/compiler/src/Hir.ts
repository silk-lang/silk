import * as Effect from 'effect/Effect'
import * as AuthoredLowering from './AuthoredLowering.js'
import * as Lexer from './Lexer.js'
import * as Parser from './Parser.js'
import type * as SourceFile from './SourceFile.js'
import type * as SyntaxFile from './SyntaxFile.js'

/** Local source-to-HIR products, including the recovered syntax used by editor services. */
export interface Lowered {
  readonly _tag: 'HirLowering'
  readonly syntax: SyntaxFile.SyntaxFile
  readonly authored: AuthoredLowering.Lowered
}

/** Lowers one identified source revision without loading imports or running semantic analysis. */
export const lower = Effect.fn('Hir.lower')(function* (
  source: SourceFile.SourceFile,
): Effect.fn.Return<Lowered, AuthoredLowering.LoweringError> {
  yield* Effect.annotateCurrentSpan('module', source.id)
  const syntax = Parser.parse(Lexer.lex(source))
  const authored = yield* AuthoredLowering.lower(
    syntax,
    AuthoredLowering.moduleOwner(source.id, source.origin),
  )
  return { _tag: 'HirLowering', syntax, authored }
})
