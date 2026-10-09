// HMAC RFC4231 cases 1/7: https://www.rfc-editor.org/rfc/rfc4231.txt
// HKDF SHA256 RFC5869 cases 1/3: https://www.rfc-editor.org/rfc/rfc5869.txt
// HKDF SHA384 cases 3/12: https://github.com/C2SP/wycheproof/blob/
// 3fa63dd0344abb611f1fb1d77e119938603ea230/testvectors_v1/hkdf_sha384_test.json
// Supplemental empty/exact-key MACs, SHA384 PRKs, and maximum-output SHA256
// fingerprints were independently computed with CPython 3.14.6 hmac/hashlib,
// OpenSSL 3.6.3. Constants below are committed; no host crypto runs in tests.
// Maximum-output fingerprints were also verified with OpenSSL's HKDF EXPAND_ONLY
// command, independently of the Python expansion loop.
const hmacVectors = [
  {
    bits: 256,
    name: 'RFC4231-1',
    key: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
    message: '4869205468657265',
    expected: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    stream: false,
  },
  {
    bits: 256,
    name: 'RFC4231-7',
    key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    message:
      '5468697320697320612074657374207573696e672061206c6172676572207468616e20626c6f636b2d73697a65206b657920616e642061206c6172676572207468616e20626c6f636b2d73697a6520646174612e20546865206b6579206e6565647320746f20626520686173686564206265666f7265206265696e6720757365642062792074686520484d414320616c676f726974686d2e',
    expected: '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
    stream: true,
  },
  {
    bits: 256,
    name: 'empty',
    key: '',
    message: '',
    expected: 'b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad',
    stream: false,
  },
  {
    bits: 256,
    name: 'exact-block-key',
    key: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
    message: '626f756e64617279',
    expected: '04660fc313657aa3500078e1f2788cc4e328654092b137f946516e4d7a17adae',
    stream: false,
  },
  {
    bits: 384,
    name: 'RFC4231-1',
    key: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
    message: '4869205468657265',
    expected:
      'afd03944d84895626b0825f4ab46907f15f9dadbe4101ec682aa034c7cebc59cfaea9ea9076ede7f4af152e8b2fa9cb6',
    stream: false,
  },
  {
    bits: 384,
    name: 'RFC4231-7',
    key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    message:
      '5468697320697320612074657374207573696e672061206c6172676572207468616e20626c6f636b2d73697a65206b657920616e642061206c6172676572207468616e20626c6f636b2d73697a6520646174612e20546865206b6579206e6565647320746f20626520686173686564206265666f7265206265696e6720757365642062792074686520484d414320616c676f726974686d2e',
    expected:
      '6617178e941f020d351e2f254e8fd32c602420feb0b8fb9adccebb82461e99c5a678cc31e799176d3860e6110c46523e',
    stream: true,
  },
  {
    bits: 384,
    name: 'empty',
    key: '',
    message: '',
    expected:
      '6c1f2ee938fad2e24bd91298474382ca218c75db3d83e114b3d4367776d14d3551289e75e8209cd4b792302840234adc',
    stream: false,
  },
  {
    bits: 384,
    name: 'exact-block-key',
    key: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f',
    message: '626f756e64617279',
    expected:
      '9056cf7bd13ae53f2821ff3f5d2c56b4d062c6c8a67eb9a27ad018cdf4316d744d0676e31381b31069af89c49ec5c1bb',
    stream: false,
  },
]

const hkdfVectors = [
  {
    bits: 256,
    name: 'RFC5869-1',
    salt: '000102030405060708090a0b0c',
    ikm: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
    info: 'f0f1f2f3f4f5f6f7f8f9',
    prk: '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
    expected:
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  },
  {
    bits: 256,
    name: 'RFC5869-3',
    salt: '',
    ikm: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
    info: '',
    prk: '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04',
    expected:
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  },
  {
    bits: 384,
    name: 'Wycheproof-3',
    salt: '',
    ikm: 'a4748031a14d3e6aafe42aa20c568f5f',
    info: '',
    prk: '6763a5d9a158a304108a112e8cf4da5968f354b5ffc4b5c6be0044ad6fd88a26a24d307eab6cec055a3bfdb80916f5f3',
    expected:
      '61c0d2797276f1b789397e5a4be75c961a77bdbad4cca2bd9a4160cb85fafb1b32f95d610c58766f29769d0c68b0bcfb15916d49b72e52ad2f3e7315618175d3',
  },
  {
    bits: 384,
    name: 'Wycheproof-12',
    salt: '08bc01c053a6406c7c4a667c9b9b3894',
    ikm: '7a00817689a3d79001825a864c69c120',
    info: '967ccd75395be6e96a67759f070487c9e2107791',
    prk: '56f25eb6ff0bc91b7f53d89dcd3cbbe72fce0e0c316fd807e4684e3eb059a5c88b620b33ccab38bec4708ac4cf5da9fc',
    expected:
      'bd02e16b6024f2c3b752d1c1d3047583697731915fbbb34418f479b0c9bf84a86bd8e715eca198da8f9b39b25a1229c311853f862340cdefe46ddf41dcf256d9',
  },
]

const maximumVectors = [
  {
    bits: 256,
    prk: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    expected: '414a796ace2e557b89e754b305c92ba4a54060918c02325355e6f42ab44e2ea4',
  },
  {
    bits: 384,
    prk: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f',
    expected: '0c30e4506f9bb1742f86069d0d36fd1fec999bbae96d1ca8221b88a8ab20e500',
  },
]

const bytes = (hex: string): ReadonlyArray<number> =>
  Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  )

