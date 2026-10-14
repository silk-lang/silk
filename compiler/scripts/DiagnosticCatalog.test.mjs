import { assert, it } from '@effect/vitest'
import { verify } from './DiagnosticCatalog.mjs'

const definitions = [
  ['patternBindingConflict', 'SEM0048', 'Binding conflicts with {name}'],
  ['argumentTypeMismatch', 'SEM0012', 'Expected {expected} but received {actual}'],
  ['unsupportedBytes', 'LEX0001', 'Unsupported bytes'],
  ['staticPhaseViolation', 'SEM0176', 'Static phase violation: {detail}'],
  ['unknownType', 'SEM0001', 'Unknown type {spelling}'],
]
const member = (name) => `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`
const typescript = (template) => template.replace(/\{(\w+)\}/g, (_text, hole) => `\${${hole}}`)
const fixture = () => ({
  bootstrap: definitions
    .map(
      ([name, code, template]) =>
        `/** Meaning of ${code}. */\nexport const ${name}Code = '${code}' as const\nconst ${name} = (span) => ({ code: ${name}Code, message: \`${typescript(template)}\`, span })`,
    )
    .join('\n'),
  catalog: `pub enum Code {
${definitions.map(([name]) => `  ${member(name)},`).join('\n')}
}
pub fn spelling(code: Code) -> string<'static> {
  return match code {
${definitions.map(([name, code]) => `    Code.${member(name)} => "${code}"`).join('\n')}
  }
}
pub fn meaning(code: Code) -> string<'static> {
  return match code {
${definitions.map(([name, code]) => `    Code.${member(name)} => "Meaning of ${code}."`).join('\n')}
  }
}
pub fn template(code: Code, choice: usize) -> string<'static> {
  return match code {
${definitions.map(([name, , template]) => `    Code.${member(name)} => "${template}"`).join('\n')}
  }
}`,
  rejection: `pub enum RejectionCode {
  PatternBindingConflict,
  ArgumentTypeMismatch,
}
pub fn catalogCode(code: RejectionCode) -> Option<Code> {
  return match code {
    RejectionCode.PatternBindingConflict => Option<Code>.some(Code.PatternBindingConflict)
    RejectionCode.ArgumentTypeMismatch => Option<Code>.some(Code.ArgumentTypeMismatch)
  }
}`,
  lexical: `pub union LexicalDiagnostic {
  UnsupportedBytes {pub span: Span},
}
run writeLine(Code.UnsupportedBytes, "UnsupportedBytes", span)`,
  staticExecution: `pub enum Fault {
  StaticPhaseViolation,
}
fn faultCatalogCode(fault: Fault) -> Option<Code> {
  return match fault {
    Fault.StaticPhaseViolation => Option<Code>.some(Code.StaticPhaseViolation)
  }
}`,
  documentation: definitions
    .map(([, code]) => `| \`${code}\` | Meaning | \`A complete message\` |`)
    .join('\n'),
  references: '## TYPE-001 Type names\n## PATT-005 Pattern bindings',
  coverage: [
    { code: 'SEM0001', rules: ['TYPE-001'], reason: 'No dedicated producer in this fixture' },
  ],
})

const reports = (input, expected) =>
  assert.ok(
    verify(input).some((issue) => issue.includes(expected)),
    `${expected}: ${verify(input).join('; ')}`,
  )

it('accepts an exhaustive catalog and explicitly recorded diagnostic gap', () => {
  assert.deepStrictEqual(verify(fixture()), [])
})

it('accepts a refusal without a catalog code and rejects a default arm', () => {
  const input = fixture()
  input.rejection = input.rejection
    .replace('  PatternBindingConflict,', '  Unsupported,\n  PatternBindingConflict,')
    .replace(
      '  return match code {',
      '  return match code {\n    RejectionCode.Unsupported => Option<Code>.none()',
    )
  assert.deepStrictEqual(verify(input), [])
  const defaulted = {
    ...input,
    rejection: input.rejection.replace('  }\n}', '    _ => Option<Code>.none()\n  }\n}'),
  }
  reports(defaulted, 'default or non-catalog arm')
})

it('rejects missing, duplicate and unknown native arms and unknown codes', () => {
  for (const [replace, expected] of [
    [
      (text) =>
        text.replace(
          /    RejectionCode.PatternBindingConflict => Option<Code>.some\(Code.PatternBindingConflict\)\n/,
          '',
        ),
      'missing arm PatternBindingConflict',
    ],
    [
      (text) =>
        text.replace(
          'RejectionCode.ArgumentTypeMismatch =>',
          'RejectionCode.PatternBindingConflict =>',
        ),
      'duplicate arm',
    ],
    [
      (text) => text.replace('RejectionCode.ArgumentTypeMismatch =>', 'RejectionCode.Elsewhere =>'),
      'unknown arm Elsewhere',
    ],
    [
      (text) => text.replace('some(Code.ArgumentTypeMismatch)', 'some(Code.NoSuchCode)'),
      'unknown catalog code Code.NoSuchCode',
    ],
  ]) {
    const input = fixture()
    input.rejection = replace(input.rejection)
    reports(input, expected)
  }
})

