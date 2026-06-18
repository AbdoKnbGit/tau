import * as vscode from 'vscode'
import { ChatViewProvider } from './chatViewProvider'

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('tau.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('tau.stop', () => provider.stop()),
    vscode.commands.registerCommand('tau.restart', () => provider.restart()),
  )
}

export function deactivate(): void {
  /* webview disposal handles client teardown */
}