const array = (values: ReadonlyArray<number>): string => `[${values.join(', ')}]`
const declaration = (name: string, hex: string): string =>
  `let ${name}: [u8; ${hex.length / 2}] = ${array(bytes(hex))}`
const filled = (length: number, value = 0): string => array(Array.from({ length }, () => value))

const hmacChecks = hmacVectors.map((vector, index) => {
  const actor = `HmacSha${vector.bits}`
  const chunks = [
    vector.message.slice(0, 126),
    vector.message.slice(126, 254),
    vector.message.slice(254),
  ]
  return `fn hmac${index}() -> bool {
  ${declaration('key', vector.key)}
  ${declaration('message', vector.message)}
  ${declaration('expected', vector.expected)}
  let actual = ${actor}.authenticate(&key, &message)
  if !equalBytes(&actual, &expected) { return false }
  ${
    vector.stream
      ? `${chunks.map((chunk, n) => declaration(`chunk${n}`, chunk)).join('\n  ')}
  let empty: [u8; 0] = []
  let mut state = ${actor}.make(&key)
  state.update(&chunk0)
  state.update(&empty)
  state.update(&chunk1)
  state.update(&chunk2)
  let streamed = state.finish()
  return equalBytes(&streamed, &expected)`
      : 'return true'
  }
}`
})

const hkdfChecks = hkdfVectors.map(
  (vector, index) => `fn hkdf${index}() -> bool {
  ${declaration('salt', vector.salt)}
  ${declaration('ikm', vector.ikm)}
  ${declaration('info', vector.info)}
  ${declaration('expectedPrk', vector.prk)}
  ${declaration('expected', vector.expected)}
  let prk = HkdfSha${vector.bits}.extract(&salt, &ikm)
  if !equalBytes(&prk, &expectedPrk) { return false }
  let mut output: [u8; ${vector.expected.length / 2}] = ${filled(vector.expected.length / 2)}
  if !succeeded(HkdfSha${vector.bits}.expand(&prk, &info, &mut output)) { return false }
  return equalBytes(&output, &expected)
}`,
)

// Allocate large buffers at runtime: literal initializers would add 40,802 AST elements.
const maximumChecks = maximumVectors.map((vector) => {
  const maximum = (255 * vector.bits) / 8
  return `effect fn bounds${vector.bits}() -> bool ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  ${declaration('prk', vector.prk)}
  let info: [u8; 5] = [108, 105, 109, 105, 116]
  ${declaration('expectedDigest', vector.expected)}
  let mut outputAllocation = Bytes.zeroed(${maximum}) |> Effect.provideMut(&mut allocator)
  let mut output = run outputAllocation
  if !succeeded(HkdfSha${vector.bits}.expand(&prk, &info, Bytes.asMutSlice(&mut output))) { return false }
  let digest = Sha256.hash(Bytes.asSlice(&output))
  if !equalBytes(&digest, &expectedDigest) { return false }
  let mut empty: [u8; 0] = []
  if !succeeded(HkdfSha${vector.bits}.expand(&prk, &info, &mut empty)) { return false }
  let mut excessiveAllocation = Bytes.zeroed(${maximum + 1}) |> Effect.provideMut(&mut allocator)
  let mut excessive = run excessiveAllocation
  fillSentinel(Bytes.asMutSlice(&mut excessive))
  let result = HkdfSha${vector.bits}.expand(&prk, &info, Bytes.asMutSlice(&mut excessive))
  let rejected = match move result {
    Result<(), OutputTooLongError>.Success { value } => false
    Result<(), OutputTooLongError>.Failure { error } => error.requested == ${maximum + 1} && error.maximum == ${maximum}
  }
  if !rejected { return false }
  return allSentinels(Bytes.asSlice(&excessive))
}`
})

/** One native corpus compilation for independent HMAC/HKDF vectors and distinct boundaries. */
export const hmacHkdfAcceptanceSource = `import silk.hmac { HmacSha256, HmacSha384 }
import silk.hkdf { HkdfSha256, HkdfSha384, OutputTooLongError }
import silk.result { Result }
import silk.sha2 { Sha256 }
import silk.bytes { Bytes }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }

fn fillSentinel(output: &mut [u8]) -> () {
  let mut index: usize = 0
  while index < output.length {
    output[index] = 165
    index = index + 1
  }
}

fn allSentinels(output: &[u8]) -> bool {
  let mut index: usize = 0
  while index < output.length {
    if output[index] != 165 { return false }
    index = index + 1
  }
  return true
}

fn equalBytes(actual: &[u8], expected: &[u8]) -> bool {
  if actual.length != expected.length { return false }
  let mut index: usize = 0
  while index < actual.length {
    if actual[index] != expected[index] { return false }
    index = index + 1
  }
  return true
}

fn succeeded(result: Result<(), OutputTooLongError>) -> bool {
  return match move result {
    Result<(), OutputTooLongError>.Success { value } => true
    Result<(), OutputTooLongError>.Failure { error } => false
  }
}

${[...hmacChecks, ...hkdfChecks, ...maximumChecks].join('\n\n')}

effect fn verify() -> i32 ! OutOfMemoryError {
${hmacVectors.map((_, index) => `  if !hmac${index}() { return ${index + 1} }`).join('\n')}
${hkdfVectors.map((_, index) => `  if !hkdf${index}() { return ${index + 20} }`).join('\n')}
  let valid256 = run bounds256()
  if !valid256 { return 30 }
  let valid384 = run bounds384()
  if !valid384 { return 31 }
  return 42
}

effect fn allocationFailure(error: OutOfMemoryError) -> i32 { return 32 }

pub fn main() -> i32 {
  return run Effect.catchAll(verify(), allocationFailure)
}`
