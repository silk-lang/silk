# What each `silk` command does

This page is made from the machine that the `silk` tool runs, in `flows/src/Silk.silk`. Do not edit it: change the machine, and write the page again with `silk task pages` in `flows/`.

A table has one row for each situation, and the first row that applies decides. A command that needs the network or a compiler goes on in a later table, which the last column names.

## `silk use <version>`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| no home directory is known | Refuses the command, because there is no place for versions.<br>Says that no home directory is known | 1 |  |
| the project's pin is not one version | Refuses the command, because the project's pin cannot be read.<br>Says that the pin of the project cannot be read as one version | 2 |  |
| the version is installed |  |  | The tool finishes, now that the version is in place. |
| in every other case | Asks the release source for the list of releases |  | The tool asks the release source whether the version is published. |

On every path:

- only silk set edits a project
- only silk update self replaces the tool

## `silk use latest` and `silk use dev`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| no home directory is known | Refuses the command, because there is no place for versions.<br>Says that no home directory is known | 1 |  |
| the project's pin is not one version | Refuses the command, because the project's pin cannot be read.<br>Says that the pin of the project cannot be read as one version | 2 |  |
| in every other case | Asks the release source for the list of releases |  | The tool asks the release source for the newest release. |

On every path:

- only silk set edits a project

## `silk use`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| no home directory is known | Refuses the command, because there is no place for versions.<br>Says that no home directory is known | 1 |  |
| the project's pin is not one version | Refuses the command, because the project's pin cannot be read.<br>Says that the pin of the project cannot be read as one version | 2 |  |
| no project pins a version here | Refuses the command, because there is no pin to install.<br>Says that `silk use` without a version needs a project that pins one | 2 |  |
| the version is installed |  |  | The tool finishes, now that the version is in place. |
| in every other case | Asks the release source for the list of releases |  | The tool asks the release source whether the version is published. |

On every path:

- only silk set edits a project
- only silk use <version> moves the default

## `silk use list`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| no home directory is known | Refuses the command, because there is no place for versions.<br>Says that no home directory is known | 1 |  |
| SILK_TOOLCHAIN is not a version | Refuses the command, because the environment names no version.<br>Says that `SILK_TOOLCHAIN` is not a version | 2 |  |
| the project's pin is not one version | Refuses the command, because the project's pin cannot be read.<br>Says that the pin of the project cannot be read as one version | 2 |  |
| in every other case | Prints the installed versions | 0 |  |

On every path:

- only silk set edits a project
- only silk use <version> moves the default
- silk use list only reads

## `silk use which`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| SILK_TOOLCHAIN is not a version | Refuses the command, because the environment names no version.<br>Says that `SILK_TOOLCHAIN` is not a version | 2 |  |
| the project's pin is not one version, and nothing overrides it | Refuses the command, because the project's pin cannot be read.<br>Says that the pin of the project cannot be read as one version | 2 |  |
| nothing selects a version | Refuses the command, because there is no version to show.<br>Says that nothing selects a version here, with the command that installs one | 3 |  |
| the version is installed | Prints the selected version, and why it is selected<br>Notes that the member's own pin is passed over, because the pin of its workspace wins, when a member pins a version beside its workspace | 0 |  |
| in every other case | Prints the selected version, and why it is selected<br>Notes that the member's own pin is passed over, because the pin of its workspace wins, when a member pins a version beside its workspace<br>Says that the selected version is not installed, with the command that installs it | 3 |  |

On every path:

- only silk set edits a project
- only silk use <version> moves the default
- silk use which only reads

## `silk use uninstall <version>`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| no home directory is known | Refuses the command, because there is no place for versions.<br>Says that no home directory is known | 1 |  |
| the version has no directory | Prints that the version is not installed, so nothing is removed | 0 |  |
| in every other case | Removes the directory of the version<br>Prints that the version was removed<br>Notes that the removed version was the default, when the version was the default<br>Notes that the project pins the removed version, when the project pins the version | 0 |  |

On every path:

