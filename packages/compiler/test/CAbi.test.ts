import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as MirVerification from '../src/MirVerification.js'
import { unreachable } from './support/raise.js'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Analysis from '../src/Analysis.js'
import * as ForeignContract from '../src/ForeignContract.js'
import * as SemanticDisplay from '../src/SemanticDisplay.js'
import { assert, it } from '@effect/vitest'
import * as AbiManifest from '../src/AbiManifest.js'
import type * as Backend from '../src/Backend.js'
import * as CAbi from '../src/CAbi.js'
import * as CHeader from '../src/CHeader.js'
import * as CLayout from '../src/CLayout.js'
import * as ForeignSymbol from '../src/ForeignSymbol.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Target from '../src/Target.js'
import * as Type from '../src/Type.js'
import * as ModuleSurface from '../src/ModuleSurface.js'

const admitted: ReadonlyArray<readonly [Type.Builtin, string]> = [
  ['i8', 'i8'],
  ['u8', 'u8'],
  ['i16', 'i16'],
  ['u16', 'u16'],
  ['i32', 'i32'],
  ['u32', 'u32'],
  ['i64', 'i64'],
  ['u64', 'u64'],
  ['isize', 'i64'],
  ['usize', 'u64'],
  ['f32', 'f32'],
  ['f64', 'f64'],
]

const rejected: ReadonlyArray<readonly [string, Type.Type]> = [
  [
    'invalid pointer alignment',
    Type.pointer({
      mutable: false,
      pointee: 'i32',
      nullable: false,
      extent: 'Single',
      alignment: 3,
      addressSpace: 0,
    }),
  ],
  ['bool', 'bool'],
  ['char', 'char'],
  ['string', Type.string(Lifetime.staticLifetime)],
  ['reference', Type.reference('Shared', 'i32', Lifetime.staticLifetime)],
  ['slice', Type.slice('Shared', 'u8', Lifetime.staticLifetime)],
  ['struct', Type.nominal('app/main', 'Point')],
  ['type parameter', Type.parameter({ module: 'app/main', name: 'f' }, 0, 'T')],
]

it('admits exactly the non-nominal C-layout field vocabulary', () => {
  const resolveNothing: CLayout.ResolveStruct = () => undefined
  const acceptedFields: ReadonlyArray<Type.Type> = [
    ...admitted.map(([type]) => type),
    Type.pointer({
      mutable: false,
      pointee: Type.string(Lifetime.staticLifetime),
      nullable: false,
      extent: 'Single',
      alignment: 'Natural',
      addressSpace: 0,
    }),
    Type.pointer({
      mutable: true,
      pointee: Type.nominal('app/main', 'Opaque'),
      nullable: false,
      extent: 'Single',
      alignment: 'Natural',
      addressSpace: 0,
    }),
    Type.fixedArray('u16', 3),
    Type.fixedArray(Type.fixedArray('f64', 2), 4),
  ]
  const rejectedFields: ReadonlyArray<readonly [Type.Type, CLayout.RejectionReason]> = [
    ['bool', 'UnsupportedType'],
    ['char', 'UnsupportedType'],
    [Type.string(Lifetime.staticLifetime), 'UnsupportedType'],
    [Type.unit, 'UnknownRecord'],
    [Type.reference('Shared', 'i32', Lifetime.staticLifetime), 'UnsupportedType'],
    [Type.slice('Shared', 'u8', Lifetime.staticLifetime), 'UnsupportedType'],
    [Type.fixedArray('u8', 0), 'ZeroLengthArray'],
    [Type.fixedArray('bool', 2), 'UnsupportedType'],
  ]

  for (const type of acceptedFields) {
    assert.strictEqual(CLayout.admit(type, resolveNothing)._tag, 'Admitted', Type.encode(type))
  }
  for (const [type, reason] of rejectedFields) {
    const admission = CLayout.admit(type, resolveNothing)
    assert.strictEqual(admission._tag, 'NotAdmitted', Type.encode(type))
    if (admission._tag === 'NotAdmitted') assert.strictEqual(admission.reason, reason)
  }
})

it('admits every V1 scalar as parameter and result and classifies it on a 64-bit target', () => {
  for (const [spelling, text] of admitted) {
    assert.strictEqual(CAbi.admit(spelling, 'Parameter')._tag, 'Admitted', spelling)
    assert.strictEqual(CAbi.admit(spelling, 'Result')._tag, 'Admitted', spelling)
    assert.strictEqual(
      CAbi.typeText(CAbi.classify(spelling, Target.aarch64AppleDarwin, 'Parameter')),
      text,
    )
  }
})

it('rejects every non-scalar spelling with the offending type', () => {
  for (const [label, type] of rejected) {
    assert.deepEqual(
      CAbi.admit(type, 'Parameter'),
      { _tag: 'NotAdmitted', type, position: 'Parameter' },
      label,
    )
    assert.strictEqual(CAbi.admit(type, 'Result')._tag, 'NotAdmitted', label)
    assert.throws(() => CAbi.classify(type, Target.aarch64AppleDarwin, 'Parameter'), RangeError)
  }
})

it('admits unit only as a result', () => {
  assert.strictEqual(CAbi.admit(Type.unit, 'Result')._tag, 'Admitted')
  assert.strictEqual(CAbi.admit(Type.unit, 'Parameter')._tag, 'NotAdmitted')
  assert.deepEqual(CAbi.classify(Type.unit, Target.aarch64AppleDarwin, 'Result'), { _tag: 'Void' })
  assert.throws(() => CAbi.classify(Type.unit, Target.aarch64AppleDarwin, 'Parameter'), RangeError)
})

