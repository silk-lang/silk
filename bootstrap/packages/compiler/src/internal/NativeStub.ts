import * as Result from 'effect/Result'

export interface NativeStub {
  readonly names: ReadonlyArray<string>
  readonly imports: ReadonlyArray<string>
}
const values = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/'([^']*)'|"([^"]*)"|([^\s,[\]]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  )

/** Reads the admitted TAPI v4 target and reexport contract, including inline library documents. */
export const parse = (source: string): Result.Result<NativeStub, string> => {
  const names: Array<string> = [],
    imports: Array<string> = []
  for (const document of source.split(/^---/m).filter((part) => part.trim() !== '')) {
    if (!/^\s*!tapi-tbd\s*\n/.test(document) || !/^tbd-version:\s*4\s*$/m.test(document))
      return Result.fail('only TAPI v4 stubs are admitted')
    const targets = /^targets:\s*\[([^\]]*)\]/m.exec(document)?.[1]
    if (targets === undefined || !values(targets).includes('arm64-macos')) continue
    const name = /^install-name:\s*(.+)$/m.exec(document)?.[1]
    if (name === undefined) return Result.fail('missing stub install name')
    names.push(...values(name))
    const block =
      /^reexported-libraries:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(document)?.[1] ?? ''
    for (const group of block.split(/\n(?=\s+- targets:)/)) {
      const groupTargets = /targets:\s*\[([^\]]*)\]/.exec(group)?.[1]
      if (groupTargets !== undefined && !values(groupTargets).includes('arm64-macos')) continue
      const libraries = /libraries:\s*\[([^\]]*)\]/.exec(group)?.[1]
      if (libraries !== undefined) imports.push(...values(libraries))
    }
  }
  if (names.length === 0) return Result.fail('stub does not supply arm64-macos')
  return Result.succeed({
    names: names,
    imports: imports.filter((name) => !names.includes(name)),
  })
}
