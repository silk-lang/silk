import * as Schema from 'effect/Schema'
import * as Effect from 'effect/Effect'
import type * as CTranslationUnit from './CTranslationUnit.js'
import * as PlatformSupply from './PlatformSupply.js'
import * as PlatformSupplyResolver from './PlatformSupplyResolver.js'
import * as NativeLinkResolver from './NativeLinkResolver.js'
import * as Result from 'effect/Result'

/** Captures preprocessing once so object compilation cannot rediscover different header contents. */
export const resolve = Effect.fn('CTranslationUnitResolver.resolve')(function* (
  supply: Pick<
    PlatformSupply.PlatformSupply,
    'compiler' | 'environment' | 'compilationArguments' | 'root'
  >,
  source: string,
  dependencies: string,
  scope: string,
): Effect.fn.Return<
  CTranslationUnit.CTranslationUnit,
  PlatformSupply.SupplyError,
  PlatformSupplyResolver.Services
> {
  yield* PlatformSupplyResolver.validateFiles([supply.compiler])
  const arguments_ = [
    ...supply.compilationArguments,
    '-E',
    '-P',
    '-x',
    'c',
    '-O2',
    '-fPIC',
    `-fmacro-prefix-map=${scope}=/silk/runtime`,
    ...(supply.root === '/' ? [] : [`-fmacro-prefix-map=${supply.root}=/silk/platform`]),
    '-MD',
    '-MF',
    dependencies,
    '-MT',
    'translation-unit',
    source,
  ]
  const query = yield* PlatformSupplyResolver.query(
    supply.environment,
    supply.compiler.command,
    arguments_,
    'C preprocessing',
  )
  const dependencyText = new TextDecoder().decode(
    yield* PlatformSupplyResolver.read(dependencies, 'C header dependencies'),
  )
  const parsed = NativeLinkResolver.argumentsOf(
    dependencyText.replace(/\\\r?\n/g, ' ').replace(/^translation-unit:\s*/, ''),
  )
  if (Result.isFailure(parsed))
    return yield* PlatformSupply.failure(
      'UnsupportedInput',
      dependencies,
      'C preprocessing',
      parsed.failure,
    )
  const headers: Array<PlatformSupply.File> = []
  for (const path of parsed.success)
    if (path !== source)
      headers.push(yield* PlatformSupplyResolver.file(path, 'header', 'C preprocessing'))
  const identity = PlatformSupplyResolver.digest(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
      'c-translation-unit-v1',
      supply.compiler.digest,
      query.stdout,
      headers.map((header) => header.digest),
      supply.compilationArguments.filter(
        (value) =>
          !value.startsWith('--sysroot=') &&
          !value.startsWith('--gcc-install-dir=') &&
          value !== supply.root,
      ),
    ]).pipe(Effect.orDie),
  )
  return {
    _tag: 'CTranslationUnit',
    source: query.stdout,
    headers: headers,
    identity,
    query,
  }
})
