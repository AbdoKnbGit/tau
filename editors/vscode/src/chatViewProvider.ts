import * as vscode from 'vscode'
import { AcpClient, type AcpHandlers } from './acpClient'

/**
 * Hosts the Tau chat webview: builds the UI, spawns/owns one {@link AcpClient},
 * and relays messages both ways (webview postMessage <-> ACP).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tau.chatView'

  private view?: vscode.WebviewView
  private client?: AcpClient

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    }
    view.webview.html = this.html(view.webview)

    view.webview.onDidReceiveMessage(msg => this.onWebviewMessage(msg))
    view.onDidDispose(() => this.client?.dispose())
  }

  /** Tear down the agent and start a clean session. */
  async newChat(): Promise<void> {
    await this.restart()
  }

  async stop(): Promise<void> {
    await this.client?.cancel()
  }

  async restart(): Promise<void> {
    this.client?.dispose()
    this.client = undefined
    this.post({ type: 'reset' })
    await this.startClient()
  }

  // ---- internals -----------------------------------------------------------

  private async onWebviewMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        // The webview finished loading; boot the agent.
        await this.startClient()
        break
      case 'prompt':
        if (typeof msg.text === 'string' && msg.text.trim()) {
          await this.client?.prompt(msg.text)
        }
        break
      case 'stop':
        await this.client?.cancel()
        break
      case 'setConfig':
        await this.client?.setConfig(msg.configId, msg.value)
        break
      case 'newChat':
        await this.restart()
        break
    }
  }

  private async startClient(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('tau')
    const command = cfg.get<string>('command', 'tau')
    const args = cfg.get<string[]>('args', ['acp'])
    const showCacheBar = cfg.get<boolean>('showCacheBar', true)
    const cwd =
      cfg.get<string>('cwd') ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      process.cwd()

    this.post({ type: 'config', showCacheBar })
    this.post({ type: 'status', status: 'starting' })

    const handlers: AcpHandlers = {
      onSessionReady: info => this.post({ type: 'session', ...info }),
      onCommands: commands => this.post({ type: 'commands', commands }),
      onText: text => this.post({ type: 'text', text }),
      onThought: text => this.post({ type: 'thought', text }),
      onToolCall: call => this.post({ type: 'toolCall', call }),
      onToolUpdate: update => this.post({ type: 'toolUpdate', update }),
      onUsage: usage => this.post({ type: 'usage', usage }),
      onTurnEnd: stopReason => this.post({ type: 'turnEnd', stopReason }),
      onError: message => this.post({ type: 'error', message }),
      onExit: code => this.post({ type: 'exit', code }),
    }

    this.client = new AcpClient({ command, args, cwd }, handlers)
    try {
      await this.client.start()
      await this.client.newSession()
      this.post({ type: 'status', status: 'ready' })
    } catch (err) {
      this.post({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
      this.post({ type: 'status', status: 'error' })
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message)
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce()
    const uri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'media', file),
      )
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri('main.css')}" rel="stylesheet" />
  <title>Tau</title>
</head>
<body>
  <div id="app">
    <header id="topbar">
      <div id="pickers"></div>
      <div id="status" class="status"></div>
    </header>
    <main id="messages" aria-live="polite"></main>
    <footer id="footer">
      <div id="cachebar" class="cachebar hidden"></div>
      <div id="composer">
        <textarea id="input" rows="1" placeholder="Ask Tau…"></textarea>
        <button id="send" title="Send">▸</button>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`
  }
}

function getNonce(): string {
  let text = ''
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++)
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  return text
}
