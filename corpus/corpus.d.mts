/** One program kind, each a subdirectory of the corpus root. */
export type Kind = 'native' | 'invalid'

/** One run of a native program with its own process arguments. */
export interface Run {
  readonly arguments?: ReadonlyArray<string>
  readonly closeStderr?: boolean
}

/** One native compilation profile a program's contract must hold under. */
export interface Profile {
  readonly name: string
  readonly optimization: 'none' | 'speed'
  readonly debug: boolean
}

/** One runtime capability a program binds to its own declarations. */
export interface Component {
  readonly capability: string
  readonly bindings: ReadonlyArray<{
    readonly operation: string
    readonly module: string
    readonly declaration: string
  }>
}

/**
 * One diagnostic a rejected program must report: its code and its span in `main.silk` as
 * `line:column-line:column`.
 */
export interface ExpectedDiagnostic {
  readonly code: string
  readonly span: string
}

/** What running or checking a program must produce. */
export type Expected =
  | { readonly kind: 'completes'; readonly exitCode: number }
  | { readonly kind: 'trap'; readonly windowsStatus?: number }
  | { readonly kind: 'rejected'; readonly diagnostics: ReadonlyArray<ExpectedDiagnostic> }

/** The contents of one `outcome.json`. */
export interface Outcome {
  readonly schemaVersion: 1
  readonly expected: Expected
  readonly runs?: ReadonlyArray<Run>
  readonly profiles?: ReadonlyArray<Profile>
  readonly dynamicLibraries?: ReadonlyArray<string>
  readonly components?: ReadonlyArray<Component>
}

/** One loaded program, with every splice expanded. */
export interface Program {
  readonly name: string
  readonly source: string
  readonly reference: string | undefined
  readonly imports: Readonly<Record<string, string>>
  readonly cSources: Readonly<Record<string, string>>
  /** Explicit system-DLL imports for Windows C fixtures, keyed by library name. */
  readonly windowsImports: Readonly<Record<string, string>>
  readonly stdout: string | undefined
  readonly stderr: string | undefined
  readonly outcome: Outcome
}

export declare const corpusRoot: string
export declare const repositoryRoot: string
export declare const kinds: ReadonlyArray<Kind>
export declare const expandSplices: (text: string, origin?: string) => string
export declare const programNames: (kind: Kind) => ReadonlyArray<string>
export declare const loadProgram: (kind: Kind, name: string) => Program
export declare const loadPrograms: (kind: Kind) => ReadonlyArray<Program>
export declare const formatSpan: (text: string, start: number, end: number) => string
export declare const formatOutcome: (outcome: Outcome) => string
