/**
 * Backend and toolchain facts, as data rather than as markup.
 *
 * These phases used to be components that rendered their own cards. The registry now projects
 * every phase into the shared row grammar, so what is left here is the part that was never
 * presentational: projecting emission failures as data and planning the three clang invocations.
 * Both are shapes the row projections consume.
 */

import * as Effect from 'effect/Effect'
import * as Analysis from './Analysis.js'
import type * as Backend from './Backend.js'
import * as ToolchainPlan from './ToolchainPlan.js'

const clang = '/usr/bin/clang'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const commandText = (planned: ToolchainPlan.PlannedCommand): string =>
  [planned.command, ...planned.arguments].join(' ')

export type Emission =
  | { readonly _tag: 'Emitted'; readonly artifact: Backend.LlvmEmission }
  | { readonly _tag: 'Rejected'; readonly message: string }

/**
 * Emission is an Effect that can fail when the selected target cannot realize the analyzed
 * program. Running it here turns that into data the pane can render, instead of an exception that
 * takes the pane down with it.
 */
export const backendEmission = (
  snapshot: Analysis.Snapshot,
  mode: 'release' | 'debug',
): Emission => {
  try {
    return {
      _tag: 'Emitted',
      artifact: Effect.runSync(Analysis.codegen(snapshot, { mode })),
    }
  } catch (error) {
    return { _tag: 'Rejected', message: messageOf(error) }
  }
}

export type ToolchainCommands =
  | {
      readonly _tag: 'Planned'
      readonly target: string
      readonly commands: ReadonlyArray<readonly [string, string]>
    }
  | { readonly _tag: 'Unavailable'; readonly message: string }

/**
 * The commands the LLVM toolchain would run for the selected target.
 */
export const toolchainCommands = (snapshot: Analysis.Snapshot): ToolchainCommands => {
  const selection = Analysis.targetOf(snapshot)
  if (selection._tag !== 'Resolved') {
    return { _tag: 'Unavailable', message: selection.error.message }
  }

  const profile = snapshot.profile
  if (profile === undefined)
    return { _tag: 'Unavailable', message: 'Configuration did not complete' }
  const target = selection.target
  if (target.kind === 'WebAssembly') {
    const planned = ToolchainPlan.wasmCommand(
      clang,
      profile,
      '<scope>/program.bc',
      '<scope>/silk_wasm_runtime.o',
      '<destination>/program.wasm',
    )
    return {
      _tag: 'Planned',
      target: target.id,
      commands: [['wasm', commandText(planned)]],
    }
  }
  const link = ToolchainPlan.nativeCommand(
    { clang, llvmAr: 'llvm-ar' },
    'NativeExecutable',
    target,
    ['<scope>/program.o', '<scope>/silk_runtime.o'],
    [],
    '<destination>/program',
  )
  if (link._tag === 'UnsupportedNativePlan') {
    return { _tag: 'Unavailable', message: `unsupported native plan: ${link.reason}` }
  }

  return {
    _tag: 'Planned',
    target: target.id,
    commands: [
      [
        'object',
        commandText(
          ToolchainPlan.objectCommand(clang, profile, '<scope>/program.bc', '<scope>/program.o'),
        ),
      ],
      [
        'runtime',
        commandText(
          ToolchainPlan.cObjectCommand(
            clang,
            target,
            '<scope>/silk_runtime.c',
            '<scope>/silk_runtime.o',
          ),
        ),
      ],
      ['link', commandText(link)],
    ],
  }
}
