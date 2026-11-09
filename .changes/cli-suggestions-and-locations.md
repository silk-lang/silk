---
bump: minor
---

`silk.cli` suggests the closest subcommand for a misspelled one (`CliError.UnknownCommand` gains `suggestion`), checks an option's alias and duplicates where the option is added, and leaves no empty program name in usage lines; a static fault that the standard library reaches while running a package's own code is reported once, at that code's call; and `Task.main` names the file operation and reason of a `FileError`.
