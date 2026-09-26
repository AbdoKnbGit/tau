/**
 * Local document reading through Python libraries.
 *
 * PDFs need Poppler for page images and text, and Word, Excel and PowerPoint
 * files had no local reader at all (Office files were uploaded to Firecrawl).
 * Many machines already have the Python libraries that do both. This finds an
 * interpreter that has one (pythonEnv.ts: the project's environment first,
 * then the system Pythons) and runs tau's reader script with it. When none
 * has it, the result carries the one command that installs it into the right
 * environment; nothing is installed here.
 */
import { execa } from 'execa'
import { stat } from 'fs/promises'
import { buildKernelEnv } from '../tools/EvalTool/pythonRuntime.js'
import {
  describeInstall,
  describePythonEnv,
  ensurePythonScript,
  findPythonWithModule,
  forgetPythonModule,
  preferredInstallTarget,
  type PythonEnv,
} from './pythonEnv.js'
import { PYTHON_DOCS_SOURCE } from './pythonDocsSource.js'

export type PythonDocMode =
  | 'pdf-render'
  | 'pdf-text'
  | 'docx'
  | 'xlsx'
  | 'xls'
  | 'pptx'

/** Import names that serve each mode, best first. */
const MODULES: Readonly<Record<PythonDocMode, readonly string[]>> = {
  'pdf-render': ['pymupdf', 'fitz'],
  'pdf-text': ['pymupdf', 'fitz', 'pypdf', 'PyPDF2', 'pdfplumber'],
  docx: ['docx'],
  xlsx: ['openpyxl'],
  xls: ['xlrd'],
  pptx: ['pptx'],
}

/** The package to install when no interpreter can serve a mode. */
export const PYTHON_DOC_PACKAGES: Readonly<Record<PythonDocMode, string>> = {
  'pdf-render': 'PyMuPDF',
  'pdf-text': 'PyMuPDF',
  docx: 'python-docx',
  xlsx: 'openpyxl',
  xls: 'xlrd',
  pptx: 'python-pptx',
}

const DOC_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export type PythonDocResult =
  | { ok: true; env: PythonEnv; library: string; data: Record<string, unknown> }
  | { ok: false; reason: 'missing'; message: string }
  | { ok: false; reason: 'password' | 'failed'; message: string }

/** Whether some interpreter here can serve `mode`, without running anything else. */
export async function hasPythonDocReader(mode: PythonDocMode): Promise<boolean> {
  try {
    return 'env' in (await findPythonWithModule([...MODULES[mode]]))
  } catch {
    return false
  }
}

/**
 * "No Python here has PyMuPDF (checked: ...). Install it with `...`."
 * Also covers a machine with no Python at all.
 */
async function missingMessage(
  mode: PythonDocMode,
  checked: readonly PythonEnv[],
  missingModule?: string,
): Promise<string> {
  const pkg = PYTHON_DOC_PACKAGES[mode]
  const target = preferredInstallTarget(checked)
  if (!target) {
    return `No Python 3 interpreter was found, so ${pkg} cannot be used. Install Python 3, then install ${pkg} for it.`
  }
  // A library that loaded but lacks a dependency of its own names it.
  const extra = missingModule && !MODULES[mode].includes(missingModule) ? [missingModule] : []
  const install = await describeInstall(target, [pkg, ...extra], 'bash')
  const where = checked.map(describePythonEnv).join('; ')
  return `No Python here has ${pkg}${extra.length ? ` (with ${extra.join(', ')})` : ''} (checked: ${where}). Install it into ${describePythonEnv(target)}: ${install}.`
}

