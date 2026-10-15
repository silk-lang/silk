import type * as RuntimeComponent from '../../src/RuntimeComponent.js'
import * as Corpus from '../../../../corpus/corpus.mjs'

/** One native run of a corpus program with its own process arguments. */
export interface NativeRun {
  readonly arguments?: ReadonlyArray<string>
  readonly closeStderr?: boolean
}

/** Native compilation profiles required to distinguish one corpus program's contract. */
export interface NativeProfile {
  readonly name: string
  readonly optimization: 'none' | 'speed'
  readonly debug: boolean
}

/** One program of the shared native acceptance corpus in `corpus/native/`. */
export interface CorpusProgram {
  readonly name: string
  readonly source: string
  readonly nativeSource?: string
  readonly nativeImports?: Readonly<Record<string, string>>
  readonly nativeComponents?: ReadonlyArray<RuntimeComponent.Input>
  /** C translation units compiled with `compileCObject` and linked as structured object inputs. */
  readonly nativeCSources?: Readonly<Record<string, string>>
  readonly nativeDynamicLibraries?: ReadonlyArray<string>
  readonly nativeStdout?: string
  readonly nativeStderr?: string
  readonly nativeRuns?: ReadonlyArray<NativeRun>
  readonly nativeProfiles?: ReadonlyArray<NativeProfile>
  readonly expected:
    | { readonly _tag: 'Completes'; readonly result: number }
    | { readonly _tag: 'Trap' }
}

/** One program of `corpus/invalid/` and the diagnostic codes compilation must report. */
export interface InvalidCorpusProgram {
  readonly name: string
  readonly source: string
  readonly codes: ReadonlyArray<string>
}

const nativeProgram = (program: Corpus.Program): CorpusProgram => {
  const { expected, runs, profiles, dynamicLibraries, components } = program.outcome
  if (expected.kind === 'rejected') throw new Error(`native/${program.name} expects a rejection`)
  return {
    name: program.name,
    // A reference source is the portable program; `main.silk` is what native compilation runs.
    source: program.reference ?? program.source,
    ...(program.reference === undefined ? {} : { nativeSource: program.source }),
    ...(Object.keys(program.imports).length === 0 ? {} : { nativeImports: program.imports }),
    ...(Object.keys(program.cSources).length === 0 ? {} : { nativeCSources: program.cSources }),
    ...(components === undefined ? {} : { nativeComponents: components }),
    ...(dynamicLibraries === undefined ? {} : { nativeDynamicLibraries: dynamicLibraries }),
    ...(program.stdout === undefined ? {} : { nativeStdout: program.stdout }),
    ...(program.stderr === undefined ? {} : { nativeStderr: program.stderr }),
    ...(runs === undefined ? {} : { nativeRuns: runs }),
    ...(profiles === undefined ? {} : { nativeProfiles: profiles }),
    expected:
      expected.kind === 'completes'
        ? { _tag: 'Completes', result: expected.exitCode }
        : { _tag: 'Trap' },
  }
}

/** Every native corpus program, in name order. */
export const nativeCorpus: ReadonlyArray<CorpusProgram> =
  Corpus.loadPrograms('native').map(nativeProgram)

/** One native corpus program, read from its own directory. */
export const corpusProgram = (name: string): CorpusProgram =>
  nativeProgram(Corpus.loadProgram('native', name))

/** Every program that compilation must reject, in name order. */
export const invalidCorpus: ReadonlyArray<InvalidCorpusProgram> = Corpus.loadPrograms(
  'invalid',
).map((program) => {
  const { expected } = program.outcome
  if (expected.kind !== 'rejected')
    throw new Error(`invalid/${program.name} does not expect a rejection`)
  return { name: program.name, source: program.source, codes: expected.codes }
})
