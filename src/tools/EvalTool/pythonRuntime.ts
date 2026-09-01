import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { logForDebugging } from '../../utils/debug.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  EVAL_DISABLE_ENV,
  EVAL_PYTHON_ENV,
  EVAL_SKIP_PROBE_ENV,
  PROBE_TIMEOUT_MS,
} from './constants.js'
import { PYTHON_KERNEL_SOURCE } from './kernelSource.js'

/**
 * Interpreter discovery, environment filtering, and the availability latch.
 *
 * The latch is the cache-critical part. `isEvalToolEnabled()` is called while
 * `getAllBaseTools()` builds the tool list, and its answer is memoized for the
 * life of the process. A tool that becomes available on turn 3 — because a
 * venv appeared, or a probe finally succeeded — would show up as a `+1 tools`
 * schema change and invalidate the whole cached prefix. Deciding once, before
 * the first request, is the only cache-safe option.
 */

let cachedInterpreter: string | null | undefined
let cachedEnabled: boolean | undefined
let cachedRunnerPath: string | undefined

/**
 * Does this candidate start, and is it a Python new enough to run the kernel?
 *
 * The version gate is not cosmetic. It rejects Python 2, and it rejects the
 * Windows Store `python3` alias stub, which exists on a default Windows install
 * and would otherwise be picked ahead of a real interpreter. The kernel uses
 * 3.10 syntax, so anything older would fail at import time with a confusing
 * SyntaxError instead of a clean "no interpreter" message.
 */
function probe(candidate: string): boolean {
  try {
    const result = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: 'ignore',
      // Never inherit the host console handle here. omp hit a case where an
      // inherited stdin handle kept a probe subprocess alive indefinitely on
      // native Windows even though the script never reads stdin.
      windowsHide: true,
    })
    return result.status === 0
  } catch {
    return false
  }
}

function venvInterpreter(root: string): string | null {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin'
  const exe = process.platform === 'win32' ? 'python.exe' : 'python'
  const candidate = join(root, binDir, exe)
  return existsSync(candidate) ? candidate : null
}

/**
 * Resolve the interpreter once, in this order:
 *   1. TAU_EVAL_PYTHON (explicit override, never second-guessed)
 *   2. an active virtualenv ($VIRTUAL_ENV, then $CONDA_PREFIX)
 *   3. a project venv at <cwd>/.venv or <cwd>/venv
 *   4. `python` / `python3` on PATH
 */
export function resolvePythonInterpreter(): string | null {
  if (cachedInterpreter !== undefined) return cachedInterpreter

  const explicit = process.env[EVAL_PYTHON_ENV]?.trim()
  if (explicit) {
    cachedInterpreter = probe(explicit) ? explicit : null
    if (!cachedInterpreter) {
      logForDebugging(
        `Eval: ${EVAL_PYTHON_ENV}=${explicit} did not start; the tool stays disabled`,
        { level: 'warn' },
      )
    }
    return cachedInterpreter
  }

  const roots = [
    process.env.VIRTUAL_ENV,
    process.env.CONDA_PREFIX,
    join(getCwd(), '.venv'),
    join(getCwd(), 'venv'),
  ].filter((root): root is string => Boolean(root))

  const candidates: string[] = []
  for (const root of roots) {
    const found = venvInterpreter(root)
    if (found) candidates.push(found)
  }
  candidates.push('python3', 'python')

  for (const candidate of candidates) {
    if (probe(candidate)) {
      cachedInterpreter = candidate
      logForDebugging(`Eval: using interpreter ${candidate}`)
      return cachedInterpreter
    }
  }

  cachedInterpreter = null
  return cachedInterpreter
}

/**
 * Whether the Eval tool registers this session. LATCHED — see the module
 * comment and `constants.ts`. Never make this depend on anything that can
 * change mid-session.
 */
export function isEvalToolEnabled(): boolean {
  if (cachedEnabled !== undefined) return cachedEnabled
  if (isEnvTruthy(process.env[EVAL_DISABLE_ENV])) {
    cachedEnabled = false
    return cachedEnabled
  }
  if (isEnvTruthy(process.env[EVAL_SKIP_PROBE_ENV])) {
    cachedEnabled = true
    return cachedEnabled
  }
  cachedEnabled = resolvePythonInterpreter() !== null
  return cachedEnabled
}

/** Test-only: forget the latched decision so a test can probe a new state. */
export function __resetEvalRuntimeCacheForTests(): void {
  cachedInterpreter = undefined
  cachedEnabled = undefined
  cachedRunnerPath = undefined
}

/**
 * Materialize the kernel to a hashed path under the OS temp dir. Hashing the
 * source means a Tau upgrade writes a new file instead of racing a running
 * kernel that still has the old one mapped.
 */
export function ensureRunnerOnDisk(): string {
  if (cachedRunnerPath && existsSync(cachedRunnerPath)) return cachedRunnerPath
  const hash = createHash('sha256')
    .update(PYTHON_KERNEL_SOURCE)
    .digest('hex')
    .slice(0, 16)
  const dir = join(tmpdir(), 'tau-eval-kernel', hash)
  const file = join(dir, 'tau_kernel.py')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, PYTHON_KERNEL_SOURCE, 'utf8')
  }
  cachedRunnerPath = file
  return file
}

/**
 * Names that must never reach the kernel even if they pass the allowlist.
 * The kernel runs model-authored code; Tau holds credentials for more than
 * twenty providers, and there is no working filesystem sandbox on Windows to
 * fall back on (`lanes/shared/sandbox.ts` degrades to an env-scoped spawn).
 * Keeping secrets out of `os.environ` is the control that actually holds.
 */
const SECRET_NAME = /API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SESSION[_-]?KEY|AUTH/i

const ENV_ALLOW = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'USERNAME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'APPDATA',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'MPLBACKEND',
  'MPLCONFIGDIR',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'NO_PROXY',
])

const ENV_ALLOW_PREFIXES = ['LC_', 'XDG_']

/**
 * Build the kernel's environment: an allowlist, plus anything matching an
 * allowed prefix, minus anything that looks like a secret. Proxy variables are
 * deliberately dropped — the kernel's only mandatory network peer is the
 * host's own loopback bridge, and a proxy in front of that would break it.
 */
export function buildKernelEnv(
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    const allowed =
      ENV_ALLOW.has(upper) ||
      ENV_ALLOW_PREFIXES.some(prefix => upper.startsWith(prefix))
    if (!allowed) continue
    if (SECRET_NAME.test(key)) continue
    out[key] = value
  }
  out.PYTHONUNBUFFERED = '1'
  out.PYTHONIOENCODING = 'utf-8'
  out.PYTHONDONTWRITEBYTECODE = '1'
  return { ...out, ...extra }
}