it('ties a lexical reason to the code of the same name', () => {
  const input = fixture()
  input.lexical = input.lexical.replace(
    'writeLine(Code.UnsupportedBytes',
    'writeLine(Code.UnknownType',
  )
  reports(input, 'lexical reason UnsupportedBytes reports Code.UnknownType')
})

it('requires new lexical and static reasons to have a catalog mapping', () => {
  const lexical = fixture()
  lexical.lexical = lexical.lexical.replace(
    '  UnsupportedBytes',
    '  NewReason {pub span: Span},\n  UnsupportedBytes',
  )
  reports(lexical, 'missing lexical reason NewReason')
  const fault = fixture()
  fault.staticExecution = fault.staticExecution.replace(
    '  StaticPhaseViolation,',
    '  StaticPhaseViolation,\n  NewFault,',
  )
  reports(fault, 'faultCatalogCode: missing arm NewFault')
})

it('requires the native catalog to match the bootstrap template for template', () => {
  for (const [replace, expected] of [
    [
      (text) => text.replace('"Unknown type {spelling}"', '"Unknown kind {spelling}"'),
      'template 0 differs',
    ],
    [
      (text) => text.replace('"Expected {expected} but', '"Expected {expected}{actual} but'),
      'template 0 differs',
    ],
    [(text) => text.replace('"Meaning of SEM0012."', '"Another meaning."'), 'meaning differs'],
    [(text) => text.replace('=> "SEM0001"', '=> "SEM0002"'), 'spelled SEM0002'],
    [
      (text) => text.replace('  UnknownType,\n', '  UnknownType,\n  Extra,\n'),
      'Code.Extra: not in the bootstrap',
    ],
    [(text) => text.replace('  UnknownType,\n', ''), 'Catalog.silk has no Code.UnknownType'],
  ]) {
    const input = fixture()
    input.catalog = replace(input.catalog)
    reports(input, expected)
  }
  const renamed = fixture()
  renamed.catalog = renamed.catalog.replace('"Unknown type {spelling}"', '"Unknown type {name}"')
  assert.deepStrictEqual(verify(renamed), [])
})

it('compares every template of a code that chooses among several', () => {
  const input = fixture()
  input.bootstrap = input.bootstrap.replace(
    'message: `Unknown type ${spelling}`',
    'message: generic ? `Unknown generic ${spelling}` : `Unknown type ${spelling}`',
  )
  reports(input, '1 templates, bootstrap 2')
  input.catalog = input.catalog.replace(
    '    Code.UnknownType => "Unknown type {spelling}"',
    '    Code.UnknownType => {\n      if choice == 1 { return "Unknown type {spelling}" }\n      return "Unknown generic {spelling}"\n    }',
  )
  assert.deepStrictEqual(verify(input), [])
  input.catalog = input.catalog.replace(
    'return "Unknown type {spelling}"',
    'return "Unknown {spelling}"',
  )
  reports(input, 'template 1 differs')
})

it('rejects removed messages, missing documentation, and duplicate catalog codes', () => {
  const missingMessage = fixture()
  missingMessage.bootstrap = missingMessage.bootstrap.replace(
    'message: `Unknown type ${spelling}`',
    'templateRemoved: true',
  )
  reports(missingMessage, 'message template')
  const missingDocumentation = fixture()
  missingDocumentation.documentation = ''
  reports(missingDocumentation, 'missing generated documentation')
  const collision = fixture()
  collision.bootstrap = collision.bootstrap.replace("'SEM0048' as const", "'SEM0012' as const")
  reports(collision, 'duplicate catalog code')
})

it('requires gaps to have rules and reasons and rejects stale or missing gap entries', () => {
  const missing = fixture()
  missing.coverage = []
  reports(missing, 'no native producer or explicit gap')
  const unexplained = fixture()
  unexplained.coverage = [{ code: 'SEM0001', rules: [], reason: '' }]
  reports(unexplained, 'no reference rule')
  reports(unexplained, 'no explanation')
  const stale = fixture()
  stale.coverage.push({ code: 'SEM0048', rules: ['PATT-005'], reason: 'Already covered' })
  reports(stale, 'covered code still listed')
})

it('rejects coverage entries that cite a nonexistent reference rule', () => {
  const input = fixture()
  input.coverage = [{ code: 'SEM0001', rules: ['TYPE-999'], reason: 'A missing rule' }]
  reports(input, 'unknown reference rule TYPE-999')
})

it('reads arms and template choices in the formatter wrapped layout', () => {
  const input = fixture()
  input.rejection = input.rejection.replace(
    'RejectionCode.ArgumentTypeMismatch => Option<Code>.some(Code.ArgumentTypeMismatch)',
    'RejectionCode.ArgumentTypeMismatch => Option<\n      Code\n    >.some(Code.ArgumentTypeMismatch)',
  )
  input.bootstrap = input.bootstrap.replace(
    'message: `Unknown type ${spelling}`',
    'message: generic ? `Unknown generic ${spelling}` : `Unknown type ${spelling}`',
  )
  input.catalog = input.catalog.replace(
    '    Code.UnknownType => "Unknown type {spelling}"',
    '    Code.UnknownType => {\n      if choice == 1 {\n        return "Unknown type {spelling}"\n      }\n      return "Unknown generic {spelling}"\n    }',
  )
  assert.deepStrictEqual(verify(input), [])
})