it('classifies pointer-width integers by the selected target', () => {
  assert.deepEqual(CAbi.classify('usize', Target.wasm32UnknownUnknown, 'Parameter'), {
    _tag: 'Integer',
    bits: 32,
    signed: false,
    extension: 'None',
  })
  assert.deepEqual(CAbi.classify('isize', Target.aarch64AppleDarwin, 'Parameter'), {
    _tag: 'Integer',
    bits: 64,
    signed: true,
    extension: 'None',
  })
})

it('produces a stable canonical signature key', () => {
  const native = CAbi.signature(['i32', 'usize'], 'f64', Target.aarch64AppleDarwin)
  assert.strictEqual(
    CAbi.signatureKey(native),
    '(i32,u64)->f64!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
  )
  assert.strictEqual(
    CAbi.signatureKey(CAbi.signature(['i32', 'usize'], 'f64', Target.wasm32UnknownUnknown)),
    '(i32,u32)->f64!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
  )
  assert.strictEqual(
    CAbi.signatureKey(CAbi.signature([], Type.unit, Target.x8664UnknownLinuxGnu)),
    '()->void!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
  )
  assert.strictEqual(
    CAbi.signatureKey(CAbi.signature(['i32', 'u64'], 'f64', Target.x8664UnknownLinuxGnu)),
    CAbi.signatureKey(native),
  )
})

const pointers: ReadonlyArray<readonly [string, Type.Pointer]> = [
  [
    '*const u8',
    Type.pointer({
      mutable: false,
      pointee: 'u8',
      nullable: false,
      extent: 'Single',
      alignment: 'Natural',
      addressSpace: 0,
    }),
  ],
  [
    '*mut u8',
    Type.pointer({
      mutable: true,
      pointee: 'u8',
      nullable: false,
      extent: 'Single',
      alignment: 'Natural',
      addressSpace: 0,
    }),
  ],
  [
    '*mut Opaque',
    Type.pointer({
      mutable: true,
      pointee: Type.nominal('app/main', 'Opaque'),
      nullable: false,
      extent: 'Single',
      alignment: 'Natural',
      addressSpace: 0,
    }),
  ],
  [
    '*const Vector<i32>',
    Type.pointer({
      mutable: false,
      pointee: Type.nominal('silk/vector', 'Vector', ['i32']),
      nullable: false,
      extent: 'Single',
      alignment: 'Natural',
      addressSpace: 0,
    }),
  ],
]

it('admits a pointer of any pointee in both positions without examining the pointee', () => {
  for (const [spelling, type] of pointers) {
    assert.strictEqual(CAbi.admit(type, 'Parameter')._tag, 'Admitted', spelling)
    assert.strictEqual(CAbi.admit(type, 'Result')._tag, 'Admitted', spelling)
    assert.deepEqual(
      CAbi.classify(type, Target.aarch64AppleDarwin, 'Result'),
      { _tag: 'Pointer', type },
      spelling,
    )
    assert.strictEqual(
      CAbi.typeText(CAbi.classify(type, Target.wasm32UnknownUnknown, 'Parameter')),
      `pointer<${type.mutable ? 'mut' : 'const'};${encodeURIComponent(Type.runtimeKey(type))}>`,
      spelling,
    )
  }
  // The pointee stays unexamined: a pointer to a rejected pointee is still admitted.
  for (const [label, type] of rejected) {
    assert.strictEqual(
      CAbi.admit(
        Type.pointer({
          mutable: false,
          pointee: type,
          nullable: false,
          extent: 'Single',
          alignment: 'Natural',
          addressSpace: 0,
        }),
        'Parameter',
      )._tag,
      'Admitted',
      label,
    )
  }
})

it('keys pointer mutability so `*const u8` and `*mut u8` name different signatures', () => {
  const constKey = CAbi.signatureKey(
    CAbi.signature(
      [
        Type.pointer({
          mutable: false,
          pointee: 'u8',
          nullable: false,
          extent: 'Single',
          alignment: 'Natural',
          addressSpace: 0,
        }),
        'usize',
      ],
      'i32',
      Target.aarch64AppleDarwin,
    ),
  )
  const mutKey = CAbi.signatureKey(
    CAbi.signature(
      [
        Type.pointer({
          mutable: true,
          pointee: 'u8',
          nullable: false,
          extent: 'Single',
          alignment: 'Natural',
          addressSpace: 0,
        }),
        'usize',
      ],
      'i32',
      Target.aarch64AppleDarwin,
    ),
  )
  assert.strictEqual(
    constKey,
    '(pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>,u64)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
  )
  assert.strictEqual(
    mutKey,
    '(pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>,u64)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
  )
  assert.notStrictEqual(constKey, mutKey)
  assert.strictEqual(
    CAbi.signatureKey(
      CAbi.signature(
        ['usize'],
        Type.pointer({
          mutable: true,
          pointee: 'u8',
          nullable: false,
          extent: 'Single',
          alignment: 'Natural',
          addressSpace: 0,
        }),
        Target.x8664UnknownLinuxGnu,
      ),
    ),
    '(u64)->pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
  )
  // Physical pointer lanes agree, while source pointee identities remain distinct contracts.
  assert.notStrictEqual(
    CAbi.signatureKey(
      CAbi.signature(
        [
          Type.pointer({
            mutable: true,
            pointee: Type.nominal('app/main', 'Opaque'),
            nullable: false,
            extent: 'Single',
            alignment: 'Natural',
            addressSpace: 0,
          }),
        ],
        Type.unit,
        Target.aarch64AppleDarwin,
      ),
    ),
    CAbi.signatureKey(
      CAbi.signature(
        [
          Type.pointer({
            mutable: true,
            pointee: 'u8',
            nullable: false,
            extent: 'Single',
            alignment: 'Natural',
            addressSpace: 0,
          }),
        ],
        Type.unit,
        Target.aarch64AppleDarwin,
      ),
    ),
  )
})