- only silk set edits a project
- only silk use <version> moves the default
- silk use uninstall installs nothing
- silk use uninstall needs no network

## `silk set <version>`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| there is no silk.toml here or above | Refuses the command, because there is no project to pin.<br>Says that there is no `silk.toml` here or above | 2 |  |
| the project's pin is no version | Refuses the command, because the project's pin cannot be read.<br>Says that the pin of the project cannot be read as one version | 2 |  |
| the version is installed |  |  | The tool works out the new text of the project's manifests. |
| in every other case | Asks the release source for the list of releases |  | The tool asks the release source whether the version is published. |

On every path:

- only silk use <version> moves the default
- silk set --no-install installs nothing
- only silk update self replaces the tool

## `silk set latest` and `silk set dev`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| there is no silk.toml here or above | Refuses the command, because there is no project to pin.<br>Says that there is no `silk.toml` here or above | 2 |  |
| the project's pin is no version | Refuses the command, because the project's pin cannot be read.<br>Says that the pin of the project cannot be read as one version | 2 |  |
| in every other case | Asks the release source for the list of releases |  | The tool asks the release source for the newest release. |

On every path:

- only silk use <version> moves the default
- silk set --no-install installs nothing

## `silk update self`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| no home directory is known | Refuses the command, because there is no place for the tool.<br>Says that no home directory is known | 1 |  |
| in every other case | Asks the release source for the list of releases |  | The tool asks the release source for a newer tool. |

On every path:

- only silk set edits a project
- only silk use <version> moves the default
- silk update self installs no Silk version
- silk update self removes no Silk version

## Words that are no command

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| always | Refuses the command, because the words are not a command.<br>Says that the words are not a command, with the way to the help | 2 |  |

On every path:

- words that are no command are a usage error
- only silk set edits a project
- only silk use <version> moves the default
- a usage error changes nothing

## A command for the compiler, such as `silk build`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| +<version> is not a version | Refuses the command, because the command line names no version.<br>Says that the `+<version>` argument is not a version | 2 |  |
| SILK_TOOLCHAIN is not a version | Refuses the command, because the environment names no version.<br>Says that `SILK_TOOLCHAIN` is not a version | 2 |  |
| the project's pin is not one version, and nothing overrides it | Refuses the command, because the project's pin cannot be read.<br>Says that the pin of the project cannot be read as one version | 2 |  |
| the compiler beside the tool serves | Notes that the member's own pin is passed over, because the pin of its workspace wins, when a member pins a version beside its workspace<br>Runs the compiler beside the tool |  | The tool becomes the compiler. |
| nothing selects a version | Refuses the command, because there is no version to run.<br>Says that nothing selects a version here, with the command that installs one | 3 |  |
| no home directory is known | Refuses the command, because there is no place for versions.<br>Says that no home directory is known | 1 |  |
| the selected version is installed | Notes that the member's own pin is passed over, because the pin of its workspace wins, when a member pins a version beside its workspace<br>Runs the compiler of the selected version |  | The tool becomes the compiler. |
| automatic installs are on | Says that it installs the selected version first<br>Asks the release source for the list of releases |  | The tool asks the release source whether the version is published. |
| in every other case | Refuses the command, because the selected version is not installed.<br>Says that the selected version is not installed, with the command that installs it | 3 |  |

On every path:

- only silk set edits a project
- only silk use <version> moves the default
- a command for the compiler needs no network unless automatic installs are on
- a command for the compiler installs nothing unless automatic installs are on
- a command for the compiler removes no version
- only silk update self replaces the tool

## `silk --help`, and `silk` alone

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| a compiler can answer | Notes that the member's own pin is passed over, because the pin of its workspace wins, when a member pins a version beside its workspace<br>Runs the compiler beside the tool, when the compiler beside the tool serves<br>Runs the compiler of the selected version, when the selected version is installed |  | The tool asks the selected compiler for its overview. |
| in every other case | Says that `SILK_TOOLCHAIN` is not a version, when SILK_TOOLCHAIN is not a version<br>Says that the pin of the project cannot be read as one version, when the project's pin is not one version, and nothing overrides it<br>Says that nothing selects a version here, with the command that installs one, when nothing selects a version<br>Says that no home directory is known, when no home directory is known<br>Says that the selected version is not installed, with the command that installs it, when the selected version is not installed<br>Prints the commands of the tool itself | 0 when the user asked for the help, 2 when `silk` was typed alone |  |

