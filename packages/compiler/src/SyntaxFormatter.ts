import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as Diagnostic from './Diagnostic.js'
import * as FormattedDocument from './FormattedDocument.js'
import * as FormatDocument from './internal/FormatDocument.js'
import * as LiteralForm from './LiteralForm.js'
import * as Operator from './Operator.js'
import * as SourceFile from './SourceFile.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'
import type * as Token from './Token.js'

/** Expected refusal when source recovery prevents semantics-preserving formatting. */
export class SyntaxFormatterError extends Data.TaggedError('SyntaxFormatterError')<{
  readonly operation: 'SyntaxFormatter.format' | 'SyntaxFormatter.validate'
  readonly sourceId: string
  readonly message: string
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly reason: { readonly _tag: 'DamagedSyntax' }
}> {}

class SyntaxFormatterImplementationError extends Data.TaggedError(
  'SyntaxFormatterImplementationError',
)<{
  readonly message: string
}> {
  constructor(message: string) {
    super({ message })
  }
}

const isTrivia = (kind: Token.TokenKind): boolean =>
  kind === 'Whitespace' ||
  kind === 'LineComment' ||
  kind === 'DocComment' ||
  kind === 'ModuleDocComment'

interface Gap {
  readonly importSeparation?: 1 | 2
  readonly previous: Token.Token | undefined
  readonly trivia: ReadonlyArray<Token.Token>
}

interface Context {
  readonly syntax: SyntaxFile.SyntaxFile
  readonly gaps: ReadonlyMap<Token.Token, Gap>
}

const makeContext = (syntax: SyntaxFile.SyntaxFile): Context => {
  const gaps = new Map<Token.Token, Gap>()
  let previous: Token.Token | undefined
  let trivia: Array<Token.Token> = []
  for (const token of syntax.tokens) {
    if (isTrivia(token.kind)) {
      trivia.push(token)
      continue
    }
    gaps.set(token, { previous, trivia: trivia })
    previous = token
    trivia = []
  }
  const declarations = directNodes(syntax.root)
  for (const [index, declaration] of declarations.entries()) {
    const previousDeclaration = declarations[index - 1]
    if (
      previousDeclaration === undefined ||
      (declaration.kind !== 'ImportDeclaration' && previousDeclaration.kind !== 'ImportDeclaration')
    )
      continue
    const first = SyntaxTree.tokens(declaration).find((token) => !isTrivia(token.kind))
    const gap = first === undefined ? undefined : gaps.get(first)
    if (first === undefined || gap === undefined) continue
    gaps.set(first, {
      ...gap,
      importSeparation:
        declaration.kind === 'ImportDeclaration' && previousDeclaration.kind === 'ImportDeclaration'
          ? 1
          : 2,
    })
  }
  return { syntax, gaps }
}

const bytes = (context: Context, token: Token.Token): Uint8Array =>
  Option.getOrThrowWith(
    SourceFile.slice(context.syntax.source, token.span),
    () =>
      new SyntaxFormatterImplementationError(`Token span is outside ${context.syntax.source.id}`),
  )

const lineBreaks = (context: Context, tokens: ReadonlyArray<Token.Token>): number => {
  let count = 0
  for (const token of tokens) {
    if (token.kind !== 'Whitespace') continue
    const whitespace = bytes(context, token)
    for (let index = 0; index < whitespace.length; index += 1) {
      const byte = whitespace[index]
      if (byte === 0x0a) count += 1
      else if (byte === 0x0d) {
        count += 1
        if (whitespace[index + 1] === 0x0a) index += 1
      }
    }
  }
  return count
}

const gapOf = (context: Context, token: Token.Token): Gap =>
  context.gaps.get(token) ?? { previous: undefined, trivia: [] }

const commentCount = (gap: Gap): number =>
  gap.trivia.filter(
    (token) =>
      token.kind === 'LineComment' ||
      token.kind === 'DocComment' ||
      token.kind === 'ModuleDocComment',
  ).length

const hasComments = (context: Context, token: Token.Token): boolean =>
  commentCount(gapOf(context, token)) > 0

const commentLeading = (
  context: Context,
  token: Token.Token,
  prefix: FormatDocument.Document,
  preserveBlank: boolean,
): FormatDocument.Document => {
  const gap = gapOf(context, token)
  const comments = gap.trivia.filter(
    (trivia) =>
      trivia.kind === 'LineComment' ||
      trivia.kind === 'DocComment' ||
      trivia.kind === 'ModuleDocComment',
  )
  if (comments.length === 0) {
    return preserveBlank && lineBreaks(context, gap.trivia) >= 2
      ? FormatDocument.concat(prefix, FormatDocument.hardLine)
      : prefix
  }

  const compactImports = gap.importSeparation === 1
  let startsWithTrailingComment = false
  const documents: Array<FormatDocument.Document> = []
  let triviaStart = 0
  for (const [index, comment] of comments.entries()) {
    const triviaIndex = gap.trivia.indexOf(comment, triviaStart)
    const before = triviaIndex < 0 ? [] : gap.trivia.slice(triviaStart, triviaIndex)
    const breaks = lineBreaks(context, before)
    if (index === 0) {
      if (gap.previous !== undefined && breaks === 0) {
        startsWithTrailingComment = true
        documents.push(gap.previous.kind === 'Comma' ? prefix : FormatDocument.text(' '))
      } else {
        documents.push(prefix)
        if (preserveBlank && breaks >= 2) documents.push(FormatDocument.hardLine)
      }
    } else {
      if (index === 1 && startsWithTrailingComment && gap.importSeparation !== undefined) {
        documents.push(prefix)
      } else {
        documents.push(FormatDocument.hardLine)
        if (!compactImports && breaks >= 2) documents.push(FormatDocument.hardLine)
      }
    }
    documents.push(FormatDocument.text(bytes(context, comment)))
    triviaStart = triviaIndex < 0 ? gap.trivia.length : triviaIndex + 1
  }

  const after = gap.trivia.slice(triviaStart)
  if (comments.length === 1 && startsWithTrailingComment && gap.importSeparation !== undefined) {
    documents.push(prefix)
  } else {
    documents.push(FormatDocument.hardLine)
    if (!compactImports && lineBreaks(context, after) >= 2) documents.push(FormatDocument.hardLine)
  }
  return FormatDocument.concat(...documents)
}

const printToken = (
  context: Context,
  token: Token.Token,
  prefix: FormatDocument.Document = FormatDocument.empty,
  preserveBlank = false,
): FormatDocument.Document => {
  const spelling = bytes(context, token)
  const form =
    token.kind === 'TextLiteral' || token.kind === 'ByteStringLiteral'
      ? LiteralForm.recognize(spelling)
      : undefined
  return FormatDocument.concat(
    commentLeading(context, token, prefix, preserveBlank),
    form?.delimiterWidth === 3
      ? FormatDocument.verbatimMultiline(spelling)
      : FormatDocument.text(spelling),
  )
}

const directTokens = (node: SyntaxTree.Node): ReadonlyArray<Token.Token> =>
  node.children.filter(
    (element): element is Token.Token =>
      SyntaxTree.isToken(element) && !isTrivia(element.kind) && element.kind !== 'EndOfFile',
  )

const directNodes = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  node.children.filter(SyntaxTree.isNode)

const tokenOf = (node: SyntaxTree.Node, kind: Token.TokenKind, occurrence = 0): Token.Token => {
  let found = 0
  for (const token of directTokens(node)) {
    if (token.kind !== kind) continue
    if (found === occurrence) return token
    found += 1
  }
  throw new SyntaxFormatterImplementationError(`${node.kind} has no ${kind} token ${occurrence}`)
}

const nodeOf = (
  node: SyntaxTree.Node,
  kind: SyntaxTree.NodeKind,
  occurrence = 0,
): SyntaxTree.Node => {
  let found = 0
  for (const child of directNodes(node)) {
    if (child.kind !== kind) continue
    if (found === occurrence) return child
    found += 1
  }
  throw new SyntaxFormatterImplementationError(`${node.kind} has no ${kind} node ${occurrence}`)
}

const commaTokens = (node: SyntaxTree.Node): ReadonlyArray<Token.Token> =>
  directTokens(node).filter((token) => token.kind === 'Comma')

const beginsWithTrailingComment = (context: Context, node: SyntaxTree.Node): boolean => {
  const first = SyntaxTree.tokens(node).find(
    (token) => !isTrivia(token.kind) && token.kind !== 'EndOfFile',
  )
  if (first === undefined) return false
  const gap = gapOf(context, first)
  const commentIndex = gap.trivia.findIndex(
    (token) =>
      token.kind === 'LineComment' ||
      token.kind === 'DocComment' ||
      token.kind === 'ModuleDocComment',
  )
  return (
    gap.previous?.kind === 'Comma' &&
    commentIndex >= 0 &&
    lineBreaks(context, gap.trivia.slice(0, commentIndex)) === 0
  )
}

const trailingComma = (
  context: Context,
  token: Token.Token | undefined,
): FormatDocument.Document => {
  if (token === undefined) return FormatDocument.ifBreak(FormatDocument.text(','))
  return hasComments(context, token)
    ? printToken(context, token)
    : FormatDocument.ifBreak(FormatDocument.text(','))
}

