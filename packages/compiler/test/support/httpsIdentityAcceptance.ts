// Fixture matrix v1: RFC 9525 (2023-11), RFC 9110 (2022-06), RFC 5280 (2008-05).
// Policy comparisons are pinned to webpki 3d0adc46704c1d985a9fefe2034650488d96d49e.
// One shared native corpus program evaluates all rows; there is no per-row compilation.
const literal = (text: string): string =>
  `b"${Array.from(text, (byte) => `\\x${byte.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}"`
const dns = (text: string): string => `PresentedIdentity<'a>.Dns { bytes: ${literal(text)} }`
const ip = (bytes: readonly number[]): string =>
  `PresentedIdentity<'a>.Ip { bytes: ${literal(String.fromCharCode(...bytes))} }`
const other = (tag: number, text: string): string =>
  `PresentedIdentity<'a>.Other { tag: ${tag}, bytes: ${literal(text)} }`
const reference = (text: string): string => `ReferenceIdentity.Dns { bytes: ${literal(text)} }`
const v4 = [192, 0, 2, 1]
const v6 = [32, 1, 13, 184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
const mapped = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...v4]
const address = (bytes: readonly number[]): string =>
  `ReferenceIdentity<'static>.Ipv${bytes.length === 4 ? 4 : 6} { bytes: [${bytes.join(', ')}] }`
const match = (index = 0): string => `Expected.Match { index: ${index} }`
const failure = (variant: string, fields = ''): string =>
  `Expected.Failure { error: IdentityError.${variant}${fields === '' ? '' : ` { ${fields} }`} }`
const name = (reason: string, index = 0): string =>
  failure('MalformedCertificateName', `index: ${index}, reason: NameError.${reason}`)
const identity = (reason: string, index = 0): string =>
  failure(
    'MalformedCertificateIdentity',
    `index: ${index}, reason: CertificateIdentityError.${reason}`,
  )
const limit = (kind: string): string => failure('LimitExceeded', `kind: LimitKind.${kind}`)
const structure = (reason: string): string =>
  failure('MalformedCertificateStructure', `reason: CertificateStructureError.${reason}`)
const noMatch = failure('NoMatch')
const checks: string[] = []
const fixtures: string[] = []
const check = (
  id: string,
  host: string,
  sans: readonly string[] | string,
  expected: string,
  limits = 'IdentityLimits.standard()',
): void => {
  const index = fixtures.length
  const localEntries =
    typeof sans === 'string'
      ? ''
      : `let entries: [PresentedIdentity<'a>; ${sans.length}] = [${sans.join(', ')}]`
  const certificate =
    typeof sans === 'string'
      ? sans
          .replace(/CertificateIdentities.Decoded \{ entries: (.*) \}/, 'certificateView($1)')
          .replace('CertificateIdentities.Absent', "CertificateIdentities<'static>.Absent")
          .replace('CertificateIdentities.Malformed', "CertificateIdentities<'static>.Malformed")
      : 'certificateView(&entries)'
  fixtures.push(`// ${id}
    if true {
      ${localEntries}
      let reference = ${host}
      let certificate = ${certificate}
      if !check(&reference, &certificate, ${limits}, ${expected}) { return ${index + 1} }
    }`)
}
const d = (id: string, host: string, sans: readonly string[], expected: string): void =>
  check(id, reference(host), sans.map(dns), expected)

d('D01', 'www.example', ['www.example'], match())
d('D02', 'WWW.Example', ['www.EXAMPLE'], match())
d('D03', 'www.example', ['other.example'], noMatch)
d('D04', 'a.example', ['*.example'], match())
d('D05', 'example', ['*.example'], noMatch)
d('D06', 'a.b.example', ['*.example'], noMatch)
d('D07', 'a.example', ['a.example.evil'], noMatch)
d('D08', 'www.example', ['w*.example', 'www.example'], match(1))
d('D09', 'www.example', ['*.*.example', 'www.example'], match(1))
d('D10', 'www.example', ['a.*.example', 'www.example'], match(1))
d('D11', 'www.example', ['**.example'], noMatch)
d('D12', 'www.example', ['www.example', 'w*.example'], match())
d('D13', 'xn--bcher-kva.example', ['XN--BCHER-KVA.EXAMPLE'], match())
d('D14', 'xn--bcher-kva.example', ['*.example'], match())
d('D15', 'a.com', ['*.com'], match())
d('D16', 'intranet', ['INTRANET'], match())
d('D17', 'a.example', ['*a.example', 'a.example', '*.example'], match(1))
d('D18', 'www.example', ['*', 'www.example'], name('MissingWildcardSuffix'))
d('D19', 'www.example', ['w*._bad.example', 'www.example'], match(1))
d('D20', 'www.example', ['w*\0.example', 'www.example'], match(1))
d('D21', 'www.example', ['*.exa\0mple', 'www.example'], name('Nul'))
d('D22', 'www.example', ['w*\xff.example', 'www.example'], name('NonAscii'))

