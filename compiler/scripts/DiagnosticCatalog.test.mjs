import { assert, it } from '@effect/vitest'
import { verify } from './DiagnosticCatalog.mjs'

const definitions = [
  ['patternBindingConflictCode', 'SEM0048'],
  ['argumentTypeMismatchCode', 'SEM0012'],
  ['unsupportedBytesCode', 'LEX0001'],
  ['staticPhaseViolationCode', 'SEM0176'],
  ['unknownTypeCode', 'SEM0001'],
]
const fixture = () => ({
  bootstrap: definitions
    .map(
      ([symbol, code]) =>
        `export const ${symbol} = '${code}' as const\nconst factory${symbol} = { code: ${symbol}, message: 'A complete message' }`,
    )
    .join('\n'),
  rejection: `pub enum RejectionCode {
  PatternBindingConflict,
  ArgumentTypeMismatch,
}
pub fn stableCode(code: RejectionCode) -> &'static [u8] {
  return match code {
    // bootstrap: patternBindingConflictCode
    RejectionCode.PatternBindingConflict => b"SEM0048"
    // bootstrap: argumentTypeMismatchCode
    RejectionCode.ArgumentTypeMismatch => b"SEM0012"
  }
}`,
  lexical: `pub union LexicalDiagnostic {
  UnsupportedBytes {pub span: Span},
}
run writeLine("LEX0001", "UnsupportedBytes", span)`,
  staticExecution: `pub enum Fault {
  StaticPhaseViolation,
}
fn faultCode(fault: Fault) -> &'static [u8] {
  return match fault {
    // bootstrap: staticPhaseViolationCode
    Fault.StaticPhaseViolation => b"SEM0176"
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

it('accepts an exhaustive catalog and explicitly recorded diagnostic gap', () => {
  assert.deepStrictEqual(verify(fixture()), [])
})

it('accepts an explicitly uncoded refusal and rejects coding or misnaming it', () => {
  const input = fixture()
  input.rejection = input.rejection
    .replace('  PatternBindingConflict,', '  Unsupported,\n  PatternBindingConflict,')
    .replace(
      '  return match code {',
      '  return match code {\n    // refusal: Unsupported\n    RejectionCode.Unsupported => b""',
    )
  assert.deepStrictEqual(verify(input), [])
  const coded = { ...input, rejection: input.rejection.replace('b""', 'b"NAT0001"') }
  assert.ok(verify(coded).some((issue) => issue.includes('unannotated')))
  const wrongReason = {
    ...input,
    rejection: input.rejection.replace('refusal: Unsupported', 'refusal: Other'),
  }
  assert.ok(verify(wrongReason).some((issue) => issue.includes('refusal reason differs')))
})

it('rejects a wrong code even when it exists in the bootstrap catalog', () => {
  const input = fixture()
  input.rejection = input.rejection.replace('b"SEM0048"', 'b"SEM0012"')
  assert.ok(
    verify(input).some((issue) => issue.includes('differs from patternBindingConflictCode')),
  )
})

it('rejects missing, duplicate, default and unregistered native arms', () => {
  for (const [replace, expected] of [
    [
      (text) =>
        text.replace(
          /    \/\/ bootstrap: patternBindingConflictCode\n    RejectionCode.PatternBindingConflict => b"SEM0048"\n/,
          '',
        ),
      'missing native arm',
    ],
    [(text) => text.replace('  }\n}', '    _ => b"SEM0048"\n  }\n}'), 'default'],
    [
      (text) =>
        text.replace(
          'RejectionCode.ArgumentTypeMismatch =>',
          'RejectionCode.PatternBindingConflict =>',
        ),
      'duplicate native arm',
    ],
    [(text) => text.replace('b"SEM0048"', 'b"SEM9999"'), 'unregistered code'],
  ]) {
    const input = fixture()
    input.rejection = replace(input.rejection)
    assert.ok(
      verify(input).some((issue) => issue.includes(expected)),
      expected,
    )
  }
})

it('rejects lexical and static mapping drift by semantic identity', () => {
  for (const key of ['lexical', 'staticExecution']) {
    const input = fixture()
    input[key] = input[key].replace(/(?:LEX0001|SEM0176)/, 'SEM0012')
    assert.ok(verify(input).some((issue) => issue.includes('differs from')))
  }
})

it('requires new lexical and static reasons to have a catalog mapping', () => {
  const lexical = fixture()
  lexical.lexical = lexical.lexical.replace(
    '  UnsupportedBytes',
    '  NewReason {pub span: Span},\n  UnsupportedBytes',
  )
  assert.ok(verify(lexical).some((issue) => issue.includes('missing lexical reason NewReason')))
  const fault = fixture()
  fault.staticExecution = fault.staticExecution.replace(
    '  StaticPhaseViolation,',
    '  StaticPhaseViolation,\n  NewFault,',
  )
  assert.ok(verify(fault).some((issue) => issue.includes('missing static fault NewFault')))
})

it('rejects removed messages, missing documentation, and duplicate catalog codes', () => {
  const missingMessage = fixture()
  missingMessage.bootstrap = missingMessage.bootstrap.replace(
    "message: 'A complete message'",
    'templateRemoved: true',
  )
  assert.ok(verify(missingMessage).some((issue) => issue.includes('message template')))
  const missingDocumentation = fixture()
  missingDocumentation.documentation = ''
  assert.ok(
    verify(missingDocumentation).some((issue) => issue.includes('missing generated documentation')),
  )
  const collision = fixture()
  collision.bootstrap = collision.bootstrap.replace("'SEM0048' as const", "'SEM0012' as const")
  assert.ok(verify(collision).some((issue) => issue.includes('duplicate catalog code')))
})

it('requires gaps to have rules and reasons and rejects stale or missing gap entries', () => {
  const missing = fixture()
  missing.coverage = []
  assert.ok(verify(missing).some((issue) => issue.includes('no native producer or explicit gap')))
  const unexplained = fixture()
  unexplained.coverage = [{ code: 'SEM0001', rules: [], reason: '' }]
  assert.ok(verify(unexplained).some((issue) => issue.includes('no reference rule')))
  assert.ok(verify(unexplained).some((issue) => issue.includes('no explanation')))
  const stale = fixture()
  stale.coverage.push({ code: 'SEM0048', rules: ['PATT-005'], reason: 'Already covered' })
  assert.ok(verify(stale).some((issue) => issue.includes('covered code still listed')))
})

it('rejects coverage entries that cite a nonexistent reference rule', () => {
  const input = fixture()
  input.coverage = [{ code: 'SEM0001', rules: ['TYPE-999'], reason: 'A missing rule' }]
  assert.ok(verify(input).some((issue) => issue.includes('unknown reference rule TYPE-999')))
})