const printDelimited = (
  context: Context,
  open: Token.Token,
  items: ReadonlyArray<SyntaxTree.Node>,
  commas: ReadonlyArray<Token.Token>,
  close: Token.Token,
  prefix: FormatDocument.Document,
  forceTrailingComma = false,
  terminal?: Token.Token,
): FormatDocument.Document => {
  const openDocument = printToken(context, open, prefix)
  if (items.length === 0 && terminal === undefined)
    return FormatDocument.concat(openDocument, printToken(context, close))

  const breakLine = FormatDocument.ifBreak(FormatDocument.hardLine)
  const itemDocuments = items.map((item, index) => {
    if (index === 0) return printNode(context, item, breakLine)
    const separator = commas.at(index - 1)
    const comma =
      separator === undefined ? FormatDocument.text(',') : printToken(context, separator)
    return printNode(
      context,
      item,
      FormatDocument.concat(
        comma,
        beginsWithTrailingComment(context, item)
          ? FormatDocument.text(' ')
          : FormatDocument.softLine,
      ),
    )
  })
  if (terminal !== undefined) {
    const separator = commas.at(items.length - 1)
    itemDocuments.push(
      printToken(
        context,
        terminal,
        items.length === 0
          ? breakLine
          : FormatDocument.concat(
              separator === undefined ? FormatDocument.text(',') : printToken(context, separator),
              FormatDocument.softLine,
            ),
      ),
    )
  }
  const originalTrailingComma = commas.at(items.length - 1)
  let trailing: FormatDocument.Document
  if (terminal !== undefined) trailing = FormatDocument.text('')
  else if (!forceTrailingComma) trailing = trailingComma(context, originalTrailingComma)
  else if (originalTrailingComma === undefined) trailing = FormatDocument.text(',')
  else trailing = printToken(context, originalTrailingComma)
  return FormatDocument.group(
    FormatDocument.concat(
      openDocument,
      FormatDocument.indent(FormatDocument.concat(...itemDocuments, trailing)),
      printToken(context, close, breakLine),
    ),
  )
}

const printTokenSequence = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
  separator: FormatDocument.Document,
  preserveBlank = false,
): FormatDocument.Document => {
  const tokens = directTokens(node)
  return FormatDocument.concat(
    ...tokens.map((token, index) =>
      printToken(context, token, index === 0 ? prefix : separator, index === 0 && preserveBlank),
    ),
  )
}

const printBlock = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const open = tokenOf(node, 'LeftBrace')
  const close = tokenOf(node, 'RightBrace')
  const statements = directNodes(node).filter(
    (statement) =>
      statement.kind !== 'ReturnStatement' ||
      directTokens(statement).some((token) => token.kind === 'ReturnKeyword'),
  )
  if (statements.length === 0) {
    return FormatDocument.concat(printToken(context, open, prefix), printToken(context, close))
  }
  return FormatDocument.concat(
    printToken(context, open, prefix),
    FormatDocument.indent(
      FormatDocument.concat(
        ...statements.map((statement) =>
          printNode(context, statement, FormatDocument.hardLine, true),
        ),
      ),
    ),
    printToken(context, close, FormatDocument.hardLine),
  )
}

const printStructDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const fields = directNodes(node).filter((child) => child.kind === 'StructField')
  const typeParameters = directNodes(node).find((child) => child.kind === 'TypeParameterList')
  const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
  const externKeyword = directTokens(node).find((token) => token.kind === 'ExternKeyword')
  const abi = directTokens(node).find((token) => token.kind === 'TextLiteral')
  const head = FormatDocument.concat(
    ...(publicKeyword === undefined
      ? []
      : [printToken(context, publicKeyword, prefix), FormatDocument.text(' ')]),
    ...(externKeyword === undefined
      ? []
      : [
          printToken(
            context,
            externKeyword,
            publicKeyword === undefined ? prefix : FormatDocument.empty,
          ),
          abi === undefined
            ? FormatDocument.empty
            : printToken(context, abi, FormatDocument.text(' ')),
          FormatDocument.text(' '),
        ]),
    printToken(
      context,
      tokenOf(node, 'StructKeyword'),
      publicKeyword === undefined && externKeyword === undefined ? prefix : FormatDocument.empty,
    ),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
    ...(typeParameters === undefined ? [] : [printNode(context, typeParameters)]),
  )
  const open = tokenOf(node, 'LeftBrace')
  const close = tokenOf(node, 'RightBrace')
  if (fields.length === 0) {
    return FormatDocument.concat(
      head,
      printToken(context, open, FormatDocument.text(' ')),
      printToken(context, close),
    )
  }
  return FormatDocument.concat(
    head,
    printToken(context, open, FormatDocument.text(' ')),
    FormatDocument.indent(
      FormatDocument.concat(
        ...fields.map((field) => printNode(context, field, FormatDocument.hardLine, true)),
      ),
    ),
    printToken(context, close, FormatDocument.hardLine),
  )
}

const printTupleDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
  const typeParameters = directNodes(node).find((child) => child.kind === 'TypeParameterList')
  const elements = directNodes(node).filter((child) => child.kind !== 'TypeParameterList')
  return FormatDocument.concat(
    ...(publicKeyword === undefined
      ? []
      : [printToken(context, publicKeyword, prefix), FormatDocument.text(' ')]),
    printToken(
      context,
      tokenOf(node, 'TupleKeyword'),
      publicKeyword === undefined ? prefix : FormatDocument.empty,
    ),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
    ...(typeParameters === undefined ? [] : [printNode(context, typeParameters)]),
    printDelimited(
      context,
      tokenOf(node, 'LeftParenthesis'),
      elements,
      commaTokens(node),
      tokenOf(node, 'RightParenthesis'),
      FormatDocument.empty,
    ),
  )
}

const printEnumDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const members = directNodes(node).filter((child) => child.kind === 'EnumMember')
  const representation = directNodes(node).find((child) => child.kind !== 'EnumMember')
  const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
  const head = FormatDocument.concat(
    ...(publicKeyword === undefined
      ? []
      : [printToken(context, publicKeyword, prefix), FormatDocument.text(' ')]),
    printToken(
      context,
      tokenOf(node, 'EnumKeyword'),
      publicKeyword === undefined ? prefix : FormatDocument.empty,
    ),
    ...(representation === undefined
      ? []
      : [
          printToken(context, tokenOf(node, 'LeftParenthesis')),
          printNode(context, representation),
          printToken(context, tokenOf(node, 'RightParenthesis')),
        ]),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
  )
  const open = tokenOf(node, 'LeftBrace')
  const close = tokenOf(node, 'RightBrace')
  if (members.length === 0) {
    return FormatDocument.concat(
      head,
      printToken(context, open, FormatDocument.text(' ')),
      printToken(context, close),
    )
  }
  const commas = commaTokens(node)
  return FormatDocument.concat(
    head,
    printToken(context, open, FormatDocument.text(' ')),
    FormatDocument.indent(
      FormatDocument.concat(
        ...members.flatMap((member, index) => {
          const comma = commas.at(index)
          return [
            printNode(context, member, FormatDocument.hardLine, true),
            comma === undefined ? FormatDocument.text(',') : printToken(context, comma),
          ]
        }),
      ),
    ),
    printToken(context, close, FormatDocument.hardLine),
  )
}

const printUnionVariant = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const fields = directNodes(node).filter((child) => child.kind === 'UnionVariantField')
  const name = printToken(context, tokenOf(node, 'Identifier'), prefix, true)
  const open = directTokens(node).find((token) => token.kind === 'LeftBrace')
  if (open === undefined) return name
  return FormatDocument.concat(
    name,
    printDelimited(
      context,
      open,
      fields,
      commaTokens(node),
      tokenOf(node, 'RightBrace'),
      FormatDocument.text(' '),
    ),
  )
}

const printUnionDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const variants = directNodes(node).filter((child) => child.kind === 'UnionVariant')
  const typeParameters = directNodes(node).find((child) => child.kind === 'TypeParameterList')
  const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
  const head = FormatDocument.concat(
    ...(publicKeyword === undefined
      ? []
      : [printToken(context, publicKeyword, prefix), FormatDocument.text(' ')]),
    printToken(
      context,
      tokenOf(node, 'UnionKeyword'),
      publicKeyword === undefined ? prefix : FormatDocument.empty,
    ),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
    ...(typeParameters === undefined ? [] : [printNode(context, typeParameters)]),
  )
  const open = tokenOf(node, 'LeftBrace')
  const close = tokenOf(node, 'RightBrace')
  if (variants.length === 0) {
    return FormatDocument.concat(
      head,
      printToken(context, open, FormatDocument.text(' ')),
      printToken(context, close),
    )
  }
  const commas = commaTokens(node)
  return FormatDocument.concat(
    head,
    printToken(context, open, FormatDocument.text(' ')),
    FormatDocument.indent(
      FormatDocument.concat(
        ...variants.flatMap((variant, index) => {
          const comma = commas.at(index)
          return [
            printUnionVariant(context, variant, FormatDocument.hardLine),
            comma === undefined ? FormatDocument.text(',') : printToken(context, comma),
          ]
        }),
      ),
    ),
    printToken(context, close, FormatDocument.hardLine),
  )
}

