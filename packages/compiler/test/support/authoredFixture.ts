import * as Effect from 'effect/Effect'
import type * as AuthoredHir from '../../src/AuthoredHir.js'
import * as AuthoredIdentity from '../../src/AuthoredIdentity.js'
import * as AuthoredPool from '../../src/AuthoredPool.js'
import { unreachable } from './raise.js'

/**
 * A source-free vocabulary witness. It exercises authored storage, not language semantics:
 * no parser, name resolver, type checker, backend or native process is involved.
 */
export const broadModule = Effect.fnUntraced(function* (): Effect.fn.Return<
  AuthoredHir.Module,
  AuthoredPool.AuthoredPoolError
> {
  const texts: string[] = []
  const text = (value: string): AuthoredPool.TextRef => {
    const index = texts.length
    texts.push(value)
    return { _tag: 'TextRef', index }
  }
  const localOccurrences = new Map<AuthoredIdentity.Identity, Map<string, number>>()
  const node = (owner: AuthoredIdentity.Identity, role: string): AuthoredHir.Node => {
    const roles = localOccurrences.get(owner) ?? new Map<string, number>()
    const occurrence = roles.get(role) ?? 0
    roles.set(role, occurrence + 1)
    localOccurrences.set(owner, roles)
    return {
      anchor: {
        _tag: 'AuthoredAnchor',
        owner,
        path: [{ _tag: 'LocalSegment', role, occurrence }],
      },
      origin: { _tag: 'Authored' },
      causes: [],
    }
  }
  const name = (
    owner: AuthoredIdentity.Identity,
    value: string,
    role = 'name',
  ): AuthoredHir.Name => ({
    ...node(owner, role),
    _tag: 'Name',
    text: text(value),
  })
  const named = (owner: AuthoredIdentity.Identity, value: string): AuthoredHir.NamedHeader => ({
    ...node(owner, 'header'),
    name: name(owner, value),
    public: true,
  })
  const unit = (owner: AuthoredIdentity.Identity): AuthoredHir.Type => ({
    ...node(owner, 'type'),
    _tag: 'UnitType',
  })
  const integer = (
    owner: AuthoredIdentity.Identity,
    value = 9007199254740993n,
  ): AuthoredHir.IntegerLiteral => ({
    ...node(owner, 'integer'),
    _tag: 'IntegerLiteral',
    value,
    radix: 10,
    suffix: undefined,
  })
  const path = (owner: AuthoredIdentity.Identity, value: string): AuthoredHir.Path => ({
    ...node(owner, 'path'),
    _tag: 'Path',
    segments: [name(owner, value, 'segment')],
  })
  const contract = (owner: AuthoredIdentity.Identity): AuthoredHir.CallableContract => ({
    ...node(owner, 'contract'),
    _tag: 'CallableContract',
    generics: [
      {
        ...node(owner, 'generic'),
        _tag: 'TypeParameter',
        name: name(owner, 'T', 'generic-name'),
        bounds: [],
      },
    ],
    parameters: [
      {
        ...node(owner, 'parameter'),
        _tag: 'Parameter',
        name: name(owner, 'value', 'parameter-name'),
        type: unit(owner),
        mode: 'Value',
      },
    ],
    variadic: false,
    result: unit(owner),
    failures: undefined,
    requirements: { ...node(owner, 'requirements'), _tag: 'RequirementRow', members: [] },
    constraints: [],
    effect: true,
    test: false,
    environment: [],
    unsafe: false,
    static: false,
    effectAnchor: undefined,
    testAnchor: undefined,
    unsafeAnchor: undefined,
    staticAnchor: undefined,
    genericsAnchor: undefined,
    failuresAnchor: undefined,
    constraintsAnchor: undefined,
  })
  const linkage = (owner: AuthoredIdentity.Identity): AuthoredHir.Linkage => ({
    ...node(owner, 'linkage'),
    _tag: 'Linkage',
    direction: 'Import',
    abi: { ...node(owner, 'abi'), _tag: 'TextLiteral', value: text('C') },
    symbol: { ...node(owner, 'symbol'), _tag: 'TextLiteral', value: text('foreign_symbol') },
  })
  const property = (owner: AuthoredIdentity.Identity): AuthoredHir.PropertyClause => ({
    ...node(owner, 'property-clause'),
    _tag: 'PropertyClause',
    namespace: name(owner, 'compiler', 'property-namespace'),
    operation: name(owner, 'link', 'property-operation'),
    properties: [
      {
        ...node(owner, 'property'),
        _tag: 'Property',
        name: name(owner, 'library', 'property-name'),
        value: { ...node(owner, 'property-value'), _tag: 'TextLiteral', value: text('a\0b') },
      },
    ],
  })
  const declarationNames = [
    'import',
    'properties',
    'record',
    'tuple',
    'enum',
    'union',
    'service',
    'interface',
    'role',
    'impl',
    'alias',
    'static',
    'foreign',
    'function',
    'parameter',
    'conditional',
  ]
  const moduleOwner = AuthoredIdentity.module('fixture', 'authored.witness')
  const owners = AuthoredIdentity.children(
    moduleOwner,
    declarationNames.map((value) => ({ kind: 'declaration', name: value })),
  )
  const declarations: AuthoredHir.Declaration[] = []
  for (const [index, declarationName] of declarationNames.entries()) {
    const owner = owners[index] ?? unreachable('expected the allocated owner')
    let header: AuthoredHir.DeclarationHeader
    let body: AuthoredHir.DeclarationBody = { _tag: 'NoBody' }
    switch (declarationName) {
      case 'import':
        header = {
          ...node(owner, 'header'),
          _tag: 'ImportHeader',
          public: false,
          path: path(owner, 'library'),
          alias: name(owner, 'lib', 'alias'),
          members: [
            {
              ...node(owner, 'member'),
              _tag: 'ImportMember',
              name: name(owner, 'item', 'member-name'),
              alias: undefined,
            },
          ],
        }
        break
      case 'properties':
        header = {
          ...node(owner, 'header'),
          _tag: 'ModulePropertyHeader',
          properties: [property(owner)],
        }
        break
      case 'record':
        header = {
          ...named(owner, 'Record'),
          _tag: 'StructHeader',
          generics: [],
          genericsAnchor: undefined,
          fields: [
            {
              ...node(owner, 'field'),
              _tag: 'Field',
              name: name(owner, 'payload', 'field-name'),
              public: true,
              type: {
                ...node(owner, 'array-type'),
                _tag: 'FixedArrayType',
                element: unit(owner),
                length: integer(owner, 3n),
              },
            },
          ],
          abi: undefined,
        }
        break
      case 'tuple':
        header = {
          ...named(owner, 'Pair'),
          _tag: 'TupleHeader',
          generics: [],
          elements: [
            unit(owner),
            {
              ...node(owner, 'reference-type'),
              _tag: 'ReferenceType',
              referent: unit(owner),
              access: 'Shared',
              lifetime: undefined,
              role: undefined,
            },
          ],
        }
        break
      case 'enum':
        header = {
          ...named(owner, 'Color'),
          _tag: 'EnumHeader',
          representation: undefined,
          members: [
            {
              ...node(owner, 'member'),
              _tag: 'EnumMember',
              name: name(owner, 'Red', 'member-name'),
              value: integer(owner, 1n),
            },
          ],
        }
        break
      case 'union':
        header = {
          ...named(owner, 'Choice'),
          _tag: 'UnionHeader',
          generics: [],
          variants: [
            {
              ...node(owner, 'variant'),
              _tag: 'Variant',
              name: name(owner, 'Empty', 'variant-name'),
              fields: [],
              braces: false,
            },
          ],
        }
        break
      case 'service':
      case 'interface': {
        header = {
          ...named(owner, declarationName),
          _tag: declarationName === 'service' ? 'ServiceHeader' : 'InterfaceHeader',
          generics: [],
        }
        const child =
          AuthoredIdentity.children(owner, [{ kind: 'operation', name: 'run' }])[0] ??
          unreachable('expected operation owner')
        body = {
          _tag: 'MembersBody',
          members: [
            {
              _tag: 'Declaration',
              owner: child,
              header: {
                ...named(child, 'run'),
                _tag: 'OperationHeader',
                contract: contract(child),
                operator: undefined,
                properties: [],
              },
              body: { _tag: 'NoBody' },
            },
          ],
        }
        break
      }
      case 'role':
        header = { ...named(owner, 'Role'), _tag: 'RoleHeader' }
        break
      case 'impl': {
        header = {
          ...node(owner, 'header'),
          _tag: 'ImplHeader',
          generics: [],
          subject: unit(owner),
          target: undefined,
          constraints: [],
        }
        const alias =
          AuthoredIdentity.children(owner, [{ kind: 'alias', name: 'run' }])[0] ??
          unreachable('expected alias owner')
        body = {
          _tag: 'MembersBody',
          members: [
            {
              _tag: 'Declaration',
              owner: alias,
              header: {
                ...named(alias, 'run'),
                _tag: 'ImplAliasHeader',
                target: path(alias, 'implementation'),
              },
              body: { _tag: 'NoBody' },
            },
          ],
        }
        break
      }
      case 'alias':
        header = {
          ...named(owner, 'Alias'),
          _tag: 'AliasHeader',
          generics: [],
          target: {
            ...node(owner, 'pointer-type'),
            _tag: 'PointerType',
            pointee: unit(owner),
            access: 'Mutable',
            nullable: true,
            multiplicity: 'Many',
            qualifiers: [
              {
                ...node(owner, 'qualifier'),
                _tag: 'PointerQualifier',
                name: name(owner, 'align', 'qualifier-name'),
                value: integer(owner, 8n),
              },
            ],
          },
        }
        break
      case 'static':
        header = {
          ...named(owner, 'foreign_global'),
          _tag: 'StaticHeader',
          type: unit(owner),
          mutable: true,
          linkage: linkage(owner),
          properties: [],
        }
        break
      case 'foreign':
        header = {
          ...named(owner, 'foreign_call'),
          _tag: 'FunctionHeader',
          contract: contract(owner),
          linkage: linkage(owner),
          properties: [property(owner)],
        }
        body = { _tag: 'CallableBody', block: undefined }
        break
      case 'function': {
        header = {
          ...named(owner, 'run'),
          _tag: 'FunctionHeader',
          contract: contract(owner),
          linkage: undefined,
          properties: [],
        }
        const literals: AuthoredHir.Expression[] = [
          integer(owner),
          {
            ...node(owner, 'unrounded-decimal'),
            _tag: 'FloatingLiteral',
            sign: 'Positive',
            coefficient: 1000000000000000000000001n,
            exponent: -24n,
            suffix: undefined,
          },
          {
            ...node(owner, 'decimal'),
            _tag: 'FloatingLiteral',
            sign: 'Negative',
            coefficient: 0n,
            exponent: -300n,
            suffix: undefined,
          },
          {
            ...node(owner, 'duration'),
            _tag: 'DurationLiteral',
            components: [
              {
                ...node(owner, 'duration-hours'),
                _tag: 'DurationComponent',
                magnitude: 18446744073709551616n,
                unit: 'h',
              },
              {
                ...node(owner, 'duration-nanos'),
                _tag: 'DurationComponent',
                magnitude: 1n,
                unit: 'ns',
              },
            ],
          },
          { ...node(owner, 'bytes'), _tag: 'BytesLiteral', value: { _tag: 'BytesRef', index: 0 } },
          { ...node(owner, 'character'), _tag: 'CharacterLiteral', scalar: 0x1f600 },
        ]
        const pattern: AuthoredHir.Pattern = {
          ...node(owner, 'binding-pattern'),
          _tag: 'BindingPattern',
          type: undefined,
          name: name(owner, 'captured', 'binding-name'),
        }
        const condition: AuthoredHir.Expression = {
          ...node(owner, 'condition'),
          _tag: 'BooleanLiteral',
          value: true,
        }
        const block: AuthoredHir.Block = {
          ...node(owner, 'block'),
          _tag: 'Block',
          statements: [
            {
              ...node(owner, 'bind'),
              _tag: 'PatternBindingStatement',
              pattern,
              initializer: { ...node(owner, 'tuple'), _tag: 'TupleExpression', elements: literals },
            },
            {
              ...node(owner, 'if'),
              _tag: 'ConditionalStatement',
              condition,
              thenBranch: {
                ...node(owner, 'then'),
                _tag: 'Block',
                statements: [
                  {
                    ...node(owner, 'return'),
                    _tag: 'ReturnStatement',
                    value: {
                      ...node(owner, 'match'),
                      _tag: 'MatchExpression',
                      access: 'Move',
                      subject: integer(owner),
                      arms: [
                        {
                          ...node(owner, 'arm'),
                          _tag: 'MatchArm',
                          pattern,
                          guard: undefined,
                          result: integer(owner, 7n),
                        },
                      ],
                    },
                  },
                ],
              },
              elseBranch: undefined,
            },
            {
              ...node(owner, 'while'),
              _tag: 'WhileStatement',
              condition,
              body: {
                ...node(owner, 'loop'),
                _tag: 'Block',
                statements: [{ ...node(owner, 'break'), _tag: 'BreakStatement' }],
              },
            },
          ],
        }
        body = { _tag: 'CallableBody', block }
        break
      }
      case 'parameter':
        header = { ...named(owner, 'limit'), _tag: 'PackageParameterHeader', type: unit(owner) }
        body = {
          _tag: 'PackageParameterBody',
          default: integer(owner, 5n),
          validation: { ...node(owner, 'validate'), _tag: 'BooleanLiteral', value: true },
        }
        break
      case 'conditional': {
        header = {
          ...node(owner, 'header'),
          _tag: 'ConditionalHeader',
          condition: { ...node(owner, 'condition'), _tag: 'BooleanLiteral', value: false },
        }
        const [thenOwner, elseOwner] = AuthoredIdentity.children(owner, [
          { kind: 'group', role: 'then' },
          { kind: 'group', role: 'else' },
        ])
        const thenBranch = thenOwner ?? unreachable('expected then owner')
        const elseBranch = elseOwner ?? unreachable('expected else owner')
        body = {
          _tag: 'ConditionalBody',
          thenBranch: {
            _tag: 'Declaration',
            owner: thenBranch,
            header: { ...node(thenBranch, 'header'), _tag: 'GroupHeader', branch: 'Then' },
            body: { _tag: 'MembersBody', members: [] },
          },
          elseBranch: {
            _tag: 'Declaration',
            owner: elseBranch,
            header: { ...node(elseBranch, 'header'), _tag: 'GroupHeader', branch: 'Else' },
            body: { _tag: 'MembersBody', members: [] },
          },
        }
        break
      }
      default:
        return unreachable('unexpected fixture declaration')
    }
    declarations.push({ _tag: 'Declaration', owner, header, body })
  }
  return {
    _tag: 'AuthoredModule',
    owner: moduleOwner,
    pool: yield* AuthoredPool.make(texts, [[0, 255, 0, 128]]),
    declarations,
  }
})
