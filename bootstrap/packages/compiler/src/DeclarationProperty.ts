import type * as AuthoredHir from './AuthoredHir.js'
import * as SemanticContext from './SemanticContext.js'

/** An authored clause's `namespace.operation` owner, as semantic consumers address it. */
export const authoredOwner = (
  context: SemanticContext.SemanticContext,
  clause: AuthoredHir.PropertyClause,
): string =>
  `${SemanticContext.nameText(context, clause.namespace) ?? ''}.${
    SemanticContext.nameText(context, clause.operation) ?? ''
  }`