const printServiceOperation = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const operatorMarker = directNodes(node).find((child) => child.kind === 'OperatorMarker')
  const operatorKeyword =
    operatorMarker === undefined ? undefined : tokenOf(operatorMarker, 'Identifier')
  const operatorToken =
    operatorMarker === undefined
      ? undefined
      : directTokens(operatorMarker).find((token) => Operator.isDeclarationToken(token.kind))
  const effectKeyword = directTokens(node).find((token) => token.kind === 'EffectKeyword')
  const effectEnvironment = directNodes(node).find((child) => child.kind === 'EffectEnvironment')
  const unsafeKeyword = directTokens(node).find((token) => token.kind === 'UnsafeKeyword')
  const typeParameters = directNodes(node).find((child) => child.kind === 'TypeParameterList')
  const failureRow = directNodes(node).find((child) => child.kind === 'FailureRow')
  const requirementRow = directNodes(node).find((child) => child.kind === 'RequirementRow')
  const whereClause = directNodes(node).find((child) => child.kind === 'WhereClause')
  const properties = directNodes(node).filter((child) => child.kind === 'FunctionPropertyClause')
  const body = directNodes(node).find((child) => child.kind === 'Block')
  return FormatDocument.concat(
    ...(operatorKeyword === undefined || operatorToken === undefined
      ? []
      : [
          printToken(context, operatorKeyword, prefix),
          printToken(context, operatorToken, FormatDocument.text(' ')),
          FormatDocument.text(' '),
        ]),
    ...(unsafeKeyword === undefined
      ? []
      : [
          printToken(
            context,
            unsafeKeyword,
            operatorKeyword === undefined ? prefix : FormatDocument.empty,
          ),
          FormatDocument.text(' '),
        ]),
    ...(effectKeyword === undefined
      ? []
      : [
          printToken(
            context,
            effectKeyword,
            operatorKeyword === undefined && unsafeKeyword === undefined
              ? prefix
              : FormatDocument.empty,
          ),
          ...(effectEnvironment === undefined ? [] : [printNode(context, effectEnvironment)]),
          FormatDocument.text(' '),
        ]),
    printToken(
      context,
      tokenOf(node, 'FnKeyword'),
      effectKeyword === undefined && unsafeKeyword === undefined && operatorKeyword === undefined
        ? prefix
        : FormatDocument.empty,
    ),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
    ...(typeParameters === undefined ? [] : [printNode(context, typeParameters)]),
    printNode(context, nodeOf(node, 'ParameterList')),
    ...(directNodes(node).find((child) => child.kind === 'ReturnType') === undefined
      ? []
      : [printNode(context, nodeOf(node, 'ReturnType'), FormatDocument.text(' '))]),
    ...(failureRow === undefined ? [] : [printNode(context, failureRow, FormatDocument.text(' '))]),
    ...(requirementRow === undefined
      ? []
      : [printNode(context, requirementRow, FormatDocument.text(' '))]),
    ...(whereClause === undefined
      ? []
      : [printNode(context, whereClause, FormatDocument.text(' '))]),
    ...properties.map((property) => printNode(context, property, FormatDocument.text(' '))),
    ...(body === undefined ? [] : [printNode(context, body, FormatDocument.text(' '))]),
  )
}

const printServiceDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
  const typeParameters = directNodes(node).find((child) => child.kind === 'TypeParameterList')
  const operations = directNodes(node).filter((child) => child.kind === 'ServiceOperation')
  const head = FormatDocument.concat(
    ...(publicKeyword === undefined
      ? []
      : [printToken(context, publicKeyword, prefix), FormatDocument.text(' ')]),
    printToken(
      context,
      tokenOf(node, node.kind === 'InterfaceDeclaration' ? 'InterfaceKeyword' : 'ServiceKeyword'),
      publicKeyword === undefined ? prefix : FormatDocument.empty,
    ),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
    ...(typeParameters === undefined ? [] : [printNode(context, typeParameters)]),
    printToken(context, tokenOf(node, 'LeftBrace'), FormatDocument.text(' ')),
  )
  if (operations.length === 0)
    return FormatDocument.concat(head, printToken(context, tokenOf(node, 'RightBrace')))
  return FormatDocument.concat(
    head,
    FormatDocument.indent(
      FormatDocument.concat(
        ...operations.map((operation) =>
          printServiceOperation(context, operation, FormatDocument.hardLine),
        ),
      ),
    ),
    printToken(context, tokenOf(node, 'RightBrace'), FormatDocument.hardLine),
  )
}

const printTypeAliasDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
  const typeParameters = directNodes(node).find((child) => child.kind === 'TypeParameterList')
  const target = directNodes(node).at(-1)
  return FormatDocument.concat(
    ...(publicKeyword === undefined
      ? []
      : [printToken(context, publicKeyword, prefix), FormatDocument.text(' ')]),
    printToken(
      context,
      tokenOf(node, 'TypeKeyword'),
      publicKeyword === undefined ? prefix : FormatDocument.empty,
    ),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
    ...(typeParameters === undefined ? [] : [printNode(context, typeParameters)]),
    printToken(context, tokenOf(node, 'Equals'), FormatDocument.text(' ')),
    ...(target === undefined || target === typeParameters
      ? []
      : [printNode(context, target, FormatDocument.text(' '))]),
  )
}

const printConstantDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
  const validation = directNodes(node).find((child) => child.kind === 'PackageParameterValidation')
  const value = directNodes(node)
    .filter((child) => child !== validation)
    .at(1)
  const equals = directTokens(node).find((token) => token.kind === 'Equals')
  const type = directNodes(node).at(0) ?? nodeOf(node, 'TypePath')
  return FormatDocument.concat(
    ...(publicKeyword === undefined
      ? []
      : [printToken(context, publicKeyword, prefix), FormatDocument.text(' ')]),
    printToken(
      context,
      tokenOf(node, node.kind === 'PackageParameterDeclaration' ? 'ParamKeyword' : 'ConstKeyword'),
      publicKeyword === undefined ? prefix : FormatDocument.empty,
    ),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
    printToken(context, tokenOf(node, 'Colon')),
    printNode(context, type, FormatDocument.text(' ')),
    ...(equals === undefined || value === undefined
      ? []
      : [
          printToken(context, equals, FormatDocument.text(' ')),
          printNode(context, value, FormatDocument.text(' ')),
        ]),
    ...(validation === undefined ? [] : [printNode(context, validation, FormatDocument.text(' '))]),
  )
}

const printForeignStaticDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const tokens = directTokens(node)
  const type = directNodes(node).at(0) ?? nodeOf(node, 'TypePath')
  const initializer = directNodes(node)
    .filter((child) => child.kind !== 'FunctionPropertyClause')
    .at(1)
  const asIndex = tokens.findIndex((token) => token.kind === 'AsKeyword')
  const equals = tokens.find((token) => token.kind === 'Equals')
  return FormatDocument.concat(
    ...tokens
      .slice(0, tokens.findIndex((token) => token.kind === 'StaticKeyword') + 1)
      .map((token, index) =>
        printToken(context, token, index === 0 ? prefix : FormatDocument.text(' ')),
      ),
    printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
    printToken(context, tokenOf(node, 'Colon')),
    printNode(context, type, FormatDocument.text(' ')),
    ...(asIndex < 0
      ? []
      : [
          printToken(
            context,
            tokens[asIndex] ?? tokenOf(node, 'AsKeyword'),
            FormatDocument.text(' '),
          ),
          printToken(
            context,
            tokens[asIndex + 1] ?? tokenOf(node, 'TextLiteral'),
            FormatDocument.text(' '),
          ),
        ]),
    ...directNodes(node)
      .filter((child) => child.kind === 'FunctionPropertyClause')
      .map((clause) => printNode(context, clause, FormatDocument.text(' '))),
    ...(equals === undefined || initializer === undefined
      ? []
      : [
          printToken(context, equals, FormatDocument.text(' ')),
          printNode(context, initializer, FormatDocument.text(' ')),
        ]),
  )
}

const printFunctionDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const tokens = directTokens(node)
  const nodes = directNodes(node)
  // Every modifier through `fn`: `[pub] [test] [static] [unsafe] [extern | export "C"] [effect] fn`.
  const head = tokens.slice(0, tokens.findIndex((token) => token.kind === 'FnKeyword') + 1)
  const fnIndex = tokens.findIndex((token) => token.kind === 'FnKeyword')
  const name = tokens
    .slice(fnIndex + 1)
    .find((token) => token.kind === 'Identifier' || token.kind === 'DropKeyword')
  if (name === undefined)
    throw new SyntaxFormatterImplementationError('FunctionDeclaration has no function name')
  const asIndex = tokens.findIndex((token) => token.kind === 'AsKeyword')
  const asKeyword = tokens.at(asIndex)
  const symbol = asIndex < 0 ? undefined : tokens.at(asIndex + 1)
  const returnType = nodes.find((child) => child.kind === 'ReturnType')
  const typeParameters = nodes.find((child) => child.kind === 'TypeParameterList')
  const failureRow = nodes.find((child) => child.kind === 'FailureRow')
  const requirementRow = nodes.find((child) => child.kind === 'RequirementRow')
  const whereClause = nodes.find((child) => child.kind === 'WhereClause')
  const body = nodes.find((child) => child.kind === 'Block')
  const properties = nodes.filter((child) => child.kind === 'FunctionPropertyClause')
  return FormatDocument.concat(
    ...head.flatMap((token, index) => [
      printToken(context, token, index === 0 ? prefix : FormatDocument.text(' ')),
      ...(token.kind === 'EffectKeyword'
        ? nodes
            .filter((child) => child.kind === 'EffectEnvironment')
            .map((child) => printNode(context, child))
        : []),
    ]),
    printToken(context, name, FormatDocument.text(' ')),
    ...(typeParameters === undefined ? [] : [printNode(context, typeParameters)]),
    printNode(context, nodeOf(node, 'ParameterList')),
    ...(returnType === undefined ? [] : [printNode(context, returnType, FormatDocument.text(' '))]),
    FormatDocument.group(
      FormatDocument.concat(
        ...(failureRow === undefined
          ? []
          : [printNode(context, failureRow, FormatDocument.softLine)]),
        ...(requirementRow === undefined
          ? []
          : [printNode(context, requirementRow, FormatDocument.softLine)]),
        ...(whereClause === undefined
          ? []
          : [printNode(context, whereClause, FormatDocument.softLine)]),
      ),
    ),
    ...(asKeyword === undefined || symbol === undefined
      ? []
      : [
          printToken(context, asKeyword, FormatDocument.text(' ')),
          printToken(context, symbol, FormatDocument.text(' ')),
        ]),
    ...properties.map((property) => printNode(context, property, FormatDocument.text(' '))),
    ...(body === undefined ? [] : [printNode(context, body, FormatDocument.text(' '))]),
  )
}

