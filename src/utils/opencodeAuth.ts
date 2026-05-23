import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

type JsonRecord = Record<string, unknown>

export function loadOpenCodeApiKeyFromAuthFile(): string | null {
  const fromContent = parseJsonObject(process.env.OPENCODE_AUTH_CONTENT)
  if (fromContent) {
    const key = readOpenCodeCredential(fromContent)
    if (key) return key
  }

  for (const file of openCodeCredentialFiles()) {
    const raw = readJsonFile(file)
    if (!raw) continue
    const key = readOpenCodeCredential(raw)
    if (key) return key
  }

  return null
}

function openCodeCredentialFiles(): string[] {
  const dataDirs = new Set<string>()
  const xdgData = process.env.XDG_DATA_HOME
  if (xdgData) dataDirs.add(join(xdgData, 'opencode'))
  dataDirs.add(join(homedir(), '.local', 'share', 'opencode'))
  if (process.env.LOCALAPPDATA) {
    dataDirs.add(join(process.env.LOCALAPPDATA, 'opencode'))
  }

  const files: string[] = []
  for (const dir of dataDirs) {
    files.push(join(dir, 'account.json'))
    files.push(join(dir, 'auth.json'))
  }
  return files
}

function readJsonFile(file: string): JsonRecord | null {
  try {
    if (!existsSync(file)) return null
    return parseJsonObject(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

function parseJsonObject(raw: string | undefined): JsonRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readOpenCodeCredential(raw: JsonRecord): string | null {
  return readOpenCodeAccountJson(raw) ?? readOpenCodeLegacyAuth(raw)
}

function readOpenCodeLegacyAuth(raw: JsonRecord): string | null {
  const credential = raw.opencode
  if (!isRecord(credential)) return null
  return credential.type === 'api' && typeof credential.key === 'string'
    ? credential.key
    : null
}

function readOpenCodeAccountJson(raw: JsonRecord): string | null {
  if (raw.version !== 2 || !isRecord(raw.accounts)) return null

  const activeID = isRecord(raw.active) && typeof raw.active.opencode === 'string'
    ? raw.active.opencode
    : undefined
  if (activeID) {
    const activeKey = readOpenCodeAccount(raw.accounts[activeID])
    if (activeKey) return activeKey
  }

  for (const account of Object.values(raw.accounts)) {
    const key = readOpenCodeAccount(account)
    if (key) return key
  }
  return null
}

function readOpenCodeAccount(value: unknown): string | null {
  if (!isRecord(value) || value.serviceID !== 'opencode') return null
  const credential = value.credential
  if (!isRecord(credential)) return null
  return credential.type === 'api' && typeof credential.key === 'string'
    ? credential.key
    : null
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
