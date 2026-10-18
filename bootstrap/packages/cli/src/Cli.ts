import { Command } from 'effect/unstable/cli'
import * as BuildCommand from './BuildCommand.js'
import * as BuildExeCommand from './BuildExeCommand.js'
import * as CheckCommand from './CheckCommand.js'
import * as CleanCommand from './CleanCommand.js'
import * as DocCommand from './DocCommand.js'
import * as DoctestCommand from './DoctestCommand.js'
import * as DocumentationSiteCommand from './DocumentationSiteCommand.js'
import * as FormatCommand from './FormatCommand.js'
import * as InitCommand from './InitCommand.js'
import * as RunCommand from './RunCommand.js'
import * as TestCommand from './TestCommand.js'

/**
 * The `silk` root command. It owns only composition — every subcommand keeps its own module — so
 * adding a command never edits a shared switch.
 */
export const command = Command.make('silk').pipe(
  Command.withDescription('The Silk bootstrap compiler.'),
  Command.withSubcommands([
    InitCommand.command,
    BuildCommand.command,
    CheckCommand.command,
    CleanCommand.command,
    DocCommand.command,
    DoctestCommand.command,
    DocumentationSiteCommand.command,
    FormatCommand.command,
    RunCommand.command,
    TestCommand.command,
    BuildExeCommand.command,
  ]),
)