const printAnonymousCallableExpression = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const effectKeyword = directTokens(node).find((token) => token.kind === 'EffectKeyword')
  const failureRow = directNodes(node).find((child) => child.kind === 'FailureRow')
  const requirementRow = directNodes(node).find((child) => child.kind === 'RequirementRow')
  return FormatDocument.concat(
    ...(effectKeyword === undefined
      ? []
      : [printToken(context, effectKeyword, prefix), FormatDocument.text(' ')]),
    printToken(
      context,
      tokenOf(node, 'FnKeyword'),
      effectKeyword === undefined ? prefix : FormatDocument.empty,
    ),
    printNode(context, nodeOf(node, 'ParameterList')),
    printNode(context, nodeOf(node, 'ReturnType'), FormatDocument.text(' ')),
    FormatDocument.group(
      FormatDocument.concat(
        ...(failureRow === undefined
          ? []
          : [printNode(context, failureRow, FormatDocument.softLine)]),
        ...(requirementRow === undefined
          ? []
          : [printNode(context, requirementRow, FormatDocument.softLine)]),
      ),
    ),
    printNode(context, nodeOf(node, 'Block'), FormatDocument.text(' ')),
  )
}

const printImplDeclaration = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const nodes = directNodes(node)
  const typeParameters = nodes[0]?.kind === 'TypeParameterList' ? nodes[0] : undefined
  const positional = typeParameters === undefined ? nodes : nodes.slice(1)
  // An inherent impl has one type node before its members; a conformance has two around `for`.
  const forKeyword = directTokens(node).find((token) => token.kind === 'ForKeyword')
  const capability = positional[0] ?? nodeOf(node, 'TypePath')
  const target =
    forKeyword === undefined
      ? undefined
      : { keyword: forKeyword, node: positional[1] ?? nodeOf(node, 'TypePath', 1) }
  const members = positional.slice(target === undefined ? 1 : 2)
  const open = tokenOf(node, 'LeftBrace')
  const close = tokenOf(node, 'RightBrace')
  const head = FormatDocument.concat(
    printToken(context, tokenOf(node, 'ImplKeyword'), prefix),
    ...(typeParameters === undefined ? [] : [printNode(context, typeParameters)]),
    printNode(context, capability, FormatDocument.text(' ')),
    ...(target === undefined
      ? []
      : [
          printToken(context, target.keyword, FormatDocument.text(' ')),
          printNode(context, target.node, FormatDocument.text(' ')),
        ]),
    printToken(context, open, FormatDocument.text(' ')),
  )
  if (members.length === 0) return FormatDocument.concat(head, printToken(context, close))
  return FormatDocument.concat(
    head,
    FormatDocument.indent(
      FormatDocument.concat(
        ...members.map((member) => printNode(context, member, FormatDocument.hardLine, true)),
      ),
    ),
    printToken(context, close, FormatDocument.hardLine),
  )
}

const printSourceFile = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document,
): FormatDocument.Document => {
  const declarations = directNodes(node)
  const declarationDocuments = declarations.map((declaration, index) => {
    const separation =
      declaration.kind === 'ImportDeclaration' &&
      declarations[index - 1]?.kind === 'ImportDeclaration'
        ? FormatDocument.hardLine
        : FormatDocument.concat(FormatDocument.hardLine, FormatDocument.hardLine)
    return printNode(context, declaration, index === 0 ? prefix : separation)
  })
  const endOfFile = node.children.find(
    (element): element is Token.Token =>
      SyntaxTree.isToken(element) && element.kind === 'EndOfFile',
  )
  return FormatDocument.concat(
    ...declarationDocuments,
    ...(endOfFile === undefined ? [] : [printToken(context, endOfFile, FormatDocument.hardLine)]),
  )
}