it('admits recursively C-compatible function pointers and keys their full signature', () => {
  const compare = Type.foreignFunction(
    [
      Type.pointer({
        mutable: false,
        pointee: 'i32',
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
      Type.pointer({
        mutable: false,
        pointee: 'i32',
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ],
    'i32',
  )
  assert.strictEqual(CAbi.admit(compare, 'Parameter')._tag, 'Admitted')
  assert.strictEqual(
    CAbi.typeText(CAbi.classify(compare, Target.aarch64AppleDarwin, 'Parameter')),
    'extern "C" fn(pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A011%3Abuiltin%3Ai32>,pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A011%3Abuiltin%3Ai32>)->i32!nonnull:readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
  )
  assert.strictEqual(
    CAbi.signatureKey(
      CAbi.signature([compare, 'usize'], Type.unit, Target.aarch64AppleDarwin, {
        ...ForeignContract.conservative,
        callbacks: [0],
      }),
    ),
    '(extern "C" fn(pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A011%3Abuiltin%3Ai32>,pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A011%3Abuiltin%3Ai32>)->i32!nonnull:readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden,u64)->void!readwrite/external/capture:/borrow:/callbacks:0/returned:-/noreturn:false/unwind:forbidden',
  )

  const invalidParameter = Type.foreignFunction([Type.unit], 'i32')
  const invalidResult = Type.foreignFunction(['i32'], 'bool')
  assert.strictEqual(CAbi.admit(invalidParameter, 'Parameter')._tag, 'NotAdmitted')
  assert.strictEqual(CAbi.admit(invalidResult, 'Parameter')._tag, 'NotAdmitted')
})

it('renders one exact canonical header for scalars, pointers, nested callbacks, and empty arity', () => {
  const functions: ReadonlyArray<Backend.ForeignExport> = [
    {
      variadic: false,
      symbol: 'visit',
      parameters: [
        'pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
        'pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
        'extern "C" fn(i32,pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>)->u8!nonnull:readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
      ],
      result:
        'extern "C" fn(u64)->i32!nonnull:readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
      contract: { ...ForeignContract.conservative, callbacks: [2] },
    },
    {
      variadic: false,
      symbol: 'answer',
      parameters: [],
      result: 'i32',
      contract: ForeignContract.conservative,
    },
  ]
  const data: ReadonlyArray<Backend.ForeignStatic> = [
    {
      symbol: 'callback_slot',
      type: 'extern "C" fn(i16)->u16!nonnull:readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
      direction: 'Export',
    },
    {
      symbol: 'mutable_state',
      type: 'pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
      direction: 'Export',
    },
    { symbol: 'silk_abi_version', type: 'u32', direction: 'Export' },
    {
      symbol: 'host_state',
      type: 'pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
      direction: 'Import',
    },
  ]
  const header = CHeader.make('answer-kit', functions, data)
  const expected = [
    '#ifndef SILK_ANSWER_KIT_H',
    '#define SILK_ANSWER_KIT_H',
    '',
    '#include <stdint.h>',
    '',
    '#ifdef __cplusplus',
    'extern "C" {',
    '#endif',
    '',
    'int32_t answer(void);',
    'extern uint16_t (*const callback_slot)(int16_t arg0);',
    'extern void *const mutable_state;',
    'extern const uint32_t silk_abi_version;',
    'int32_t (*visit(const void *arg0, void *arg1, uint8_t (*arg2)(int32_t arg0, const void *arg1)))(uint64_t arg0);',
    '',
    '#ifdef __cplusplus',
    '}',
    '#endif',
    '',
    '#endif /* SILK_ANSWER_KIT_H */',
    '',
  ].join('\n')
  assert.strictEqual(CHeader.render(header), expected)
  assert.deepStrictEqual(CHeader.encode(header), new TextEncoder().encode(expected))
})

it('encodes exact target-qualified ABI manifests for Darwin and Linux', () => {
  const exports: ReadonlyArray<Backend.ForeignExport> = [
    {
      variadic: false,
      symbol: 'answer',
      parameters: [],
      result: 'i32',
      contract: ForeignContract.conservative,
    },
  ]
  const data: ReadonlyArray<Backend.ForeignStatic> = [
    { symbol: 'silk_abi_version', type: 'u32', direction: 'Export' },
    {
      symbol: 'host_state',
      type: 'pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
      direction: 'Import',
    },
  ]
  for (const target of [Target.aarch64AppleDarwin, Target.x8664UnknownLinuxGnu]) {
    const pointerWidth = CAbi.typeText(CAbi.classify('usize', target, 'Parameter'))
    const imports: ReadonlyArray<Backend.ForeignImport> = [
      {
        variadic: false,
        symbol: 'host_log',
        parameters: [
          'pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
          pointerWidth,
        ],
        result: 'void',
        contract: ForeignContract.conservative,
      },
    ]
    const manifest = AbiManifest.make(target, imports, exports, data)
    const expected = `${JSON.stringify(
      {
        silkForeignAbi: 4,
        target: target.id,
        exports: [
          {
            kind: 'function',
            symbol: 'answer',
            abi: 'C',
            direction: 'export',
            parameters: [],
            result: 'i32',
            contract: ForeignContract.conservative,
            variadic: false,
          },
          {
            kind: 'data',
            symbol: 'silk_abi_version',
            abi: 'C',
            direction: 'export',
            type: 'u32',
          },
        ],
        imports: [
          {
            kind: 'function',
            symbol: 'host_log',
            abi: 'C',
            direction: 'import',
            parameters: [
              'pointer<const;7%3APointer30%3ASingle%3Aconst%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
              pointerWidth,
            ],
            result: 'void',
            contract: ForeignContract.conservative,
            variadic: false,
          },
          {
            kind: 'data',
            symbol: 'host_state',
            abi: 'C',
            direction: 'import',
            type: 'pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
          },
        ],
      },
      null,
      2,
    )}\n`
    assert.strictEqual(AbiManifest.render(manifest), expected)
    assert.deepStrictEqual(AbiManifest.encode(manifest), new TextEncoder().encode(expected))
  }
})

it('validates native symbol spelling', () => {
  for (const symbol of ['abs', '_start', 'silk_test_add', 'A1', 'close$NOCANCEL', 'host$v2']) {
    assert.isTrue(ForeignSymbol.isValidSpelling(symbol), symbol)
  }
  for (const symbol of ['', '1abc', '$leading', 'not a symbol', 'a-b', 'a\0b', '_abs\n', 'ünï']) {
    assert.isFalse(ForeignSymbol.isValidSpelling(symbol), JSON.stringify(symbol))
  }
})

it.effect('round-trips dollar-bearing function and data ABI catalog entries', () =>
  Effect.gen(function* () {
    const manifest = AbiManifest.make(
      Target.aarch64AppleDarwin,
      [
        {
          variadic: false,
          symbol: 'close$NOCANCEL',
          parameters: ['i32'],
          result: 'i32',
          contract: ForeignContract.conservative,
        },
      ],
      [
        {
          variadic: false,
          symbol: 'host$answer',
          parameters: [],
          result: 'i32',
          contract: ForeignContract.conservative,
        },
      ],
      [
        { symbol: 'host$data', type: 'i32', direction: 'Import' },
        { symbol: 'silk$data', type: 'i32', direction: 'Export' },
      ],
    )
    const source = SourceFile.make('interfaces/dollar.json', AbiManifest.encode(manifest))
    const decoded = yield* AbiManifest.decode(source)
    assert.deepEqual(decoded.manifest, manifest)

    for (const [name, symbol] of [
      ['leading-dollar', '$leading'],
      ['whitespace', 'not a symbol'],
      ['nul', 'a\0b'],
      ['non-ascii', 'ünï'],
    ] as const) {
      const invalid = {
        ...manifest,
        imports: manifest.imports.map((entry, index) =>
          index === 0 ? { ...entry, symbol } : entry,
        ),
      }
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(invalid)
      const rejected = yield* Effect.result(
        AbiManifest.decode(
          SourceFile.make(`interfaces/invalid-${name}.json`, new TextEncoder().encode(encoded)),
        ),
      )
      assert.strictEqual(rejected._tag, 'Failure', name)
      if (rejected._tag === 'Failure') assert.strictEqual(rejected.failure.code, 'SEM0188')
    }
  }),
)

it('reserves compiler symbols and admits ordinary source entry names', () => {
  for (const symbol of [
    '__silk_foreign_personality',
    'silk_suspend_child_0',
    'silk_app_main_run__1',
  ]) {
    assert.isTrue(ForeignSymbol.isReserved(symbol), symbol)
  }
  for (const symbol of [
    'main',
    'abs',
    'malloc',
    'silk_test_add',
    'silky_main',
    'silk_main',
    'main2',
    'suspend_x',
  ]) {
    assert.isFalse(ForeignSymbol.isReserved(symbol), symbol)
  }
  assert.isTrue(ForeignSymbol.reservedSymbols.every(ForeignSymbol.isReserved))
})

it('classifies and verifies narrow integer extensions from the selected C ABI', () => {
  for (const target of Target.native) {
    const sign = CAbi.classify('i8', target, 'Parameter')
    const zero = CAbi.classify('u16', target, 'Result')
    const extended = target.id !== 'aarch64-unknown-linux-gnu'
    assert.deepEqual(sign, {
      _tag: 'Integer',
      bits: 8,
      signed: true,
      extension: extended ? 'Sign' : 'None',
    })
    assert.deepEqual(zero, {
      _tag: 'Integer',
      bits: 16,
      signed: false,
      extension: extended ? 'Zero' : 'None',
    })
    assert.strictEqual(CAbi.isCanonical(sign, target), true)
    assert.strictEqual(
      CAbi.isCanonical(
        { _tag: 'Integer', bits: 8, signed: true, extension: extended ? 'None' : 'Sign' },
        target,
      ),
      false,
    )
  }
})

it.effect('checks explicit foreign behavior and complete-call reference loans', () =>
  Effect.gen(function* () {
    const source = `
unsafe extern "C" fn ordinary(p: *mut i32) -> i32
unsafe extern "C" fn inspect(p: &i32) -> i32 with Intrinsic.foreign(memory: "read", locality: "arguments", borrow: ("p",))
unsafe extern "C" fn alias(p: *mut i32) -> *mut i32 with Intrinsic.foreign(returned: "p")
unsafe extern "C" fn same(q: &i32) -> i32 as "inspect" with Intrinsic.foreign(borrow: ("q",), locality: "arguments", memory: "read")
pub fn main() -> i32 {
  let value = 42
  unsafe { if inspect(&value) != 42 || same(&value) != 42 { return 1 } return value }
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'contracts/valid',
      new TextEncoder().encode(source),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const declarations =
      Analysis.declarationIndex(snapshot).modules.find(
        (module) => module.module === 'contracts/valid',
      )?.declarations ?? []
    assert.deepEqual(
      declarations.find((fn) => fn.name._tag === 'Present' && fn.name.spelling === 'ordinary')
        ?.foreign?.contract,
      ForeignContract.conservative,
    )
    const inspect = declarations.find(
      (fn) => fn.name._tag === 'Present' && fn.name.spelling === 'inspect',
    )
    assert.deepEqual(inspect?.foreign?.contract.borrow, [0])
    assert.strictEqual(inspect?.foreign?.contract.memory, 'read')
    if (inspect !== undefined)
      assert.include(SemanticDisplay.functionDeclaration(inspect).text, 'borrow: ("p",)')
    const call = Analysis.instancesOf(snapshot).foreignCalls[0]
    assert.deepEqual(call?.signature.contract.borrow, [0])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    const invocation =
      artifact.ir.split('\n').find((line) => line.includes('invoke i32 @inspect(ptr ')) ??
      unreachable('expected the unwinding foreign read call')
    assert.include(invocation, 'nofree')
    assert.include(invocation, 'readonly')
    assert.include(invocation, 'captures(none)')
    assert.include(artifact.ir, 'memory(argmem: read)')
    assert.notMatch(artifact.ir, /declare i32 @inspect[^\n]*nounwind/)
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const manifest = AbiManifest.make(Target.aarch64AppleDarwin, artifact.foreignImports, [], [])
    const manifestSource = SourceFile.make('interfaces/valid.json', AbiManifest.encode(manifest))
    const supplied = yield* AbiManifest.decode(manifestSource)
    assert.deepEqual(AbiManifest.check([supplied], program), [])
    const mismatched = AbiManifest.make(
      Target.aarch64AppleDarwin,
      artifact.foreignImports.map((entry) => ({
        ...entry,
        contract: { ...entry.contract, memory: 'readwrite' },
      })),
      [],
      [],
    )
    const other = yield* AbiManifest.decode(
      SourceFile.make('interfaces/mismatch.json', AbiManifest.encode(mismatched)),
    )
    const conflict =
      AbiManifest.check([other], program).at(0) ?? unreachable('expected interface mismatch')
    assert.strictEqual(conflict.code, 'SEM0192')
    assert.strictEqual(conflict.span.sourceId, 'interfaces/mismatch.json')
    assert.strictEqual(conflict.relatedSpans?.at(0)?.span.sourceId, 'contracts/valid')
    for (const rejected of [
      { ...manifest, silkForeignAbi: 1 },
      { ...manifest, untrustedPolicy: true },
      {
        ...manifest,
        imports: manifest.imports.map((entry) => ({
          ...entry,
          contract: { ...ForeignContract.conservative, retained: true },
        })),
      },
    ]) {
      const rejectedSource = SourceFile.make(
        'interfaces/rejected.json',
        new TextEncoder().encode(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(rejected),
        ),
      )
      const error = yield* Effect.flip(AbiManifest.decode(rejectedSource))
      assert.strictEqual(error.code, 'SEM0188')
      assert.deepEqual(
        [error.span.sourceId, error.span.start, error.span.end],
        [rejectedSource.id, 0, rejectedSource.bytes.length],
      )
    }
  }),
)

it.effect('rejects capture-capable references and incompatible complete-call loans', () =>
  Effect.gen(function* () {
    for (const [name, source, code] of [
      ['capture', 'unsafe extern "C" fn capture(p: &i32) -> ()', 'SEM0187'],
      ['owner', 'unsafe extern "C" fn f() -> () with Other.foreign(memory: "none")', 'SEM0188'],
      [
        'duplicate',
        'unsafe extern "C" fn f() -> () with Intrinsic.foreign(memory: "none", memory: "read")',
        'SEM0188',
      ],
      [
        'parameter',
        'unsafe extern "C" fn f(p: *mut i32) -> () with Intrinsic.foreign(noCapture: ("missing",))',
        'SEM0188',
      ],
      [
        'scalar',
        'unsafe extern "C" fn f(p: i32) -> () with Intrinsic.foreign(noCapture: ("p",))',
        'SEM0188',
      ],
      [
        'raw-borrow',
        'unsafe extern "C" fn f(p: *mut i32) -> () with Intrinsic.foreign(borrow: ("p",))',
        'SEM0188',
      ],
      [
        'reference-result',
        'unsafe extern "C" fn f(p: &i32) -> &i32 with Intrinsic.foreign(borrow: ("p",))',
        'SEM0187',
      ],
      [
        'noreturn',
        'unsafe extern "C" fn f() -> i32 with Intrinsic.foreign(noReturn: true)',
        'SEM0188',
      ],
      [
        'retained',
        'unsafe extern "C" fn f() -> () with Intrinsic.foreign(retained: true)',
        'SEM0188',
      ],
      ['nonforeign', 'fn f() -> () with Intrinsic.foreign(memory: "none") {}', 'SEM0188'],

      [
        'alias',
        'unsafe extern "C" fn alias(p: *mut i32) -> *mut i32 with Intrinsic.foreign(noCapture: ("p",), returned: "p")',
        'SEM0188',
      ],
      [
        'field',
        'unsafe extern "C" fn bad() -> () with Intrinsic.foreign(unwind: "native")',
        'SEM0188',
      ],
      [
        'loan',
        `unsafe extern "C" fn touch(a: &mut i32, b: &i32) -> () with Intrinsic.foreign(borrow: ("a", "b"))
        pub fn main() -> i32 { let mut value = 1 unsafe { touch(&mut value, &value) } return value }`,
        'OWN0010',
      ],
    ] as const) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        `contracts/${name}`,
        new TextEncoder().encode(source),
        'aarch64-apple-darwin',
      )
      const diagnostic =
        Analysis.diagnostics(snapshot).find((diagnostic) => diagnostic.code === code) ??
        unreachable(`expected ${code}`)
      assert.strictEqual(diagnostic.span.sourceId, `contracts/${name}`)
      assert.isAbove(diagnostic.span.end, diagnostic.span.start)
      assert.isAtMost(diagnostic.span.end, new TextEncoder().encode(source).length)
    }
  }),
)

it.effect('preserves callback behavior through addresses, indirect loans, and interfaces', () =>
  Effect.gen(function* () {
    const source = `
unsafe export "C" fn read<'a>(value: &'a i32) -> i32
  with Intrinsic.foreign(memory: "read", locality: "arguments", borrow: ("value",)) { return value.* }
fn invoke(callback: for<'b> extern "C" fn(&'b i32) -> i32 with Intrinsic.foreign(borrow: ("0",), locality: "arguments", memory: "read"), value: &i32) -> i32 {
  return unsafe callback(value)
}
fn independent(callback: extern "C" fn(&mut i32, &i32) -> () with Intrinsic.foreign(borrow: ("0", "1"))) {
  let mut value = 1
  let other = 2
  unsafe callback(&mut value, &other)
}
pub fn main() -> i32 { let value = 42 return invoke(read, &value) }
`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'callbacks/valid',
      new TextEncoder().encode(source),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const operations = program.functions.flatMap(MirVerification.operations)
    const indirect = operations.find((operation) => operation._tag === 'ForeignIndirectCall')
    assert.isDefined(indirect)
    if (indirect?._tag !== 'ForeignIndirectCall') return
    assert.deepEqual(indirect.signature.contract.borrow, [0])
    assert.strictEqual(indirect.signature.contract.locality, 'arguments')
    const pointer = Type.foreignFunction(
      [Type.reference('Shared', 'i32', Lifetime.staticLifetime)],
      'i32',
      indirect.signature.contract,
    )
    const decoded = yield* ModuleSurface.decodeSemanticType(
      ModuleSurface.encodeSemanticType(pointer),
    )
    assert.strictEqual(Type.key(decoded), Type.key(pointer))
    const changed = Type.foreignFunction(pointer.parameters, pointer.result, {
      ...pointer.contract,
      memory: 'readwrite',
    })
    assert.strictEqual(Type.equals(pointer, changed), false)
    for (const invalid of [
      Type.foreignFunction(
        [
          Type.pointer({
            mutable: false,
            pointee: 'i32',
            nullable: false,
            extent: 'Single',
            alignment: 'Natural',
            addressSpace: 0,
          }),
        ],
        'i32',
        pointer.contract,
      ),
      Type.foreignFunction([Type.foreignFunction([], 'i32'), ...pointer.parameters], 'i32', {
        ...pointer.contract,
        callbacks: [0],
        borrow: [1],
      }),
    ]) {
      const error = yield* Effect.flip(
        ModuleSurface.decodeSemanticType(ModuleSurface.encodeSemanticType(invalid)),
      )
      assert.strictEqual(error._tag, 'ModuleSurfaceDecodeError')
    }
    const canonical = CAbi.typeText(
      CAbi.classify(
        Type.foreignFunction(
          [
            Type.pointer({
              mutable: false,
              pointee: 'i32',
              nullable: false,
              extent: 'Single',
              alignment: 'Natural',
              addressSpace: 0,
            }),
          ],
          'i32',
          {
            ...ForeignContract.conservative,
            noCapture: [0],
          },
        ),
        Target.aarch64AppleDarwin,
        'Parameter',
      ),
    )
    assert.isTrue(CAbi.isTypeText(canonical))
    assert.isFalse(CAbi.isTypeText(canonical.replace('capture:0/', 'capture:00/')))

    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.match(artifact.ir, /invoke i32 %[^ (]+\(ptr/)
    assert.include(artifact.ir, 'foreign_unwind')
    const manifest = AbiManifest.make(
      Target.aarch64AppleDarwin,
      artifact.foreignImports,
      artifact.foreignExports,
      [],
    )
    const supplied = yield* AbiManifest.decode(
      SourceFile.make('callbacks/interface.json', AbiManifest.encode(manifest)),
    )
    assert.deepEqual(AbiManifest.check([supplied], program), [])
  }),
)

it.effect('rejects unadmitted callback promises and conflicting nested reference access', () =>
  Effect.gen(function* () {
    const programs = [
      ['escape', 'unsafe extern "C" fn register(callback: extern "C" fn() -> ()) -> ()', 'SEM0188'],
      [
        'thread',
        'unsafe extern "C" fn f() -> () with Intrinsic.foreign(thread: "other")',
        'SEM0188',
      ],
      [
        'unwind',
        'fn f(callback: extern "C" fn() -> () with Intrinsic.foreign(unwind: "permitted")) {}',
        'SEM0188',
      ],
      [
        'stronger',
        `export "C" fn read(value: *const i32) -> i32 { return 0 }
unsafe extern "C" fn visit(callback: extern "C" fn(*const i32) -> i32 with Intrinsic.foreign(memory: "read", locality: "arguments")) -> () with Intrinsic.foreign(callbacks: ("callback",))
pub fn main() { unsafe visit(read) }`,
        'SEM0207',
      ],
      [
        'machine',
        `unsafe export "C" fn entry() -> () with Intrinsic.machine(naked: true, noReturn: true) {
  return unsafe Intrinsic.assembly<()>("ud2", "", "", "none", true, true, ())
}
unsafe extern "C" fn visit(callback: extern "C" fn() -> ()) -> () with Intrinsic.foreign(callbacks: ("callback",))
pub fn main() { unsafe visit(entry) }`,
        'SEM0207',
      ],
      [
        'external',
        'unsafe extern "C" fn visit(value: &mut i32, callback: extern "C" fn() -> ()) -> () with Intrinsic.foreign(borrow: ("value",), callbacks: ("callback",))',
        'SEM0188',
      ],
      [
        'loan',
        `fn nested(callback: extern "C" fn(&mut i32, &i32) -> () with Intrinsic.foreign(borrow: ("0", "1"))) {
  let mut value = 1
  unsafe callback(&mut value, &value)
}`,
        'OWN0010',
      ],
      [
        'unsafe',
        'fn invoke(callback: extern "C" fn() -> i32) -> i32 { return callback() }',
        'SEM0082',
      ],
    ] as const
    for (const [name, source, code] of programs) {
      const snapshot =
        name === 'machine'
          ? yield* Analysis.makeRealized({
              root: `callbacks/${name}`,
              configuration: {
                profile: {
                  target: 'x86_64-unknown-linux-gnu',
                  artifact: 'object',
                  runtime: { kind: 'none' },
                },
              },
            }).pipe(
              Effect.provide(
                SourceResolver.overlay([
                  SourceFile.make(`callbacks/${name}`, new TextEncoder().encode(source)),
                ]).pipe(Layer.provideMerge(SourceResolver.empty)),
              ),
            )
          : yield* AnalysisFixture.declarations(
              `callbacks/${name}`,
              new TextEncoder().encode(source),
              'aarch64-apple-darwin',
            )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.deepEqual([...new Set(diagnostics.map((diagnostic) => diagnostic.code))], [code], name)
      if (name === 'machine') {
        assert.deepEqual(
          diagnostics.map((diagnostic) => diagnostic.code),
          ['SEM0207'],
        )
        const diagnostic = diagnostics.at(0)
        if (diagnostic !== undefined)
          assert.strictEqual(source.slice(diagnostic.span.start, diagnostic.span.end), 'entry')
      }
      for (const diagnostic of diagnostics) {
        assert.strictEqual(diagnostic.span.sourceId, `callbacks/${name}`)
        assert.isAbove(diagnostic.span.end, diagnostic.span.start)
      }
    }
  }),
)

it.effect('keeps one variadic declaration and promotes integer tails per call', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'variadic/promotions',
      new TextEncoder().encode(`
unsafe extern "C" fn receive(tag: i32, ...) -> i32
pub fn main() -> i32 {
  let a: i8 = -7
  let b: u8 = 255
  let c: u16 = 65535
  let d: u32 = 4000000000
  let first = unsafe receive(0)
  let second = unsafe receive(1, a, b, c, d)
  return first + second + unsafe receive(2, 42)
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const declarations = Analysis.instancesOf(snapshot).foreignCalls
    assert.strictEqual(declarations.length, 1)
    assert.strictEqual(declarations[0]?.signature.variadic, true)
    assert.strictEqual(declarations[0]?.signature.parameters.length, 1)
    const program = Analysis.loweredMir(snapshot)
    const calls = program.functions
      .flatMap((fn) => MirVerification.operations(fn))
      .filter((operation) => operation._tag === 'ForeignCall')
    assert.deepEqual(
      calls.map((call) =>
        call.variadicArguments.map((argument) => CAbi.typeText(argument.promoted)),
      ),
      [[], ['i32', 'i32', 'i32', 'u32'], ['i32']],
    )
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.include(artifact.ir, 'declare i32 @receive(i32, ...)')
    assert.include(artifact.ir, 'invoke i32 (i32, ...) @receive')
    assert.strictEqual(artifact.foreignImports.length, 1)
    assert.strictEqual(artifact.foreignImports[0]?.variadic, true)
    const corrupted = {
      ...program,
      functions: program.functions.map((fn) => ({
        ...fn,
        regions: fn.regions.map((region) =>
          region._tag === 'OperationRegion'
            ? {
                ...region,
                operations: region.operations.map((operation) =>
                  operation._tag === 'ForeignCall' && operation.variadicArguments.length > 0
                    ? { ...operation, variadicArguments: [] }
                    : operation,
                ),
              }
            : region,
        ),
      })),
    }
    assert.include(
      (yield* MirVerification.verify(corrupted)).map((entry) => entry.rule),
      'InvalidForeignCall',
    )
    const manifest = AbiManifest.make(Target.aarch64AppleDarwin, artifact.foreignImports, [], [])
    const supplied = yield* AbiManifest.decode(
      SourceFile.make('variadic/valid.json', AbiManifest.encode(manifest)),
    )
    assert.deepEqual(AbiManifest.check([supplied], program), [])
    const fixed = {
      ...manifest,
      imports: manifest.imports.map((entry) => ({ ...entry, variadic: false })),
    }
    const mismatch = yield* AbiManifest.decode(
      SourceFile.make('variadic/fixed.json', AbiManifest.encode(fixed)),
    )
    assert.deepEqual(
      AbiManifest.check([mismatch], program).map((entry) => entry.code),
      ['SEM0192'],
    )
    for (const invalid of [
      { ...manifest, silkForeignAbi: 2 },
      {
        ...manifest,
        imports: manifest.imports.map((entry) => ({ ...entry, variadic: undefined })),
      },
      { ...manifest, imports: manifest.imports.map((entry) => ({ ...entry, variadic: 'true' })) },
      { ...manifest, imports: manifest.imports.map((entry) => ({ ...entry, parameters: [] })) },
    ]) {
      const source = SourceFile.make(
        'variadic/invalid.json',
        new TextEncoder().encode(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(invalid),
        ),
      )
      const error = yield* Effect.flip(AbiManifest.decode(source))
      assert.strictEqual(error.code, 'SEM0188')
      assert.deepEqual(
        [error.span.sourceId, error.span.start, error.span.end],
        [source.id, 0, source.bytes.length],
      )
    }
  }),
)

it('admits only integer variadic operands and preserves their canonical promotions', () => {
  for (const target of [
    Target.aarch64AppleDarwin,
    Target.x8664UnknownLinuxGnu,
    Target.aarch64UnknownLinuxGnu,
  ]) {
    for (const [source, promoted] of [
      ['i8', 'i32'],
      ['u8', 'i32'],
      ['i16', 'i32'],
      ['u16', 'i32'],
      ['i32', 'i32'],
      ['u32', 'u32'],
      ['i64', 'i64'],
      ['u64', 'u64'],
      ['isize', 'i64'],
      ['usize', 'u64'],
    ] as const) {
      const argument = CAbi.promoteVariadic(source, target) ?? unreachable('integer promotion')
      assert.strictEqual(CAbi.typeText(argument.promoted), promoted)
    }
    for (const type of ['f32', 'f64', ...rejected.map(([, type]) => type), Type.unit] as const) {
      assert.strictEqual(CAbi.promoteVariadic(type, target), undefined)
    }
    const fixed = CAbi.signature(['i32'], 'i32', target)
    const variadic = CAbi.signature(['i32'], 'i32', target, ForeignContract.conservative, true)
    assert.notStrictEqual(CAbi.signatureKey(fixed), CAbi.signatureKey(variadic))
  }
})

it.effect('diagnoses unsupported variadic definitions, operands and missing fixed arguments', () =>
  Effect.gen(function* () {
    for (const [source, expected] of [
      ['unsafe extern "C" fn bad(...) -> i32', 'SEM0188'],
      [
        'unsafe extern "C" fn receive(tag: i32, ...) -> i32\npub fn main() -> i32 { return unsafe receive() }',
        'SEM0007',
      ],
      ['fn bad(tag: i32, ...) -> i32 { return tag }', 'SEM0188'],
      ['export extern "C" fn bad(tag: i32, ...) -> i32 { return tag }', 'SEM0188'],
      [
        'unsafe extern "C" fn receive(tag: i32, ...) -> i32\npub fn main() -> i32 { return unsafe receive(1, true) }',
        'SEM0187',
      ],
      [
        'unsafe extern "C" fn receive(tag: i32, ...) -> i32\npub fn main() -> i32 { let x: f64 = 1.0 return unsafe receive(1, x) }',
        'SEM0187',
      ],
      [
        'unsafe extern "C" fn receive(tag: i32, ...) -> i32\npub fn main() -> i32 { let x = 1 return unsafe receive(1, &x) }',
        'SEM0187',
      ],
    ] as const) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'variadic/rejected',
        new TextEncoder().encode(source),
        'aarch64-apple-darwin',
      )
      const diagnostic =
        Analysis.diagnostics(snapshot).find((entry) => entry.code === expected) ??
        unreachable(
          `${expected}: ${Analysis.diagnostics(snapshot)
            .map((entry) => entry.code)
            .join(',')}`,
        )
      assert.strictEqual(diagnostic.span.sourceId, 'variadic/rejected')
      assert.isAbove(diagnostic.span.end, diagnostic.span.start)
    }
  }),
)

it.effect('selects the variadic boundary before foreign declaration agreement', () =>
  Effect.gen(function* () {
    const source = new TextEncoder().encode(`
static if Intrinsic.targetOperatingSystem() == "darwin" {
  unsafe extern "C" fn receive(tag: i32, ...) -> i32
} else {
  unsafe extern "C" fn receive(tag: i32, value: i32) -> i32
}
static if false {
  unsafe extern "C" fn inactive(tag: i32, ...) -> i32
  fn dormant() -> i32 { return unsafe inactive(1, true) }
}
pub fn main() -> i32 { return unsafe receive(1, 42) }`)
    for (const target of [
      'aarch64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
    ] as const) {
      const snapshot = yield* AnalysisFixture.retainingMain('variadic/selected', source, target)
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.deepEqual(
        Analysis.instancesOf(snapshot).foreignCalls.map((entry) => [
          entry.symbol,
          entry.signature.variadic,
        ]),
        [['receive', target === 'aarch64-apple-darwin']],
      )
    }
  }),
)

it.effect('preserves synchronous callback contracts on the fixed side of a variadic call', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'variadic/callback',
      new TextEncoder().encode(`
export "C" fn add(value: i32) -> i32 { return value + 1 }
unsafe extern "C" fn receive(callback: extern "C" fn(i32) -> i32, tag: i32, ...) -> i32
  with Intrinsic.foreign(callbacks: ("callback",))
pub fn main() -> i32 { let value: u16 = 41 return unsafe receive(add, 0, value) }
`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const call = program.foreignCalls.at(0) ?? unreachable('variadic callback declaration')
    assert.deepEqual(call.signature.contract.callbacks, [0])
    assert.strictEqual(call.signature.variadic, true)
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.include(artifact.ir, 'invoke i32 (ptr, i32, ...) @receive')
    assert.strictEqual(artifact.foreignExports.at(0)?.variadic, false)
  }),
)

