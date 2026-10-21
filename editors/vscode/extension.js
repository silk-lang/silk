// Starts `silk lsp` for Silk documents, and restarts it when `silk.path` changes. The server does
// the work; this only launches it.
const vscode = require('vscode')
const { LanguageClient } = require('vscode-languageclient/node')

let client

const start = () => {
  const command = vscode.workspace.getConfiguration('silk').get('path', 'silk')
  const server = { command, args: ['lsp'] }
  client = new LanguageClient(
    'silk',
    'Silk',
    { run: server, debug: server },
    { documentSelector: [{ scheme: 'file', language: 'silk' }] },
  )
  return client.start()
}

exports.activate = (context) => {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((change) => {
      if (change.affectsConfiguration('silk.path')) {
        void client.stop().then(start)
      }
    }),
  )
  return start()
}

exports.deactivate = () => client?.stop()