const printNode = (
  context: Context,
  node: SyntaxTree.Node,
  prefix: FormatDocument.Document = FormatDocument.empty,
  preserveBlank = false,
): FormatDocument.Document => {
  switch (node.kind) {
    case 'SourceFile':
      return printSourceFile(context, node, prefix)
    case 'ImportDeclaration': {
      const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
      const keyword = tokenOf(node, 'ImportKeyword')
      const path = nodeOf(node, 'ImportPath')
      const alias = directNodes(node).find((child) => child.kind === 'ImportAlias')
      const members = directNodes(node).find((child) => child.kind === 'ImportMemberList')
      return FormatDocument.concat(
        ...(publicKeyword === undefined
          ? []
          : [printToken(context, publicKeyword, prefix, preserveBlank)]),
        printToken(
          context,
          keyword,
          publicKeyword === undefined ? prefix : FormatDocument.text(' '),
          preserveBlank,
        ),
        printNode(context, path, FormatDocument.text(' ')),
        ...(alias === undefined ? [] : [printNode(context, alias, FormatDocument.text(' '))]),
        ...(members === undefined ? [] : [printNode(context, members, FormatDocument.text(' '))]),
      )
    }
    case 'ImportPath':
    case 'TypePath':
    case 'LifetimeType':
      return printTokenSequence(context, node, prefix, FormatDocument.empty, preserveBlank)
    case 'CallableEnvironment':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Less'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Lifetime')),
        printToken(context, tokenOf(node, 'Greater')),
      )
    case 'EffectEnvironment':
      return FormatDocument.concat(
        ...directTokens(node).map((token, index, tokens) => {
          let tokenPrefix = FormatDocument.empty
          if (index === 0) tokenPrefix = prefix
          else if (token.kind === 'Ampersand' || tokens.at(index - 1)?.kind === 'Ampersand')
            tokenPrefix = FormatDocument.text(' ')
          return printToken(context, token, tokenPrefix, index === 0 && preserveBlank)
        }),
      )
    case 'RequirementSelector': {
      const [capability, role] = directNodes(node)
      if (capability === undefined || role === undefined)
        return printTokenSequence(context, node, prefix, FormatDocument.empty, preserveBlank)
      return FormatDocument.concat(
        printNode(context, capability, prefix, preserveBlank),
        printNode(context, role, FormatDocument.text(' at ')),
      )
    }
    case 'TypeArgumentList': {
      const nodes = directNodes(node)
      const failure = nodes.find((child) => child.kind === 'FailureRow')
      const requirements = nodes.find((child) => child.kind === 'RequirementRow')
      const environment = nodes.find((child) => child.kind === 'EffectEnvironment')
      if (failure === undefined && requirements === undefined && environment === undefined)
        return printDelimited(
          context,
          tokenOf(node, 'Less'),
          nodes,
          commaTokens(node),
          tokenOf(node, 'Greater'),
          prefix,
        )
      const arguments_ = nodes.filter(
        (child) =>
          child.kind !== 'FailureRow' &&
          child.kind !== 'RequirementRow' &&
          child.kind !== 'EffectEnvironment',
      )
      const firstArgumentPrefix =
        environment === undefined ? FormatDocument.empty : FormatDocument.text(' ')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Less'), prefix, preserveBlank),
        ...(environment === undefined ? [] : [printNode(context, environment)]),
        ...arguments_.map((argument, ordinal) =>
          printNode(
            context,
            argument,
            ordinal === 0 ? firstArgumentPrefix : FormatDocument.text(', '),
          ),
        ),
        ...(failure === undefined ? [] : [printNode(context, failure, FormatDocument.text(' '))]),
        ...(requirements === undefined
          ? []
          : [printNode(context, requirements, FormatDocument.text(' '))]),
        printToken(context, tokenOf(node, 'Greater')),
      )
    }
    case 'TypeParameterList':
    case 'LifetimeBinderList':
    case 'CallTypeArgumentList':
      return printDelimited(
        context,
        tokenOf(node, 'Less'),
        directNodes(node),
        commaTokens(node),
        tokenOf(node, 'Greater'),
        prefix,
      )
    case 'TypeParameter':
    case 'LifetimeParameter': {
      const marker = directTokens(node).find(
        (token) => token.kind === 'Bang' || token.kind === 'Question',
      )
      const colon = directTokens(node).find((token) => token.kind === 'Colon')
      const bounds = directNodes(node)
      const pluses = directTokens(node).filter((token) => token.kind === 'Plus')
      return FormatDocument.concat(
        ...(marker === undefined ? [] : [printToken(context, marker, prefix, preserveBlank)]),
        printToken(
          context,
          tokenOf(node, node.kind === 'LifetimeParameter' ? 'Lifetime' : 'Identifier'),
          marker === undefined ? prefix : FormatDocument.empty,
          preserveBlank,
        ),
        ...(colon === undefined ? [] : [printToken(context, colon)]),
        ...bounds.flatMap((bound, ordinal) => {
          const plus = ordinal === 0 ? undefined : pluses.at(ordinal - 1)
          return [
            ...(plus === undefined ? [] : [printToken(context, plus, FormatDocument.text(' '))]),
            printNode(context, bound, FormatDocument.text(' '), preserveBlank),
          ]
        }),
      )
    }
    case 'AppliedType': {
      const nodes = directNodes(node)
      const mut = directTokens(node).find((token) => token.kind === 'MutKeyword')
      const once = directTokens(node).find((token) => token.kind === 'OnceKeyword')
      return FormatDocument.concat(
        ...(mut === undefined
          ? []
          : [printToken(context, mut, prefix, preserveBlank), FormatDocument.text(' ')]),
        ...(once === undefined
          ? []
          : [printToken(context, once, prefix, preserveBlank), FormatDocument.text(' ')]),
        printNode(
          context,
          nodes[0] ?? nodeOf(node, 'TypePath'),
          mut === undefined && once === undefined ? prefix : FormatDocument.empty,
          preserveBlank,
        ),
        printNode(context, nodes[1] ?? nodeOf(node, 'TypeArgumentList')),
      )
    }
    case 'ImportAlias':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'AsKeyword'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
      )
    case 'ImportMemberList':
      return printDelimited(
        context,
        tokenOf(node, 'LeftBrace'),
        directNodes(node),
        commaTokens(node),
        tokenOf(node, 'RightBrace'),
        prefix,
      )
    case 'ImportMember': {
      const alias = directNodes(node).find((child) => child.kind === 'ImportAlias')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank),
        ...(alias === undefined ? [] : [printNode(context, alias, FormatDocument.text(' '))]),
      )
    }
    case 'StructDeclaration':
      return printStructDeclaration(context, node, prefix)
    case 'TupleDeclaration':
      return printTupleDeclaration(context, node, prefix)
    case 'EnumDeclaration':
      return printEnumDeclaration(context, node, prefix)
    case 'UnionDeclaration':
      return printUnionDeclaration(context, node, prefix)
    case 'ServiceDeclaration':
    case 'InterfaceDeclaration':
      return printServiceDeclaration(context, node, prefix)
    case 'RoleDeclaration': {
      const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
      return FormatDocument.concat(
        ...(publicKeyword === undefined
          ? []
          : [printToken(context, publicKeyword, prefix, preserveBlank), FormatDocument.text(' ')]),
        printToken(
          context,
          tokenOf(node, 'RoleKeyword'),
          publicKeyword === undefined ? prefix : FormatDocument.empty,
          preserveBlank,
        ),
        printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
      )
    }
    case 'ServiceOperation':
      return printServiceOperation(context, node, prefix)
    case 'OperatorMarker':
      return printTokenSequence(context, node, prefix, FormatDocument.text(' '), preserveBlank)
    case 'ServiceInvalidMember':
      throw new SyntaxFormatterImplementationError(
        'Damaged service member reached the syntax printer',
      )
    case 'TypeAliasDeclaration':
      return printTypeAliasDeclaration(context, node, prefix)
    case 'PackageParameterDeclaration':
    case 'ConstantDeclaration':
      return printConstantDeclaration(context, node, prefix)
    case 'PackageParameterValidation':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix),
        ...directNodes(node).map((child) => printNode(context, child, FormatDocument.text(' '))),
      )
    case 'ForeignStaticDeclaration':
    case 'ExportStaticDeclaration':
      return printForeignStaticDeclaration(context, node, prefix)
    case 'ImplDeclaration':
      return printImplDeclaration(context, node, prefix)
    case 'ImplOperation':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Colon')),
        printNode(context, nodeOf(node, 'TypePath'), FormatDocument.text(' ')),
      )
    case 'StructField': {
      const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
      return FormatDocument.concat(
        ...(publicKeyword === undefined
          ? []
          : [printToken(context, publicKeyword, prefix, preserveBlank), FormatDocument.text(' ')]),
        printToken(
          context,
          tokenOf(node, 'Identifier'),
          publicKeyword === undefined ? prefix : FormatDocument.empty,
          preserveBlank,
        ),
        printToken(context, tokenOf(node, 'Colon')),
        printNode(
          context,
          directNodes(node).at(-1) ?? nodeOf(node, 'TypePath'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'UnionVariant':
      return printUnionVariant(context, node, prefix)
    case 'UnionVariantField': {
      const publicKeyword = directTokens(node).find((token) => token.kind === 'PubKeyword')
      return FormatDocument.concat(
        ...(publicKeyword === undefined
          ? []
          : [printToken(context, publicKeyword, prefix, preserveBlank), FormatDocument.text(' ')]),
        printToken(
          context,
          tokenOf(node, 'Identifier'),
          publicKeyword === undefined ? prefix : FormatDocument.empty,
          preserveBlank,
        ),
        printToken(context, tokenOf(node, 'Colon')),
        printNode(
          context,
          directNodes(node).at(-1) ?? nodeOf(node, 'TypePath'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'AppliedMemberSelector': {
      const parent = directNodes(node)[0] ?? nodeOf(node, 'AppliedType')
      return FormatDocument.concat(
        printNode(context, parent, prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Dot')),
        printToken(context, tokenOf(node, 'Identifier')),
      )
    }
    case 'AppliedMemberExpression': {
      const nodes = directNodes(node)
      const selector = nodes[0] ?? nodeOf(node, 'AppliedMemberSelector')
      const open = directTokens(node).find((token) => token.kind === 'LeftBrace')
      if (open === undefined) return printNode(context, selector, prefix, preserveBlank)
      return FormatDocument.concat(
        printNode(context, selector, prefix, preserveBlank),
        printDelimited(
          context,
          open,
          nodes.slice(1),
          commaTokens(node),
          tokenOf(node, 'RightBrace'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'UnionVariantPattern': {
      const nodes = directNodes(node)
      const selector = nodes[0] ?? nodeOf(node, 'AppliedMemberSelector')
      const open = directTokens(node).find((token) => token.kind === 'LeftBrace')
      if (open === undefined) return printNode(context, selector, prefix, preserveBlank)
      return FormatDocument.concat(
        printNode(context, selector, prefix, preserveBlank),
        printDelimited(
          context,
          open,
          nodes.slice(1),
          commaTokens(node),
          tokenOf(node, 'RightBrace'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'EnumMember': {
      const discriminant = directNodes(node).find(
        (child) => child.kind === 'IntegerLiteralExpression',
      )
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank),
        ...(discriminant === undefined
          ? []
          : [
              printToken(context, tokenOf(node, 'Equals'), FormatDocument.text(' ')),
              printNode(context, discriminant, FormatDocument.text(' ')),
            ]),
      )
    }
    case 'FixedArrayType':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'LeftBracket'), prefix, preserveBlank),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'TypePath')),
        printToken(context, tokenOf(node, 'Semicolon')),
        printToken(context, tokenOf(node, 'DecimalInteger'), FormatDocument.text(' ')),
        printToken(context, tokenOf(node, 'RightBracket')),
      )
    case 'SliceType': {
      const mut = directTokens(node).find((token) => token.kind === 'MutKeyword')
      const lifetime = directTokens(node).find((token) => token.kind === 'Lifetime')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Ampersand'), prefix, preserveBlank),
        ...(lifetime === undefined
          ? []
          : [printToken(context, lifetime), FormatDocument.text(' ')]),
        ...(mut === undefined ? [] : [printToken(context, mut), FormatDocument.text(' ')]),
        printToken(context, tokenOf(node, 'LeftBracket')),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'TypePath')),
        printToken(context, tokenOf(node, 'RightBracket')),
      )
    }
    case 'ReferenceType': {
      const mut = directTokens(node).find((token) => token.kind === 'MutKeyword')
      const lifetime = directTokens(node).find((token) => token.kind === 'Lifetime')
      const at = directTokens(node).find((token) => token.kind === 'At')
      const role = directTokens(node).find((token) => token.kind === 'Identifier')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Ampersand'), prefix, preserveBlank),
        ...(lifetime === undefined
          ? []
          : [printToken(context, lifetime), FormatDocument.text(' ')]),
        ...(mut === undefined ? [] : [printToken(context, mut), FormatDocument.text(' ')]),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'TypePath')),
        ...(at === undefined ? [] : [printToken(context, at)]),
        ...(role === undefined ? [] : [printToken(context, role)]),
      )
    }
    case 'PointerQualifier':
      return FormatDocument.concat(...directTokens(node).map((token) => printToken(context, token)))
    case 'PointerType': {
      const tokens = directTokens(node)
      const children = directNodes(node)
      return FormatDocument.concat(
        ...tokens.map((token, ordinal) =>
          ordinal === 0
            ? printToken(context, token, prefix, preserveBlank)
            : printToken(context, token),
        ),
        FormatDocument.text(' '),
        ...children
          .filter((child) => child.kind === 'PointerQualifier')
          .flatMap((child) => [printNode(context, child), FormatDocument.text(' ')]),
        printNode(
          context,
          children.find((child) => child.kind !== 'PointerQualifier') ?? nodeOf(node, 'TypePath'),
        ),
      )
    }
    case 'CallableType':
    case 'ForeignFunctionType': {
      const nodes = directNodes(node).filter(
        (child) =>
          child.kind !== 'LifetimeBinderList' &&
          child.kind !== 'CallableEnvironment' &&
          child.kind !== 'FunctionPropertyClause',
      )
      const environment = directNodes(node).find((child) => child.kind === 'CallableEnvironment')
      const binders = directNodes(node).filter((child) => child.kind === 'LifetimeBinderList')
      const forKeywords = directTokens(node).filter((token) => token.kind === 'ForKeyword')
      const callablePrefix = binders.length === 0 ? prefix : FormatDocument.empty
      const result = nodes.at(-1) ?? nodeOf(node, 'TypePath')
      const parameters = nodes.slice(0, -1)
      const mut = directTokens(node).find((token) => token.kind === 'MutKeyword')
      const once = directTokens(node).find((token) => token.kind === 'OnceKeyword')
      const unsafe = directTokens(node).find((token) => token.kind === 'UnsafeKeyword')
      const externKeyword = directTokens(node).find((token) => token.kind === 'ExternKeyword')
      const abi = directTokens(node).find((token) => token.kind === 'TextLiteral')
      return FormatDocument.concat(
        ...binders.flatMap((binder, ordinal) => {
          const keyword = forKeywords.at(ordinal)
          return [
            ...(keyword === undefined ? [] : [printToken(context, keyword, prefix, preserveBlank)]),
            printNode(context, binder),
            FormatDocument.text(' '),
          ]
        }),
        ...(externKeyword === undefined
          ? []
          : [
              printToken(context, externKeyword, prefix, preserveBlank),
              ...(abi === undefined ? [] : [printToken(context, abi, FormatDocument.text(' '))]),
              FormatDocument.text(' '),
            ]),
        ...(unsafe === undefined
          ? []
          : [printToken(context, unsafe, callablePrefix, preserveBlank), FormatDocument.text(' ')]),
        ...(mut === undefined
          ? []
          : [
              printToken(
                context,
                mut,
                unsafe === undefined ? callablePrefix : FormatDocument.empty,
                preserveBlank,
              ),
              FormatDocument.text(' '),
            ]),
        ...(once === undefined
          ? []
          : [
              printToken(
                context,
                once,
                unsafe === undefined ? callablePrefix : FormatDocument.empty,
                preserveBlank,
              ),
              FormatDocument.text(' '),
            ]),
        printToken(
          context,
          tokenOf(node, 'FnKeyword'),
          unsafe === undefined &&
            mut === undefined &&
            once === undefined &&
            externKeyword === undefined &&
            binders.length === 0
            ? prefix
            : FormatDocument.empty,
          preserveBlank,
        ),
        ...(environment === undefined ? [] : [printNode(context, environment)]),
        printDelimited(
          context,
          tokenOf(node, 'LeftParenthesis'),
          parameters,
          commaTokens(node),
          tokenOf(node, 'RightParenthesis'),
          FormatDocument.empty,
        ),
        printToken(context, tokenOf(node, 'Arrow'), FormatDocument.text(' ')),
        printNode(context, result, FormatDocument.text(' ')),
        ...directNodes(node)
          .filter((child) => child.kind === 'FunctionPropertyClause')
          .map((child) => printNode(context, child, FormatDocument.text(' '))),
      )
    }
    case 'OpaqueResultType': {
      const nodes = directNodes(node)
      const binders = nodes.at(0) ?? nodeOf(node, 'TypeParameterList')
      const result = nodes.at(-1) ?? nodeOf(node, 'TypePath')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank),
        printNode(context, binders),
        printNode(context, result, FormatDocument.text(' ')),
      )
    }
    case 'ExactRepresentationType':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'LeftParenthesis')),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'TypePath')),
        printToken(context, tokenOf(node, 'RightParenthesis')),
      )
    case 'UnitType':
      return printTokenSequence(context, node, prefix, FormatDocument.empty, preserveBlank)
    case 'ParenthesizedType':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'LeftParenthesis'), prefix, preserveBlank),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'TypePath')),
        printToken(context, tokenOf(node, 'RightParenthesis')),
      )
    case 'UnionType': {
      const members = directNodes(node)
      const separators = directTokens(node).filter((token) => token.kind === 'Pipe')
      const first = members.at(0)
      if (first === undefined)
        throw new SyntaxFormatterImplementationError('UnionType has no members')
      const documents: Array<FormatDocument.Document> = [
        printNode(context, first, prefix, preserveBlank),
      ]
      for (const [index, separator] of separators.entries()) {
        const member = members.at(index + 1)
        if (member === undefined)
          throw new SyntaxFormatterImplementationError('UnionType has no member after separator')
        documents.push(
          printToken(context, separator, FormatDocument.text(' ')),
          printNode(context, member, FormatDocument.text(' ')),
        )
      }
      return FormatDocument.concat(...documents)
    }
    case 'FunctionDeclaration':
    case 'ForeignFunctionDeclaration':
      return printFunctionDeclaration(context, node, prefix)
    case 'ParameterList':
      return printDelimited(
        context,
        tokenOf(node, 'LeftParenthesis'),
        directNodes(node),
        commaTokens(node),
        tokenOf(node, 'RightParenthesis'),
        prefix,
        false,
        directTokens(node).find((token) => token.kind === 'Ellipsis'),
      )
    case 'ModulePropertyDeclaration':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix),
        ...directNodes(node).map((clause) => printNode(context, clause, FormatDocument.text(' '))),
      )
    case 'FunctionPropertyClause': {
      const names = directTokens(node).filter((token) => token.kind === 'Identifier')
      return FormatDocument.concat(
        ...names.flatMap((token, index) =>
          index === 2
            ? [printToken(context, tokenOf(node, 'Dot')), printToken(context, token)]
            : [printToken(context, token, index === 0 ? prefix : FormatDocument.text(' '))],
        ),
        printDelimited(
          context,
          tokenOf(node, 'LeftParenthesis'),
          directNodes(node),
          commaTokens(node),
          tokenOf(node, 'RightParenthesis'),
          FormatDocument.empty,
        ),
      )
    }
    case 'FunctionProperty':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix),
        printToken(context, tokenOf(node, 'Colon')),
        ...directNodes(node).map((value) => printNode(context, value, FormatDocument.text(' '))),
      )
    case 'ParameterDeclaration': {
      const modifier = directTokens(node).find(
        (token) => token.kind === 'StaticKeyword' || token.kind === 'MutKeyword',
      )
      return FormatDocument.concat(
        ...(modifier === undefined
          ? [printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank)]
          : [
              printToken(context, modifier, prefix, preserveBlank),
              printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
            ]),
        printToken(context, tokenOf(node, 'Colon')),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'TypePath'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'ReturnType':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Arrow'), prefix, preserveBlank),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'TypePath'),
          FormatDocument.text(' '),
        ),
      )
    case 'FailureRow':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Bang'), prefix, preserveBlank),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'TypePath'),
          FormatDocument.text(' '),
        ),
      )
    case 'RequirementRow': {
      const members = directNodes(node)
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Question'), prefix, preserveBlank),
        ...members.map((member, ordinal) =>
          printNode(
            context,
            member,
            ordinal === 0 ? FormatDocument.text(' ') : FormatDocument.text(' | '),
          ),
        ),
      )
    }
    case 'Requirement': {
      const mut = directTokens(node).find((token) => token.kind === 'MutKeyword')
      const at = directTokens(node).find((token) => token.kind === 'Identifier')
      const nodes = directNodes(node)
      const capability = nodes.at(0) ?? nodeOf(node, 'TypePath')
      const role = at === undefined ? undefined : nodes.at(-1)
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Ampersand'), prefix, preserveBlank),
        ...(mut === undefined ? [] : [printToken(context, mut), FormatDocument.text(' ')]),
        printNode(context, capability),
        ...(at === undefined ? [] : [printToken(context, at, FormatDocument.text(' '))]),
        ...(role === undefined ? [] : [printNode(context, role, FormatDocument.text(' '))]),
      )
    }
    case 'RowWithout': {
      const operands = directNodes(node)
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Less')),
        printNode(context, operands[0] ?? nodeOf(node, 'TypePath')),
        printToken(context, tokenOf(node, 'Comma')),
        printNode(context, operands[1] ?? nodeOf(node, 'TypePath'), FormatDocument.text(' ')),
        printToken(context, tokenOf(node, 'Greater')),
      )
    }
    case 'WhereClause': {
      const constraints = directNodes(node)
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank),
        FormatDocument.group(
          FormatDocument.indent(
            FormatDocument.concat(
              ...constraints.map((constraint, ordinal) =>
                printNode(
                  context,
                  constraint,
                  ordinal === 0
                    ? FormatDocument.softLine
                    : FormatDocument.concat(FormatDocument.text(','), FormatDocument.softLine),
                ),
              ),
            ),
          ),
        ),
      )
    }
    case 'MembershipConstraint': {
      const operands = directNodes(node)
      return FormatDocument.concat(
        printNode(context, operands[0] ?? nodeOf(node, 'TypePath'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
        printNode(context, operands[1] ?? nodeOf(node, 'TypePath'), FormatDocument.text(' ')),
      )
    }
    case 'ProviderConstraint': {
      const operands = directNodes(node)
      const keywords = directTokens(node).filter((token) => token.kind === 'Identifier')
      return FormatDocument.concat(
        printNode(context, operands[0] ?? nodeOf(node, 'TypePath'), prefix, preserveBlank),
        ...(keywords[0] === undefined
          ? []
          : [printToken(context, keywords[0], FormatDocument.text(' '))]),
        printNode(context, operands[1] ?? nodeOf(node, 'TypePath'), FormatDocument.text(' ')),
        ...(keywords[1] === undefined
          ? []
          : [printToken(context, keywords[1], FormatDocument.text(' '))]),
        printNode(context, operands[2] ?? nodeOf(node, 'TypePath'), FormatDocument.text(' ')),
      )
    }
    case 'Block':
    case 'DeclarationGroup':
      return printBlock(context, node, prefix)
    case 'UnsafeStatement':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'UnsafeKeyword'), prefix, preserveBlank),
        printNode(context, nodeOf(node, 'Block'), FormatDocument.text(' ')),
      )
    case 'ExpressionStatement':
      return printNode(
        context,
        directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
        prefix,
        preserveBlank,
      )
    case 'BindingStatement': {
      const modifier = directTokens(node).find(
        (token) => token.kind === 'StaticKeyword' || token.kind === 'MutKeyword',
      )
      const nodes = directNodes(node)
      const annotated = directTokens(node).some((token) => token.kind === 'Colon')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'LetKeyword'), prefix, preserveBlank),
        ...(modifier === undefined
          ? []
          : [printToken(context, modifier, FormatDocument.text(' '))]),
        printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
        ...(annotated
          ? [
              printToken(context, tokenOf(node, 'Colon')),
              printNode(context, nodes.at(0) ?? nodeOf(node, 'TypePath'), FormatDocument.text(' ')),
            ]
          : []),
        printToken(context, tokenOf(node, 'Equals'), FormatDocument.text(' ')),
        printNode(
          context,
          nodes.at(-1) ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'PatternBindingStatement': {
      const nodes = directNodes(node)
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'LetKeyword'), prefix, preserveBlank),
        printNode(context, nodes[0] ?? nodeOf(node, 'UniversalPattern'), FormatDocument.text(' ')),
        printToken(context, tokenOf(node, 'Equals'), FormatDocument.text(' ')),
        printNode(
          context,
          nodes[1] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'AssignmentStatement': {
      const nodes = directNodes(node)
      return FormatDocument.concat(
        printNode(context, nodes[0] ?? nodeOf(node, 'IdentifierExpression'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Equals'), FormatDocument.text(' ')),
        printNode(
          context,
          nodes[1] ?? nodeOf(node, 'IdentifierExpression', 1),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'ConditionalStatement': {
      const nodes = directNodes(node)
      const elseKeyword = directTokens(node).find((token) => token.kind === 'ElseKeyword')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'IfKeyword'), prefix, preserveBlank),
        printNode(
          context,
          nodes[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
        printNode(context, nodes[1] ?? nodeOf(node, 'Block'), FormatDocument.text(' ')),
        ...(elseKeyword === undefined
          ? []
          : [
              printToken(context, elseKeyword, FormatDocument.text(' ')),
              printNode(context, nodes[2] ?? nodeOf(node, 'Block', 1), FormatDocument.text(' ')),
            ]),
      )
    }
    case 'StaticConditionalDeclaration':
    case 'StaticConditionalStatement': {
      const nodes = directNodes(node)
      const elseKeyword = directTokens(node).find((token) => token.kind === 'ElseKeyword')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'StaticKeyword'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'IfKeyword'), FormatDocument.text(' ')),
        printNode(
          context,
          nodes[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
        printNode(context, nodes[1] ?? nodeOf(node, 'Block'), FormatDocument.text(' ')),
        ...(elseKeyword === undefined
          ? []
          : [
              printToken(context, elseKeyword, FormatDocument.text(' ')),
              printNode(context, nodes[2] ?? nodeOf(node, 'Block', 1), FormatDocument.text(' ')),
            ]),
      )
    }
    case 'StaticForStatement': {
      const nodes = directNodes(node)
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'StaticKeyword'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'ForKeyword'), FormatDocument.text(' ')),
        printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
        printToken(context, tokenOf(node, 'Identifier', 1), FormatDocument.text(' ')),
        printNode(
          context,
          nodes[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
        printNode(context, nodes[1] ?? nodeOf(node, 'Block'), FormatDocument.text(' ')),
      )
    }
    case 'PatternConditionalStatement': {
      const nodes = directNodes(node)
      const elseKeyword = directTokens(node).find((token) => token.kind === 'ElseKeyword')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'IfKeyword'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'LetKeyword'), FormatDocument.text(' ')),
        printNode(context, nodes[0] ?? nodeOf(node, 'UniversalPattern'), FormatDocument.text(' ')),
        printToken(context, tokenOf(node, 'Equals'), FormatDocument.text(' ')),
        printNode(
          context,
          nodes[1] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
        printNode(context, nodes[2] ?? nodeOf(node, 'Block'), FormatDocument.text(' ')),
        ...(elseKeyword === undefined
          ? []
          : [
              printToken(context, elseKeyword, FormatDocument.text(' ')),
              printNode(context, nodes[3] ?? nodeOf(node, 'Block', 1), FormatDocument.text(' ')),
            ]),
      )
    }
    case 'WhileStatement': {
      const nodes = directNodes(node)
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'WhileKeyword'), prefix, preserveBlank),
        printNode(
          context,
          nodes[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
        printNode(context, nodes[1] ?? nodeOf(node, 'Block'), FormatDocument.text(' ')),
      )
    }
    case 'BreakStatement':
      return printToken(context, tokenOf(node, 'BreakKeyword'), prefix, preserveBlank)
    case 'ContinueStatement':
      return printToken(context, tokenOf(node, 'ContinueKeyword'), prefix, preserveBlank)
    case 'ReturnStatement':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'ReturnKeyword'), prefix, preserveBlank),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IntegerLiteralExpression'),
          FormatDocument.text(' '),
        ),
      )
    case 'FailStatement': {
      const move = directTokens(node).find((token) => token.kind === 'MoveKeyword')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'FailKeyword'), prefix, preserveBlank),
        ...(move === undefined ? [] : [printToken(context, move, FormatDocument.text(' '))]),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'DropStatement':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'DropKeyword'), prefix, preserveBlank),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
      )
    case 'UnitExpression':
    case 'IntegerLiteralExpression':
    case 'DurationLiteralExpression':
    case 'FloatingLiteralExpression':
    case 'StaticTextLiteralExpression':
    case 'CharacterLiteralExpression':
    case 'BooleanLiteralExpression':
    case 'IdentifierExpression':
      return printTokenSequence(context, node, prefix, FormatDocument.empty, preserveBlank)
    case 'MoveExpression':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'MoveKeyword'), prefix, preserveBlank),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
      )
    case 'AnonymousCallableExpression':
      return printAnonymousCallableExpression(context, node, prefix)
    case 'EffectExpression':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'EffectKeyword'), prefix, preserveBlank),
        printNode(context, nodeOf(node, 'Block'), FormatDocument.text(' ')),
      )
    case 'RunExpression':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'RunKeyword'), prefix, preserveBlank),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
      )
    case 'BorrowExpression': {
      const mut = directTokens(node).find((token) => token.kind === 'MutKeyword')
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Ampersand'), prefix, preserveBlank),
        ...(mut === undefined ? [] : [printToken(context, mut), FormatDocument.text(' ')]),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression')),
      )
    }
    case 'MatchExpression': {
      const nodes = directNodes(node)
      const access = nodes[0] ?? nodeOf(node, 'MatchAccess')
      const scrutinee = nodes[1] ?? nodeOf(node, 'IdentifierExpression')
      const arms = nodes.slice(2)
      const accessTokens = directTokens(access)
      const head = FormatDocument.concat(
        printToken(context, tokenOf(node, 'MatchKeyword'), prefix, preserveBlank),
        ...(accessTokens.length === 0
          ? []
          : [printNode(context, access, FormatDocument.text(' '))]),
        printNode(context, scrutinee, FormatDocument.text(' ')),
        printToken(context, tokenOf(node, 'LeftBrace'), FormatDocument.text(' ')),
      )
      if (arms.length === 0) {
        return FormatDocument.concat(head, printToken(context, tokenOf(node, 'RightBrace')))
      }
      return FormatDocument.concat(
        head,
        FormatDocument.indent(
          FormatDocument.concat(
            ...arms.map((arm) => printNode(context, arm, FormatDocument.hardLine, true)),
          ),
        ),
        printToken(context, tokenOf(node, 'RightBrace'), FormatDocument.hardLine),
      )
    }
    case 'MatchAccess':
      return printTokenSequence(context, node, prefix, FormatDocument.empty, preserveBlank)
    case 'MatchArm': {
      const nodes = directNodes(node)
      const pattern = nodes[0] ?? nodeOf(node, 'UniversalPattern')
      const guardKeyword = directTokens(node).find((token) => token.kind === 'IfKeyword')
      const result = nodes.at(-1) ?? nodeOf(node, 'IdentifierExpression')
      const guard = guardKeyword === undefined ? undefined : nodes[1]
      return FormatDocument.concat(
        printNode(context, pattern, prefix, preserveBlank),
        ...(guardKeyword === undefined || guard === undefined
          ? []
          : [
              printToken(context, guardKeyword, FormatDocument.text(' ')),
              printNode(context, guard, FormatDocument.text(' ')),
            ]),
        printToken(context, tokenOf(node, 'FatArrow'), FormatDocument.text(' ')),
        printNode(context, result, FormatDocument.text(' ')),
      )
    }
    case 'BindingPattern': {
      const nodes = directNodes(node)
      return FormatDocument.concat(
        printNode(context, nodes[0] ?? nodeOf(node, 'TypePath'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Identifier'), FormatDocument.text(' ')),
      )
    }
    case 'NominalPattern': {
      const nodes = directNodes(node)
      return FormatDocument.concat(
        printNode(context, nodes[0] ?? nodeOf(node, 'TypePath'), prefix, preserveBlank),
        printDelimited(
          context,
          tokenOf(node, 'LeftBrace'),
          nodes.slice(1),
          commaTokens(node),
          tokenOf(node, 'RightBrace'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'ErrorPattern':
    case 'EnumMemberPattern':
    case 'IntegerPattern':
    case 'UniversalPattern':
    case 'RestPattern':
      return printTokenSequence(context, node, prefix, FormatDocument.empty, preserveBlank)
    case 'PatternField': {
      const identifiers = directTokens(node).filter((token) => token.kind === 'Identifier')
      const nested = directNodes(node).find(
        (child) =>
          child.kind === 'NominalPattern' ||
          child.kind === 'UnionVariantPattern' ||
          child.kind === 'BindingPattern',
      )
      const colon = directTokens(node).find((token) => token.kind === 'Colon')
      const name = identifiers[0] ?? tokenOf(node, 'Identifier')
      if (colon === undefined) return printToken(context, name, prefix, preserveBlank)
      return FormatDocument.concat(
        printToken(context, name, prefix, preserveBlank),
        printToken(context, colon),
        nested === undefined
          ? printToken(
              context,
              identifiers[1] ?? tokenOf(node, 'Identifier', 1),
              FormatDocument.text(' '),
            )
          : printNode(context, nested, FormatDocument.text(' ')),
      )
    }
    case 'StructLiteralExpression': {
      const nodes = directNodes(node)
      const target = nodes[0] ?? nodeOf(node, 'TypePath')
      const fields = nodes.slice(1)
      return FormatDocument.concat(
        printNode(context, target, prefix),
        printDelimited(
          context,
          tokenOf(node, 'LeftBrace'),
          fields,
          commaTokens(node),
          tokenOf(node, 'RightBrace'),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'ContextualRecordLiteralExpression':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Dot'), prefix, preserveBlank),
        printDelimited(
          context,
          tokenOf(node, 'LeftBrace'),
          directNodes(node),
          commaTokens(node),
          tokenOf(node, 'RightBrace'),
          FormatDocument.empty,
        ),
      )
    case 'TupleLiteralExpression':
      return printDelimited(
        context,
        tokenOf(node, 'LeftParenthesis'),
        directNodes(node),
        commaTokens(node),
        tokenOf(node, 'RightParenthesis'),
        prefix,
        directNodes(node).length === 1,
      )
    case 'ArrayLiteralExpression':
      return printDelimited(
        context,
        tokenOf(node, 'LeftBracket'),
        directNodes(node),
        commaTokens(node),
        tokenOf(node, 'RightBracket'),
        prefix,
      )
    case 'StructFieldInitializer':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'Identifier'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'Colon')),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          FormatDocument.text(' '),
        ),
      )
    case 'FieldProjectionExpression':
      return FormatDocument.concat(
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          prefix,
          preserveBlank,
        ),
        printToken(context, tokenOf(node, 'Dot')),
        printToken(context, tokenOf(node, 'Identifier')),
      )
    case 'OrdinalProjectionExpression':
      return FormatDocument.concat(
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          prefix,
          preserveBlank,
        ),
        printToken(context, tokenOf(node, 'Dot')),
        printToken(context, tokenOf(node, 'DecimalInteger')),
      )
    case 'ReferentProjectionExpression':
      return FormatDocument.concat(
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          prefix,
          preserveBlank,
        ),
        printToken(context, tokenOf(node, 'Dot')),
        printToken(context, tokenOf(node, 'Star')),
      )
    case 'IndexProjectionExpression':
      return FormatDocument.concat(
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression'),
          prefix,
          preserveBlank,
        ),
        printToken(context, tokenOf(node, 'LeftBracket')),
        printNode(context, directNodes(node)[1] ?? nodeOf(node, 'IdentifierExpression', 1)),
        printToken(context, tokenOf(node, 'RightBracket')),
      )
    case 'CallExpression': {
      const nodes = directNodes(node)
      const callee = nodes[0] ?? nodeOf(node, 'IdentifierExpression')
      const typeArguments = nodes.find((child) => child.kind === 'CallTypeArgumentList')
      const argumentsList = nodes.find((child) => child.kind === 'ArgumentList')
      return FormatDocument.concat(
        printNode(context, callee, prefix, preserveBlank),
        ...(typeArguments === undefined ? [] : [printNode(context, typeArguments)]),
        printNode(context, argumentsList ?? nodeOf(node, 'ArgumentList')),
      )
    }
    case 'CompileErrorExpression':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'CompileErrorKeyword'), prefix, preserveBlank),
        printToken(context, tokenOf(node, 'LeftParenthesis')),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression')),
        printToken(context, tokenOf(node, 'RightParenthesis')),
      )
    case 'UnsafeExpression':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'UnsafeKeyword'), prefix, preserveBlank),
        printNode(
          context,
          directNodes(node)[0] ?? nodeOf(node, 'CallExpression'),
          FormatDocument.text(' '),
        ),
      )
    case 'GroupedExpression':
      return FormatDocument.concat(
        printToken(context, tokenOf(node, 'LeftParenthesis'), prefix, preserveBlank),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression')),
        printToken(context, tokenOf(node, 'RightParenthesis')),
      )
    case 'PrefixExpression': {
      const operator = directTokens(node)[0]
      if (operator === undefined)
        throw new SyntaxFormatterImplementationError('PrefixExpression has no operator')
      return FormatDocument.concat(
        printToken(context, operator, prefix, preserveBlank),
        printNode(context, directNodes(node)[0] ?? nodeOf(node, 'IdentifierExpression')),
      )
    }
    case 'InfixExpression': {
      const nodes = directNodes(node)
      const operator = directTokens(node)[0]
      if (operator === undefined)
        throw new SyntaxFormatterImplementationError('InfixExpression has no operator')
      return FormatDocument.concat(
        printNode(context, nodes[0] ?? nodeOf(node, 'IdentifierExpression'), prefix, preserveBlank),
        printToken(context, operator, FormatDocument.text(' ')),
        printNode(
          context,
          nodes[1] ?? nodeOf(node, 'IdentifierExpression', 1),
          FormatDocument.text(' '),
        ),
      )
    }
    case 'PipelineExpression': {
      const nodes = directNodes(node)
      return FormatDocument.concat(
        printNode(context, nodes[0] ?? nodeOf(node, 'IdentifierExpression'), prefix, preserveBlank),
        FormatDocument.indent(
          FormatDocument.concat(
            printToken(context, tokenOf(node, 'PipeGreater'), FormatDocument.hardLine),
            printNode(
              context,
              nodes[1] ?? nodeOf(node, 'IdentifierExpression'),
              FormatDocument.text(' '),
            ),
          ),
        ),
      )
    }
    case 'ArgumentList':
      return printDelimited(
        context,
        tokenOf(node, 'LeftParenthesis'),
        directNodes(node),
        commaTokens(node),
        tokenOf(node, 'RightParenthesis'),
        prefix,
      )
    case 'ErrorStatement':
    case 'Error':
      throw new SyntaxFormatterImplementationError('Damaged Error node reached the syntax printer')
  }
}

