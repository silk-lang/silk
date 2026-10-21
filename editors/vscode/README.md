# Silk for VS Code

A minimal extension that runs `silk lsp` for `.silk` files. It gives you:

- syntax errors as you type
- the outline (document symbols)
- folding
- Format Document

## Try it from this repository

```sh
cd editors/vscode
npm install
code --extensionDevelopmentPath="$PWD" /path/to/a/silk/package
```

The extension runs `silk` from `PATH`. To use a compiler you built, set `silk.path` to its full path in the settings.