/** Run one reader mode with the first interpreter that can serve it. */
export async function runPythonDocReader(
  mode: PythonDocMode,
  filePath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<PythonDocResult> {
  const found = await findPythonWithModule([...MODULES[mode]])
  if (!('env' in found)) {
    return { ok: false, reason: 'missing', message: await missingMessage(mode, found.checked) }
  }
  const { env } = found
  const script = ensurePythonScript('tau_docs.py', PYTHON_DOCS_SOURCE)
  let stdout = ''
  let stderr = ''
  try {
    const result = await execa(env.command, [...env.args, script, mode, filePath, ...args], {
      // No secrets for a process that parses an untrusted file in-process.
      env: buildKernelEnv({}),
      extendEnv: false,
      reject: false,
      timeout: DOC_TIMEOUT_MS,
      windowsHide: true,
      stdin: 'ignore',
      maxBuffer: MAX_OUTPUT_BYTES,
      ...(signal && { cancelSignal: signal }),
    })
    stdout = String(result.stdout ?? '')
    stderr = String(result.stderr ?? '')
    if (result.timedOut) {
      return { ok: false, reason: 'failed', message: `${describePythonEnv(env)} did not finish reading the file within ${DOC_TIMEOUT_MS / 1000}s.` }
    }
  } catch (error) {
    return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) }
  }

  const line = stdout.split(/\r?\n/).reverse().find(l => l.trim().startsWith('{'))
  let data: Record<string, unknown> | undefined
  try {
    data = line ? (JSON.parse(line) as Record<string, unknown>) : undefined
  } catch {
    data = undefined
  }
  if (!data) {
    const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400)
    return { ok: false, reason: 'failed', message: `${describePythonEnv(env)} could not read the file${detail ? `: ${detail}` : '.'}` }
  }
  if (data.error === 'missing') {
    // Present when probed, gone or broken now: check again next time.
    for (const module of MODULES[mode]) forgetPythonModule(env.executable, module)
    return {
      ok: false,
      reason: 'missing',
      message: await missingMessage(mode, [env], typeof data.module === 'string' ? data.module : undefined),
    }
  }
  if (data.error === 'password') {
    return { ok: false, reason: 'password', message: 'The file is password-protected. Please provide an unprotected version.' }
  }
  if (data.error) {
    const detail = [data.type, data.message].filter(v => typeof v === 'string' && v).join(': ')
    return { ok: false, reason: 'failed', message: `Could not read the file with ${String(data.library ?? PYTHON_DOC_PACKAGES[mode])}${detail ? ` (${detail})` : ''}. It may be corrupt, encrypted or not really this format.` }
  }
  return { ok: true, env, library: typeof data.library === 'string' ? data.library : PYTHON_DOC_PACKAGES[mode], data }
}

// Converted Office documents, keyed by identity on disk, so re-reading the
// same file does not start Python again.
const markdownCache = new Map<string, { markdown: string; library: string; python: string }>()

export function resetPythonDocCache(): void {
  markdownCache.clear()
}

const OFFICE_MODES: Readonly<Record<string, PythonDocMode>> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.xls': 'xls',
  '.pptx': 'pptx',
}

/** The reader mode for an Office extension (with or without the dot), if any. */
export function officeModeFor(ext: string): PythonDocMode | undefined {
  const normalized = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase()
  return OFFICE_MODES[normalized]
}

export const LOCAL_OFFICE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(OFFICE_MODES))

/** Rows kept per spreadsheet sheet; the Read tool pages through the rest. */
const MAX_SHEET_ROWS = 5000

export type LocalOfficeResult =
  | { ok: true; markdown: string; library: string; python: string; cached: boolean }
  | { ok: false; reason: 'missing' | 'password' | 'failed'; message: string }

/** Convert an Office document to markdown with a local Python library. */
export async function readOfficeWithPython(
  filePath: string,
  mode: PythonDocMode,
  signal?: AbortSignal,
): Promise<LocalOfficeResult> {
  const info = await stat(filePath)
  const key = `${filePath}:${Math.floor(info.mtimeMs)}:${info.size}`
  const cached = markdownCache.get(key)
  if (cached) return { ok: true, ...cached, cached: true }
  const args = mode === 'xlsx' || mode === 'xls' ? [String(MAX_SHEET_ROWS)] : []
  const result = await runPythonDocReader(mode, filePath, args, signal)
  if (!result.ok) return result
  const markdown = typeof result.data.markdown === 'string' ? result.data.markdown : ''
  const entry = { markdown, library: result.library, python: describePythonEnv(result.env) }
  markdownCache.set(key, entry)
  return { ok: true, ...entry, cached: false }
}