const changed = (source: Uint8Array, formatted: Uint8Array): boolean =>
  source.length !== formatted.length || source.some((byte, index) => byte !== formatted[index])

const validateFor = Effect.fnUntraced(function* (
  syntax: SyntaxFile.SyntaxFile,
  operation: SyntaxFormatterError['operation'],
): Effect.fn.Return<void, SyntaxFormatterError> {
  if (
    syntax.lexicalDiagnostics.length === 0 &&
    syntax.parserDiagnostics.length === 0 &&
    SyntaxTree.isAvailableSyntax(syntax.root)
  )
    return
  const diagnostics = [...syntax.lexicalDiagnostics, ...syntax.parserDiagnostics]
  return yield* new SyntaxFormatterError({
    operation,
    sourceId: syntax.source.id,
    message: `Cannot format damaged Silk source ${syntax.source.id}`,
    diagnostics,
    reason: { _tag: 'DamagedSyntax' },
  })
})

/** Validates that one complete syntax artifact can be formatted without source repair. */
export const validate = Effect.fn('SyntaxFormatter.validate')(function* (
  syntax: SyntaxFile.SyntaxFile,
): Effect.fn.Return<void, SyntaxFormatterError> {
  return yield* validateFor(syntax, 'SyntaxFormatter.validate')
})

/** Formats one complete lossless syntax artifact with Silk's canonical public policy. */
export const format = Effect.fn('SyntaxFormatter.format')(function* (
  syntax: SyntaxFile.SyntaxFile,
): Effect.fn.Return<FormattedDocument.FormattedDocument, SyntaxFormatterError> {
  yield* validateFor(syntax, 'SyntaxFormatter.format')

  const formatted = FormatDocument.render(printNode(makeContext(syntax), syntax.root))
  return FormattedDocument.make(formatted, changed(syntax.source.bytes, formatted))
})