On every path:

- only silk set edits a project
- only silk use <version> moves the default
- the help only reads

## A word one edit away from a command of the tool, such as `uze`

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| a compiler can answer | Runs the compiler beside the tool, when the compiler beside the tool serves<br>Runs the compiler of the selected version, when the selected version is installed |  | The tool asks the selected compiler whether the word is one of its commands. |
| in every other case | Refuses the command, because the word is no command.<br>Says that the word is no command, with the command it is one edit away from | 2 |  |

On every path:

- only silk set edits a project
- only silk use <version> moves the default
- a mistyped word changes nothing

## When the tool asks the release source whether the version is published

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the release source lists the version | the command pins a project |  |  | The tool works out the new text of the project's manifests. |
| the release source lists the version |  | Removes the hidden directory of the download, when an interrupted install left its directory<br>Makes a hidden directory to unpack the download in<br>Downloads the archive of the release<br>Downloads the signature of the archive |  | The tool waits for the archive and its signature. |
| the release source does not list the version |  | Says that no published release is the version | 1 |  |
| the release source does not answer |  | Says that the release source did not answer | 4 |  |
| a file cannot be written or moved, or the release source lacks a file |  | Says which step could not be done | 1 |  |

## When the tool asks the release source for the newest release

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the release source names the newest release | the command pins a project |  |  | The tool works out the new text of the project's manifests. |
| the release source names the newest release | the version is installed |  |  | The tool finishes, now that the version is in place. |
| the release source names the newest release |  | Removes the hidden directory of the download, when an interrupted install left its directory<br>Makes a hidden directory to unpack the download in<br>Downloads the archive of the release<br>Downloads the signature of the archive |  | The tool waits for the archive and its signature. |
| releases are published, and none is stable |  | Says that no stable release is published yet | 1 |  |
| the release source lists no release |  | Says that the release listing names no release | 4 |  |
| the release source does not answer |  | Says that the release source did not answer | 4 |  |
| a file cannot be written or moved, or the release source lacks a file |  | Says which step could not be done | 1 |  |

## When the tool works out the new text of the project's manifests

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the manifests can be edited | the command only pins |  |  | The tool finishes, now that the version is in place. |
| the manifests can be edited | no home directory is known | Says that no home directory is known | 1 |  |
| the manifests can be edited | the version is installed |  |  | The tool finishes, now that the version is in place. |
| the manifests can be edited |  | Removes the hidden directory of the download, when an interrupted install left its directory<br>Makes a hidden directory to unpack the download in<br>Downloads the archive of the release<br>Downloads the signature of the archive |  | The tool waits for the archive and its signature. |
| a manifest cannot be edited |  | Says why the manifest cannot be edited | 1 |  |

## When the tool waits for the archive and its signature

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the archive and its signature arrive |  |  |  | The tool checks the signature of the archive. |
| the download stops | the tool updates itself | Says that the download did not arrive whole | 4 |  |
| the download stops |  | Removes the hidden directory of the download<br>Says that the download did not arrive whole | 4 |  |
| a file cannot be written or moved, or the release source lacks a file | the tool updates itself | Says which step could not be done | 1 |  |
| a file cannot be written or moved, or the release source lacks a file |  | Removes the hidden directory of the download<br>Says which step could not be done | 1 |  |

