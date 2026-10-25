export type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export type LspServerConfig = {
  command: string
  args?: string[]
  extensionToLanguage: Record<string, string>
  transport?: 'stdio' | 'socket'
  env?: Record<string, string>
  initializationOptions?: unknown
  settings?: unknown
  workspaceFolder?: string
  startupTimeout?: number
  shutdownTimeout?: number
  restartOnCrash?: boolean
  maxRestarts?: number
  alwaysOn?: boolean
}

export type ScopedLspServerConfig = LspServerConfig & {
  scope?: 'dynamic' | 'builtin'
  source?: string
  pluginSource?: string
}
