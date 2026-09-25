import * as Effect from 'effect/Effect'
import * as Analysis from './Analysis.js'
import type * as Backend from './Backend.js'
import * as CompilationProfile from './CompilationProfile.js'
import * as HelperCapability from './HelperCapability.js'
import * as Preparation from './Preparation.js'
import * as SourceResolver from './SourceResolver.js'

/**
 * Compiles the selected source providers as one program without an application or runtime root.
 * They share a frontend, which is most of their cost; the object is audited as one unit.
 */
export const compile = Effect.fn('HelperSource.compile')(function* (
  providers: ReadonlyArray<HelperCapability.Provider>,
  profile: CompilationProfile.Facts,
): Effect.fn.Return<
  {
    readonly artifact: Backend.LlvmBitcodeArtifact
    readonly profile: CompilationProfile.CompilationProfile
  },
  HelperCapability.HelperError
> {
  const invalid = (subject: string) =>
    new HelperCapability.HelperError({
      operation: 'HelperSource.compile',
      code: 'InvalidSupportProfile',
      subject,
      origins: providers.map((provider) => provider.id),
    })
  for (const provider of providers)
    if (provider.kind !== 'source' || !provider.targets.includes(profile.target.id))
      return yield* invalid(`Provider ${provider.id} is not a compatible source provider`)
  const input: CompilationProfile.Input = {
    target: profile.target.id,
    cpu: profile.cpu,
    ...(profile.deployment === undefined ? {} : { deployment: profile.deployment }),
    artifact: 'object',
    entry: { kind: 'none' },
    runtime: { kind: 'none' },
    libc: 'none',
    relocation: profile.relocation,
    codeModel: profile.codeModel,
    optimization: profile.optimization,
    debug: profile.debug,
    unwind: 'none',
    sanitizers: [],
  }
  // Codegen needs the realized program only: editor indexes (FrontendTooling) are not built.
  const bundle = yield* Preparation.prepare(
    { root: 'compiler-support/root', configuration: { profile: input } },
    'executable',
  ).pipe(
    Effect.provide(
      SourceResolver.memory(
        new Map([
          [
            'compiler-support/root',
            new TextEncoder().encode(
              providers.map((provider) => `import ${provider.root}\n`).join(''),
            ),
          ],
        ]),
      ),
    ),
    Effect.mapError((error) => invalid(error.message)),
  )
  const { frontend, ...realization } = Preparation.realization(bundle)
  const program = { ...frontend, ...realization }
  const diagnostics = program.diagnostics
  if (diagnostics.length !== 0 || program.profile === undefined)
    return yield* invalid(diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('\n'))
  const artifact = yield* Analysis.codegen(program, {
    mode: profile.optimization === 'none' ? 'debug' : 'release',
    support: true,
  }).pipe(Effect.mapError((failure) => invalid(failure.message)))
  yield* HelperCapability.verifyExports(providers, artifact.foreignExports, profile.target)
  return { artifact, profile: program.profile }
})
