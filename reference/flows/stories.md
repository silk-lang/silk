# Walkthroughs of the `silk` tool

This page is made from the stories in `flows/src/Stories.silk` and the machine that the `silk` tool runs. Do not edit it: change the story or the machine, and write the page again with `silk task pages` in `flows/`.

Each step is one command. Under it is what the world answers while the command runs, and then everything the command leaves, in order. A command leaves nothing else.

## first-install

On a new computer, a person installs the newest Silk, looks at what is selected, and builds.

### `silk use which`

- Says that nothing selects a version here, with the command that installs one.
- Ends with exit status 3.

### `silk use latest`

The release source names the newest release. The archive and its signature arrive. The release key signed the archive for this release. The toolchain is in its directory.

- Asks the release source for the list of releases.
- Makes a hidden directory to unpack the download in.
- Downloads the archive of the release.
- Downloads the signature of the archive.
- Puts the version in its directory.
- Prints that the version was installed.
- Makes the version the default.
- Prints the new default version.
- Ends with exit status 0.

### `silk use which`

- Prints the selected version, and why it is selected.
- Ends with exit status 0.

### `silk use list`

- Prints the installed versions.
- Ends with exit status 0.

### `silk build`

The compiler runs in place of the tool.

- Runs the compiler of the selected version.

## pin-a-project

A person pins a project to a version, which installs it, and a second person who clones the project installs the pin.

### `silk set <version>`

The release source lists the version. The manifests can be edited. The archive and its signature arrive. The release key signed the archive for this release. The toolchain is in its directory.

- Asks the release source for the list of releases.
- Makes a hidden directory to unpack the download in.
- Downloads the archive of the release.
- Downloads the signature of the archive.
- Puts the version in its directory.
- Writes the pin to the manifest of the project.
- Prints where the project is pinned.
- Prints that the version was installed.
- Notes that the pinned version is older than the tool.
- Ends with exit status 0.

### `silk build`

The compiler runs in place of the tool.

- Runs the compiler of the selected version.

### `silk use uninstall <version>`

- Removes the directory of the version.
- Prints that the version was removed.
- Notes that the project pins the removed version.
- Ends with exit status 0.

### `silk build`

- Says that the selected version is not installed, with the command that installs it.
- Ends with exit status 3.

### `silk use`

The release source lists the version. The archive and its signature arrive. The release key signed the archive for this release. The toolchain is in its directory.

- Asks the release source for the list of releases.
- Makes a hidden directory to unpack the download in.
- Downloads the archive of the release.
- Downloads the signature of the archive.
- Puts the version in its directory.
- Prints that the version was installed.
- Ends with exit status 0.

### `silk build`

The compiler runs in place of the tool.

- Runs the compiler of the selected version.

## automatic-install

With automatic installs on, the first build in a pinned project installs the pin and goes on.

### `silk build`

The release source lists the version. The archive and its signature arrive. The release key signed the archive for this release. The toolchain is in its directory. The compiler runs in place of the tool.

- Says that it installs the selected version first.
- Asks the release source for the list of releases.
- Makes a hidden directory to unpack the download in.
- Downloads the archive of the release.
- Downloads the signature of the archive.
- Puts the version in its directory.
- Prints that the version was installed.
- Runs the compiler of the selected version.

### `silk build`

The compiler runs in place of the tool.

- Runs the compiler of the selected version.

## bad-download

A download is cut, the next one is not signed by the release key, and the third installs.

### `silk use <version>`

The release source lists the version. The download stops.

- Asks the release source for the list of releases.
- Makes a hidden directory to unpack the download in.
- Downloads the archive of the release.
- Downloads the signature of the archive.
- Removes the hidden directory of the download.
- Says that the download did not arrive whole.
- Ends with exit status 4.

### `silk use <version>`

The release source lists the version. The archive and its signature arrive. The signature is missing, wrong, or of another release.

- Asks the release source for the list of releases.
- Makes a hidden directory to unpack the download in.
- Downloads the archive of the release.
- Downloads the signature of the archive.
- Removes the hidden directory of the download.
- Says that the release key did not sign the archive for this release.
- Ends with exit status 5.

### `silk use list`

- Prints the installed versions.
- Ends with exit status 0.

### `silk use <version>`

The release source lists the version. The archive and its signature arrive. The release key signed the archive for this release. The toolchain is in its directory.

- Asks the release source for the list of releases.
- Makes a hidden directory to unpack the download in.
- Downloads the archive of the release.
- Downloads the signature of the archive.
- Puts the version in its directory.
- Prints that the version was installed.
- Makes the version the default.
- Prints the new default version.
- Ends with exit status 0.

### `silk use list`

- Prints the installed versions.
- Ends with exit status 0.

## move-a-workspace

A workspace whose members pin a version moves to the newest one without installing it, and the next command says how to install it.

### `silk set latest --no-install`

The release source names the newest release. The manifests can be edited.

- Asks the release source for the list of releases.
- Writes the pin to the manifest of the project.
- Removes the members' own pins.
- Prints where the project is pinned.
- Prints the members whose own pins were removed.
- Notes that the pinned version is not installed yet.
- Ends with exit status 0.

### `silk use which`

- Prints the selected version, and why it is selected.
- Says that the selected version is not installed, with the command that installs it.
- Ends with exit status 3.

### `silk build`

- Says that the selected version is not installed, with the command that installs it.
- Ends with exit status 3.

### `silk +<another version> build`

- Says that the selected version is not installed, with the command that installs it.
- Ends with exit status 3.

## update-the-tool

A person asks for the help, mistypes a command, and updates the tool.

### `silk`

- Says that nothing selects a version here, with the command that installs one.
- Prints the commands of the tool itself.
- Ends with exit status 2.

### `silk uze`

- Says that the word is no command, with the command it is one edit away from.
- Ends with exit status 2.

### `silk use --no-such-option`

- Says that the words are not a command, with the way to the help.
- Ends with exit status 2.

### `silk update self`

The tool is the newest release.

- Asks the release source for the list of releases.
- Prints that the tool is the newest release.
- Ends with exit status 0.

### `silk update self`

A newer tool is published. The archive and its signature arrive. The release key signed the archive for this release. The new tool is in place.

- Asks the release source for the list of releases.
- Downloads the archive of the release.
- Downloads the signature of the archive.
- Replaces the tool with the new one.
- Prints that the tool was updated.
- Ends with exit status 0.
