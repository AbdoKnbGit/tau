import { Buffer } from 'buffer'
import { win32 } from 'node:path'

// The script is fixed. Clipboard contents travel only as ASCII base64 on stdin,
// avoiding both command interpolation and Windows console code-page conversion.
const WRITE_UNICODE_CLIPBOARD = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  if ($text.Length -eq 0) {
    [Windows.Forms.Clipboard]::Clear()
  } else {
    [Windows.Forms.Clipboard]::SetText($text, [Windows.Forms.TextDataFormat]::UnicodeText)
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

export function windowsClipboardTextCommand(text: string, env: NodeJS.ProcessEnv = process.env): {
  file: string; args: string[]; input: string
} {
  const rootKey = Object.keys(env).find(key => key.toUpperCase() === 'SYSTEMROOT')
  const windirKey = Object.keys(env).find(key => key.toUpperCase() === 'WINDIR')
  const root = [rootKey && env[rootKey], windirKey && env[windirKey]].find(value =>
    typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !/[\0\r\n]/.test(value),
  )
  return {
    file: root ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WRITE_UNICODE_CLIPBOARD],
    input: Buffer.from(text, 'utf8').toString('base64'),
  }
}
