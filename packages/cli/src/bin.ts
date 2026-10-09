#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import * as NodeHeapObservation from '@silklang/compiler/NodeHeapObservation'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Command } from 'effect/unstable/cli'
import * as Cli from './Cli.js'
import * as Launcher from './Launcher.js'

/**
 * The application edge. Platform services are provided exactly once, here, so every module
 * inward of this file stays a pure Effect describing what to do rather than how to reach Node.
 * Under Node without a chosen young-generation size, the edge first relaunches itself with one.
 */
const main = Effect.gen(function* () {
  const nodeOptions = yield* Config.String('NODE_OPTIONS').pipe(
    Config.withDefault(''),
    Effect.orDie,
  )
  const launch: Launcher.Launch = {
    executable: process.execPath,
    executableArguments: process.execArgv,
    script: process.argv[1] ?? '',
    arguments: process.argv.slice(2),
    nodeOptions,
  }
  if (process.versions['bun'] !== undefined || Launcher.configured(launch)) {
    return yield* Cli.command.pipe(Command.run({ version: '0.0.0' }))
  }
  process.exitCode = yield* Launcher.relaunch(launch)
})

main.pipe(
  Effect.provide(Layer.mergeAll(NodeHeapObservation.layer, NodeServices.layer)),
  NodeRuntime.runMain,
)