const admission: ReadonlyArray<readonly [string, string, string]> = [
  ['R01', '', 'EmptyName'],
  ['R02', 'a..example', 'EmptyLabel'],
  ['R03', '.example', 'EmptyLabel'],
  ['R04', `${'a'.repeat(64)}.example`, 'LabelTooLong'],
  [
    'R05',
    ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(62)].join('.'),
    'NameTooLong',
  ],
  ['R06a', 'www.example.', 'TrailingDot'],
  ['R06b', 'www.example..', 'TrailingDot'],
  ['R07', 'www\0.example', 'Nul'],
  ['R08', 'b\xc3\xbccher.example', 'NonAscii'],
  ['R09', 'a\xff.example', 'NonAscii'],
  ...['bad_name.example', 'a b.example', 'a%2eb.example', 'a/example', 'a:443', '[::1]'].map(
    (value) => ['R10', value, 'InvalidCharacter'] as const,
  ),
  ...['-a.example', 'a-.example'].map((value) => ['R11', value, 'EdgeHyphen'] as const),
  ...['192.0.2.1', '192.0.2.999', '127.1', '2130706433', 'example.123'].map(
    (value) => ['R12', value, 'NumericFinalLabel'] as const,
  ),
  ['R13', '*.example', 'WildcardReference'],
  ['R16', 'xn--.example', 'EdgeHyphen'],
]
for (const [id, raw, reason] of admission) {
  const expected = failure('MalformedReference', `reason: NameError.${reason}`)
  check(`${id} manual reference`, reference(raw), 'CertificateIdentities.Absent', expected)
  d(
    `${id} certificate`,
    'www.example',
    [raw],
    reason === 'WildcardReference' ? match() : name(reason),
  )
  const index = checks.length + 1
  checks.push(`// ${id} constructor
  if !rejectedReference(HttpsIdentity.reference(OriginHost.Dns { bytes: ${literal(raw)} }), NameError.${reason}) { return ${index} }`)
}
for (const [id, raw] of [
  ['R14', `${'a'.repeat(63)}.example`],
  ['R15', ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')],
  ['R17', 'xn--a.example'],
] as const) {
  d(id, raw, [raw], match())
  checks.push(`if !admittedReference(${literal(raw)}) { return ${checks.length + 1} }`)
}
for (const bytes of [v4, v6, mapped]) {
  checks.push(
    `if !admittedIp(OriginHost<'static>.Ipv${bytes.length === 4 ? 4 : 6} { bytes: [${bytes.join(', ')}] }, ${literal(String.fromCharCode(...bytes))}) { return ${checks.length + 1} }`,
  )
}
check('I01', address(v4), [ip(v4)], match())
check('I02', address(v4), [ip([192, 0, 2, 2])], noMatch)
check('I03', address(v6), [ip(v6)], match())
check('I04', address(v6), [ip([...v6.slice(0, 15), 2])], noMatch)
check('I05', address(v4), [ip(mapped)], noMatch)
check('I06', address(mapped), [ip(mapped)], match())
check('I07', address(v4), [dns('192.0.2.1')], name('NumericFinalLabel'))
check('I08', reference('www.example'), [ip(v4)], noMatch)
for (const size of [3, 5, 15, 17, 8, 32]) {
  check(
    `I09/I10 ${size} bytes`,
    address(v4),
    [ip(Array.from({ length: size }, () => 0))],
    identity('InvalidIpLength'),
  )
}
for (const form of ['IpvFuture', 'ZoneIdentifier', 'UriId', 'SrvId']) {
  checks.push(
    `if !unsupported(HttpsIdentity.reference(OriginHost<'static>.Unsupported { form: UnsupportedForm.${form} }), UnsupportedForm.${form}) { return ${checks.length + 1} }`,
  )
}
d('M01', 'www.example', ['www.example', 'bad_name.example'], name('InvalidCharacter', 1))
d('M02', 'www.example', ['bad_name.example', 'www.example'], name('InvalidCharacter'))
check(
  'M03',
  reference('www.example'),
  [dns('www.example'), ip([0, 0, 0])],
  identity('InvalidIpLength', 1),
)
check('M04', address(v4), [ip(v4), dns('a\xff')], name('NonAscii', 1))
for (const reason of [
  'InvalidDer',
  'InvalidGeneralName',
  'DuplicateSanExtension',
  'EmptySanExtension',
]) {
  check(
    `M05 ${reason}`,
    reference('www.example'),
    `CertificateIdentities.Malformed { reason: CertificateStructureError.${reason} }`,
    structure(reason),
  )
}
check('M06', reference('www.example'), [], structure('EmptySanExtension'))
check(
  'M07 CN cannot enter this API',
  reference('www.example'),
  'CertificateIdentities.Absent',
  noMatch,
)
check(
  'M08 URI/SRV ignored',
  reference('www.example'),
  [
    other(6, 'https://www.example'),
    other(0, '\x06\x08\x2b\x06\x01\x05\x05\x07\x08\x07\xa0\x0e\x16\x0c_www.example'),
  ],
  noMatch,
)
check(
  'M09',
  reference('www.example'),
  [other(6, 'https://other.example'), dns('www.example')],
  match(1),
)
for (const tag of [2, 7, 9])
  check('M10', reference('www.example'), [other(tag, '')], identity('WrongGeneralNameTag'))
check(
  'M12',
  reference(''),
  'CertificateIdentities.Malformed { reason: CertificateStructureError.InvalidDer }',
  failure('MalformedReference', 'reason: NameError.EmptyName'),
)
check(
  'M13',
  reference('www.example'),
  'CertificateIdentities.Malformed { reason: CertificateStructureError.InvalidDer }',
  structure('InvalidDer'),
  'IdentityLimits { maxSanCount: 0, maxSanBytes: 0 }',
)
const limits = (count: number, bytes: number): string =>
  `IdentityLimits { maxSanCount: ${count}, maxSanBytes: ${bytes} }`
// Reuse one bounded backing array and one padding literal for limit boundary cases.
const many =
  "CertificateIdentities.Decoded { entries: Slice.view<PresentedIdentity<'a>>(many, 0, 256) }"
check('L01', reference('www.example'), many, match())
check(
  'L02',
  reference('www.example'),
  'CertificateIdentities.Decoded { entries: many }',
  limit('SanCount'),
)
check(
  'L03',
  reference('www.example'),
  [
    dns('www.example'),
    "PresentedIdentity<'a>.Other { tag: 6, bytes: Slice.view<u8>(padding, 0, 65525) }",
  ],
  match(),
)
check(
  'L04',
  reference('www.example'),
  [dns('www.example'), "PresentedIdentity<'a>.Other { tag: 6, bytes: padding }"],
  limit('SanBytes'),
)
check(
  'L05',
  reference('www.example'),
  'CertificateIdentities.Decoded { entries: many }',
  limit('SanCount'),
  limits(256, 0),
)
check('L06', reference('www.example'), 'CertificateIdentities.Absent', noMatch, limits(0, 0))
check('L07', reference('www.example'), [dns('www.example')], limit('SanCount'), limits(0, 0))
check('L08', reference('www.example'), [dns('www.example')], limit('SanBytes'), limits(1, 0))
check(
  'L09',
  reference('www.example'),
  [dns('www.example'), dns('www.example')],
  limit('SanBytes'),
  limits(2, 11),
)
check(
  'L10',
  reference('www.example'),
  [dns('w*.example'), dns('www.example')],
  limit('SanBytes'),
  limits(2, 11),
)
check('L11', reference('www.example'), [dns('bad_name.example')], limit('SanBytes'), limits(2, 0))
// L12 is checked-sum implementation inspection, not an impossible-sized safe allocation.

const errorVariants = [
  ['MalformedReference', 'reason'],
  ['MalformedCertificateStructure', 'reason'],
  ['MalformedCertificateName', 'index, reason'],
  ['MalformedCertificateIdentity', 'index, reason'],
  ['Unsupported', 'form'],
  ['LimitExceeded', 'kind'],
  ['NoMatch', ''],
] as const
const errorComparison = errorVariants
  .map(([variant, fields]) => {
    const names = fields === '' ? [] : fields.split(', ')
    const pattern = names.length === 0 ? '' : ` { ${fields} }`
    const expectedPattern =
      names.length === 0
        ? ''
        : ` { ${names.map((field) => `${field}: expected${field}`).join(', ')} }`
    const comparison =
      names.length === 0
        ? 'true'
        : names.map((field) => `${field} == expected${field}`).join(' && ')
    return `IdentityError.${variant}${pattern} => match move expected {
    IdentityError.${variant}${expectedPattern} => ${comparison}
    _ => false
  }`
  })
  .join('\n')

const groups = Array.from({ length: Math.ceil(fixtures.length / 10) }, (_, group) => {
  const rows = fixtures.slice(group * 10, group * 10 + 10)
  return `fn cases${group}<'a>(many: &'a [PresentedIdentity<'a>], padding: &'a [u8]) -> i32 {
    ${rows.join('\n')}
    return 0
  }`
})

export const httpsIdentityAcceptanceSource = `
import silk.https_identity { HttpsIdentity, OriginHost, ReferenceIdentity, PresentedIdentity, CertificateIdentities, IdentityLimits, IdentityMatch, IdentityError, NameError, CertificateIdentityError, CertificateStructureError, UnsupportedForm, LimitKind }
import silk.result { Result }
import silk.slice { Slice }
import silk.bytes { Bytes }
import silk.vector { Vector }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.usize
union Expected {
  Match { index: usize },
  Failure { error: IdentityError },
}
impl Copy for Expected {}
fn certificateView<'a>(entries: &'a [PresentedIdentity<'a>]) -> CertificateIdentities<'a> {
  return CertificateIdentities<'a>.Decoded { entries: entries }
}
fn sameError(actual: IdentityError, expected: IdentityError) -> bool {
  return match move actual { ${errorComparison} }
}
fn check<'name, 'cert>(reference: &ReferenceIdentity<'name>, certificate: &CertificateIdentities<'cert>, limits: IdentityLimits, expected: Expected) -> bool {
  let result = HttpsIdentity.verify(reference, certificate, limits)
  return match move result {
    Result<IdentityMatch, IdentityError>.Success { value } => match move expected {
      Expected.Match { index } => value.sanIndex == index
      _ => false
    }
    Result<IdentityMatch, IdentityError>.Failure { error } => match move expected {
      Expected.Failure { error: wanted } => sameError(move error, move wanted)
      _ => false
    }
  }
}
fn rejectedReference<'a>(result: Result<ReferenceIdentity<'a>, IdentityError>, reason: NameError) -> bool {
  return match move result {
    Result<ReferenceIdentity<'a>, IdentityError>.Success { value } => false
    Result<ReferenceIdentity<'a>, IdentityError>.Failure { error } => sameError(move error, IdentityError.MalformedReference { reason: reason })
  }
}
fn unsupported<'a>(result: Result<ReferenceIdentity<'a>, IdentityError>, form: UnsupportedForm) -> bool {
  return match move result {
    Result<ReferenceIdentity<'a>, IdentityError>.Success { value } => false
    Result<ReferenceIdentity<'a>, IdentityError>.Failure { error } => sameError(move error, IdentityError.Unsupported { form: form })
  }
}
fn admittedIp<'a>(host: OriginHost<'a>, bytes: &'a [u8]) -> bool {
  let entries: [PresentedIdentity<'a>; 1] = [PresentedIdentity<'a>.Ip { bytes: bytes }]
  let certificate = certificateView(&entries)
  return match move (HttpsIdentity.reference(move host)) {
    Result<ReferenceIdentity<'a>, IdentityError>.Failure { error } => false
    Result<ReferenceIdentity<'a>, IdentityError>.Success { value } => check(&value, &certificate, IdentityLimits.standard(), Expected.Match { index: 0 })
  }
}
fn admittedReference<'a>(bytes: &'a [u8]) -> bool {
  return match move (HttpsIdentity.reference(OriginHost<'a>.Dns { bytes: bytes })) {
    Result<ReferenceIdentity<'a>, IdentityError>.Failure { error } => false
    Result<ReferenceIdentity<'a>, IdentityError>.Success { value } => match move value {
      ReferenceIdentity<'a>.Dns { bytes: found } => {
        if found.length != bytes.length { return false }
        let mut index = usize.ZERO
        while index < bytes.length {
          if found[index] != bytes[index] { return false }
          index = index + usize.ONE
        }
        return true
      }
      _ => false
    }
  }
}
${groups.join('\n')}
effect fn vectors() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut manyOwner = Vector<PresentedIdentity<'static>>.make()
  let mut count = usize.ZERO
  while count < 257 {
    let appended = run Vector<PresentedIdentity<'static>>.append(&mut manyOwner, PresentedIdentity<'static>.Dns { bytes: b"www.example" })
    count = count + usize.ONE
  }
  let many = Vector<PresentedIdentity<'static>>.asSlice(&manyOwner)
  // Unsupported payload semantics are outside the matcher; zero octets exercise byte accounting.
  let paddingOwner = run Bytes.zeroed(65526)
  let padding = Bytes.asSlice(&paddingOwner)
  ${groups.map((_, index) => `let result${index} = cases${index}(many, padding)\nif result${index} != 0 { return result${index} }`).join('\n')}
  ${checks.map((source, index) => source.replace(/return \d+/, `return ${fixtures.length + index + 1}`)).join('\n')}
  return 0
}
effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run (vectors() |> Effect.provideMut<Allocator>(&mut allocator))
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 250 }
pub fn main() -> i32 { return run Effect.catchAll(allocated(), recover) }
`