it('limits direct Wasm C components to pointers, 32-bit integers and void', () => {
  const target = Target.wasm32UnknownUnknown
  const pointer = Type.pointer({
    mutable: true,
    pointee: 'u8',
    nullable: true,
    extent: 'Single',
    alignment: 'Natural',
    addressSpace: 0,
  })
  const allocate = CAbi.signature([pointer, 'usize', 'usize'], pointer, target)
  assert.isTrue(CAbi.available(target, allocate))
  for (const contract of [
    { ...allocate.contract, borrow: [0] },
    { ...allocate.contract, callbacks: [0] },
  ])
    assert.isFalse(CAbi.available(target, { ...allocate, contract }))
  assert.isFalse(
    CAbi.available(
      target,
      CAbi.signature([Type.foreignFunction(['i32'], 'i32')], Type.unit, target),
    ),
  )
  for (const [parameters, result] of [
    [['usize'], 'usize'],
    [['i32'], Type.unit],
  ] satisfies ReadonlyArray<readonly [ReadonlyArray<Type.Type>, Type.Type]>) {
    assert.isTrue(CAbi.available(target, CAbi.signature(parameters, result, target)))
  }
  for (const type of ['u8', 'i16', 'u64', 'f32', 'f64'] satisfies ReadonlyArray<Type.Type>) {
    const signature = CAbi.signature([type], Type.unit, target)
    assert.isFalse(CAbi.available(target, signature))
    assert.isTrue(CAbi.available(Target.aarch64AppleDarwin, signature))
  }
  assert.isFalse(
    CAbi.available(target, { ...CAbi.signature(['i32'], Type.unit, target), variadic: true }),
  )
})