## When the tool checks the signature of the archive

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the release key signed the archive for this release | the tool updates itself |  |  | The tool replaces its own program. |
| the release key signed the archive for this release |  |  |  | The tool unpacks the archive and moves the toolchain into place. |
| the signature is missing, wrong, or of another release | the tool updates itself | Says that the release key did not sign the archive for this release | 5 |  |
| the signature is missing, wrong, or of another release |  | Removes the hidden directory of the download<br>Says that the release key did not sign the archive for this release | 5 |  |
| a file cannot be written or moved, or the release source lacks a file | the tool updates itself | Says which step could not be done | 1 |  |
| a file cannot be written or moved, or the release source lacks a file |  | Removes the hidden directory of the download<br>Says which step could not be done | 1 |  |

## When the tool unpacks the archive and moves the toolchain into place

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the toolchain is in its directory |  | Removes the directory of the version, when a directory without a compiler has the version's name<br>Puts the version in its directory |  | The tool finishes, now that the version is in place. |
| the archive is not a release of Silk |  | Removes the hidden directory of the download<br>Says that the archive is not a release of Silk | 5 |  |
| a file cannot be written or moved, or the release source lacks a file |  | Removes the hidden directory of the download<br>Says which step could not be done | 1 |  |

## When the tool finishes, now that the version is in place

| When | Then the tool | Exit status | Next |
|---|---|---|---|
| the command is silk use <version> | Prints that the version was installed, when this command installed the version<br>Prints that the version is already installed, when the version was installed before<br>Makes the version the default, when the version is not already the default<br>Prints the new default version<br>Notes that the project still pins another version, when the project pins another version | 0 |  |
| the command is silk use | Prints that the version was installed, when this command installed the version<br>Prints that the version is already installed, when the version was installed before | 0 |  |
| the command is silk set | Writes the pin to the manifest of the project, when the project does not pin the version as this tool writes it<br>Removes the members' own pins, when members of the workspace pin a version themselves<br>Prints where the project is pinned<br>Prints the members whose own pins were removed, when members of the workspace pin a version themselves<br>Prints that the version was installed, when this command installed the version<br>Notes that the pinned version is not installed yet, when the version is not installed<br>Notes that the pinned version is older than the tool, when the version is older than the tool | 0 |  |
| the command goes to a compiler | Prints that the version was installed<br>Notes that the member's own pin is passed over, because the pin of its workspace wins, when a member pins a version beside its workspace<br>Runs the compiler of the selected version |  | The tool becomes the compiler. |

## When the tool becomes the compiler

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the compiler runs in place of the tool |  | Nothing more: the compiler does the command, and its exit status is the command's |  |  |
| the compiler does not start |  | Says that the compiler does not start | 1 |  |

## When the tool asks the release source for a newer tool

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| a newer tool is published |  | Downloads the archive of the release<br>Downloads the signature of the archive |  | The tool waits for the archive and its signature. |
| the tool is the newest release |  | Prints that the tool is the newest release | 0 |  |
| the release source lists no release |  | Says that the release listing names no release | 4 |  |
| the release source does not answer |  | Says that the release source did not answer | 4 |  |
| a file cannot be written or moved, or the release source lacks a file |  | Says which step could not be done | 1 |  |

## When the tool replaces its own program

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the new tool is in place |  | Replaces the tool with the new one<br>Prints that the tool was updated | 0 |  |
| the archive is not a release of Silk |  | Says that the archive is not a release of Silk | 5 |  |
| a file cannot be written or moved, or the release source lacks a file |  | Says which step could not be done | 1 |  |

## When the tool asks the selected compiler for its overview

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the compiler gives its overview |  | Prints the overview of the commands of the selected compiler<br>Prints the commands of the tool itself | 0 when the user asked for the help, 2 when `silk` was typed alone |  |
| the compiler gives no overview |  | Says that the selected compiler gave no overview<br>Prints the commands of the tool itself | 0 when the user asked for the help, 2 when `silk` was typed alone |  |

## When the tool asks the selected compiler whether the word is one of its commands

| The world answers | and | Then the tool | Exit status | Next |
|---|---|---|---|---|
| the compiler lists the word, or a word one edit away |  | Hands the word to the compiler, whose exit status is the command's |  |  |
| the compiler does not list the word |  | Says that the word is no command, with the command it is one edit away from | 2 |  |
