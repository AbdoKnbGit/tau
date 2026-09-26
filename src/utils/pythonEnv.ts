/**
 * Which Python interpreters this machine offers, and which of them can import
 * a given module.
 *
 * A machine often has several: the project's virtualenv, an activated conda
 * env, the system Python, the `py` launcher's default. The Eval kernel runs one
 * of them, `python` in Bash can be another, and a package installed for one is
 * invisible to the others. Checking a package in one interpreter and running
 * the code in another is how "pymupdf is available" turns into
 * `ModuleNotFoundError` one call later.
 *
 * Everything that needs a Python package asks here instead of guessing: the
 * Read tool looks for a document library, and the Eval, Bash and PowerShell
 * tools explain a failed import. The order is always the same: an explicit
 * override, the active environment, the project's venv, then the system
 * interpreters on PATH.
 *
 * Nothing here installs anything. When no interpreter has a package, callers
 * get the one command that installs it into the right environment (uv-aware,
 * with the real package name), and the model runs it through a normal, visible
 * tool call. Installing on its own would be wrong twice over: the name in
 * "No module named 'x'" is not always the package name (`pip install fitz`,
 * `docx` or `sklearn` install unrelated packages), and it would change the
 * user's environment without asking.
 */
import { createHash } from 'crypto'
import { execa } from 'execa'
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { EVAL_PYTHON_ENV } from '../tools/EvalTool/constants.js'
import { getCwd } from './cwd.js'
import { findGitRoot } from './git.js'
import { which } from './which.js'

export type PythonOrigin =
  | 'override'
  | 'active-venv'
  | 'active-conda'
  | 'project-venv'
  | 'path'

export type PythonCandidate = {
  /** What to spawn: an interpreter path, or a name looked up on PATH. */
  command: string
  /** Leading arguments, e.g. `-3` for the Windows `py` launcher. */
  args: string[]
  origin: PythonOrigin
}

export type PythonEnv = PythonCandidate & {
  executable: string
  version: string
  prefix: string
  kind: 'venv' | 'conda' | 'system'
  /** The venv was made by uv (its pyvenv.cfg says so). */
  uv: boolean
  pip: boolean
  /** PEP 668: the OS owns this Python and pip refuses to install into it. */
  externallyManaged: boolean
}

export type ModuleInfo = { dist?: string; version?: string }

export type ModuleProbe = {
  env: PythonEnv
  /** Requested module -> its info when importable, null when not. */
  found: Record<string, ModuleInfo | null>
}

const PROBE_TIMEOUT_MS = 8_000

/**
 * Prints one JSON line about the interpreter and the requested top-level
 * modules. Plain syntax on purpose: it has to run on whatever Python a
 * candidate turns out to be, and anything older than 3 simply fails to parse
 * as a probe. `find_spec` locates a module without importing it, so checking
 * a heavy package costs nothing.
 *
 * The package that provides a found module is read from the *.dist-info
 * folders beside it (top_level.txt, else RECORD), which takes milliseconds.
 * `importlib.metadata.packages_distributions()` would do the same for every
 * installed package and takes seconds on a well-stocked system Python.
 */
const PROBE_SCRIPT = [
  'import sys, os, json',
  'try:',
  '    import importlib.util as u',
  'except Exception:',
  '    u = None',
  'def spec(m):',
  '    try:',
  '        return u.find_spec(m) if u is not None else None',
  '    except Exception:',
  '        return None',
  'def meta_name(info):',
  '    try:',
  '        with open(os.path.join(info, "METADATA"), encoding="utf-8", errors="replace") as f:',
  '            fields = {}',
  '            for line in f:',
  '                if not line.strip():',
  '                    break',
  '                k, _, v = line.partition(":")',
  '                fields.setdefault(k.strip().lower(), v.strip())',
  '            return fields.get("name"), fields.get("version")',
  '    except Exception:',
  '        return None, None',
  'def dist_of(m, s):',
  '    locs = list(s.submodule_search_locations or [])',
  '    loc = locs[0] if locs else s.origin',
  '    if not loc:',
  '        return None',
  '    site = os.path.dirname(loc)',
  '    try:',
  '        infos = [os.path.join(site, e) for e in os.listdir(site) if e.endswith(".dist-info")]',
  '    except Exception:',
  '        return None',
  '    for info in infos:',
  '        try:',
  '            with open(os.path.join(info, "top_level.txt"), encoding="utf-8", errors="replace") as f:',
  '                if m in f.read().split():',
  '                    return meta_name(info)',
  '        except Exception:',
  '            pass',
  '    prefixes = (m + "/", m + ".py,", m + ".")',
  '    for info in infos:',
  '        try:',
  '            with open(os.path.join(info, "RECORD"), encoding="utf-8", errors="replace") as f:',
  '                if any(line.startswith(prefixes) for line in f):',
  '                    return meta_name(info)',
  '        except Exception:',
  '            pass',
  '    return None',
  'mods = [m for m in sys.argv[1:] if m]',
  'found = {}',
  'dist = {}',
  'for m in mods:',
  '    s = spec(m)',
  '    found[m] = s is not None',
  '    if s is not None:',
  '        try:',
  '            d = dist_of(m, s)',
  '            if d and d[0]:',
  '                dist[m] = [d[0], d[1]]',
  '        except Exception:',
  '            pass',
  'base = getattr(sys, "base_prefix", sys.prefix)',
  'uv = False',
  'try:',
  '    with open(os.path.join(sys.prefix, "pyvenv.cfg")) as f:',
  '        uv = any(l.split("=")[0].strip().lower() == "uv" for l in f)',
  'except Exception:',
  '    pass',
  'managed = False',
  'try:',
  '    import sysconfig',
  '    managed = os.path.exists(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED"))',
  'except Exception:',
  '    pass',
  'print(json.dumps({"tau": 1, "executable": sys.executable, "version": "%d.%d.%d" % tuple(sys.version_info[:3]),',
  '    "prefix": sys.prefix, "venv": sys.prefix != base, "conda": os.path.isdir(os.path.join(sys.prefix, "conda-meta")),',
  '    "uv": uv, "pip": spec("pip") is not None, "managed": managed, "found": found, "dist": dist}))',
].join('\n')

/** The interpreter inside a venv or conda prefix, if there is one. */
export function interpreterInPrefix(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  // A venv keeps it in Scripts\ (Windows) or bin/; conda on Windows keeps it
  // at the prefix root.
  const relative =
    platform === 'win32'
      ? ['Scripts\\python.exe', 'python.exe']
      : ['bin/python3', 'bin/python']
  for (const rel of relative) {
    const candidate = join(root, rel)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Directories whose `.venv`/`venv` belong to this project: the cwd and each
 * parent up to the git root. Without a git root only the cwd counts, so a
 * stray venv in a home directory is never taken for the project's.
 */
function projectDirs(cwd: string, platform: NodeJS.Platform): string[] {
  const root = findGitRoot(cwd)
  if (!root) return [cwd]
  const same = (a: string, b: string) =>
    platform === 'win32'
      ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
      : resolve(a) === resolve(b)
  const dirs = [cwd]
  let dir = cwd
  while (!same(dir, root)) {
    const parent = dirname(dir)
    // Walked off the top without meeting the git root (a symlinked or
    // differently spelled cwd): trust only the cwd itself.
    if (parent === dir) return [cwd]
    dir = parent
    dirs.push(dir)
  }
  return dirs
}

/** Every interpreter worth checking, most specific first. */
export function pythonCandidates(
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
  } = {},
): PythonCandidate[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const cwd = options.cwd ?? getCwd()
  const out: PythonCandidate[] = []
  const add = (command: string | null, origin: PythonOrigin, args: string[] = []) => {
    if (!command) return
    const key = `${command}\0${args.join('\0')}`
    if (out.some(c => `${c.command}\0${c.args.join('\0')}` === key)) return
    out.push({ command, args, origin })
  }

  const override = env[EVAL_PYTHON_ENV]?.trim()
  if (override) add(override, 'override')
  if (env.VIRTUAL_ENV) add(interpreterInPrefix(env.VIRTUAL_ENV, platform), 'active-venv')
  if (env.CONDA_PREFIX) add(interpreterInPrefix(env.CONDA_PREFIX, platform), 'active-conda')
  for (const dir of projectDirs(cwd, platform)) {
    for (const name of ['.venv', 'venv']) {
      const root = join(dir, name)
      if (existsSync(join(root, 'pyvenv.cfg'))) {
        add(interpreterInPrefix(root, platform), 'project-venv')
      }
    }
  }
  if (platform === 'win32') {
    add('python', 'path')
    add('py', 'path', ['-3'])
    add('python3', 'path')
  } else {
    add('python3', 'path')
    add('python', 'path')
  }
  return out
}

type ProbeJson = {
  tau?: number
  executable?: string
  version?: string
  prefix?: string
  venv?: boolean
  conda?: boolean
  uv?: boolean
  pip?: boolean
  managed?: boolean
  found?: Record<string, boolean>
  dist?: Record<string, [string, string | null]>
}

/** Parse the probe's output; null for anything that is not a real probe. */
export function parseProbeOutput(
  candidate: PythonCandidate,
  stdout: string,
): { env: PythonEnv; found: Record<string, ModuleInfo | null> } | null {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find(l => l.trim().startsWith('{'))
  if (!line) return null
  let json: ProbeJson
  try {
    json = JSON.parse(line) as ProbeJson
  } catch {
    return null
  }
  if (json.tau !== 1 || !json.executable || !json.version) return null
  if (Number.parseInt(json.version, 10) < 3) return null
  const env: PythonEnv = {
    ...candidate,
    executable: json.executable,
    version: json.version,
    prefix: json.prefix ?? '',
    kind: json.conda ? 'conda' : json.venv ? 'venv' : 'system',
    uv: json.uv === true,
    pip: json.pip === true,
    externallyManaged: json.managed === true && !json.venv && !json.conda,
  }
  const found: Record<string, ModuleInfo | null> = {}
  for (const [name, ok] of Object.entries(json.found ?? {})) {
    const dist = json.dist?.[name]
    found[name] = ok
      ? { ...(dist?.[0] && { dist: dist[0] }), ...(dist?.[1] && { version: dist[1] }) }
      : null
  }
  return { env, found }
}

// Session memory. Interpreter facts do not change; a module that is present
// stays present. A missing module is always checked again, because the fix
// for it is an install that may have just happened.
const envByCandidate = new Map<string, PythonEnv | null>()
const presentModules = new Map<string, Map<string, ModuleInfo>>()

const scriptPaths = new Map<string, string>()

/**
 * Write a Python script tau ships to a path under the OS temp dir named by
 * its content hash, so a Tau upgrade writes a new file instead of changing
 * one a running process may be reading. Returns the path.
 */
export function ensurePythonScript(name: string, source: string): string {
  const cached = scriptPaths.get(name)
  if (cached && existsSync(cached)) return cached
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const dir = join(tmpdir(), 'tau-python', hash)
  const file = join(dir, name)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    // Write-then-rename, so a concurrent reader never sees half a script.
    const partial = `${file}.${process.pid}.tmp`
    writeFileSync(partial, source, 'utf8')
    try {
      renameSync(partial, file)
    } catch {
      // Another process won the race with identical content.
      rmSync(partial, { force: true })
    }
  }
  scriptPaths.set(name, file)
  return file
}

function candidateKey(candidate: PythonCandidate): string {
  return `${candidate.command}\0${candidate.args.join('\0')}`
}

function executableKey(executable: string): string {
  const normalized = resolve(executable)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Test seam, and the reset after anything that changes environments. */
export function resetPythonEnvCache(): void {
  envByCandidate.clear()
  presentModules.clear()
}

/** Forget that `module` was present, e.g. after its import failed anyway. */
export function forgetPythonModule(executable: string, module: string): void {
  presentModules.get(executableKey(executable))?.delete(module)
}

async function probe(
  candidate: PythonCandidate,
  modules: string[],
): Promise<ModuleProbe | null> {
  const key = candidateKey(candidate)
  const knownEnv = envByCandidate.get(key)
  if (knownEnv === null) return null
  if (knownEnv) {
    const present = presentModules.get(executableKey(knownEnv.executable))
    if (modules.every(m => present?.has(m))) {
      return {
        env: knownEnv,
        found: Object.fromEntries(modules.map(m => [m, present!.get(m)!])),
      }
    }
  }
  let stdout = ''
  try {
    // The script goes in a file, not `-c`: a long multi-line argument makes
    // Windows' Microsoft Store `python3` stub hang until the timeout instead
    // of exiting, and quoting it through CreateProcess is fragile anyway. The
    // environment is the user's own, as when they type `python`: the probe
    // runs only the fixed script above, so there is nothing to shield it from.
    const result = await execa(
      candidate.command,
      [...candidate.args, ensurePythonScript('tau_probe.py', PROBE_SCRIPT), ...modules],
      {
        env: { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
        reject: false,
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        stdin: 'ignore',
      },
    )
    stdout = String(result.stdout ?? '')
  } catch {
    // Not startable: same as no output.
  }
  const parsed = parseProbeOutput(candidate, stdout)
  if (!parsed) {
    // Only remember "not a Python" for a real miss; a timeout can be a slow
    // first start and deserves another try later.
    if (!knownEnv) envByCandidate.set(key, null)
    return null
  }
  envByCandidate.set(key, parsed.env)
  const presentKey = executableKey(parsed.env.executable)
  const present = presentModules.get(presentKey) ?? new Map<string, ModuleInfo>()
  for (const [name, info] of Object.entries(parsed.found)) {
    if (info) present.set(name, info)
  }
  presentModules.set(presentKey, present)
  return parsed
}

/**
 * Check `modules` in every candidate, in parallel. Results keep candidate
 * order, one per distinct interpreter (a venv found twice, or `python` and
 * `py` pointing at the same install, count once).
 */
export async function probePythonModules(
  modules: string[],
  options: { cwd?: string } = {},
): Promise<ModuleProbe[]> {
  const topLevel = [...new Set(modules.map(m => m.split('.')[0]!).filter(Boolean))]
  const candidates = pythonCandidates({ cwd: options.cwd })
  const results = await Promise.all(candidates.map(c => probe(c, topLevel)))
  const seen = new Set<string>()
  const out: ModuleProbe[] = []
  for (const result of results) {
    if (!result) continue
    const key = executableKey(result.env.executable)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(result)
  }
  return out
}

/**
 * Probe one interpreter that is not necessarily a candidate, e.g. the path a
 * shell command named, or the Eval kernel's interpreter.
 */
export async function probePythonInterpreter(
  command: string,
  modules: string[],
  args: string[] = [],
): Promise<ModuleProbe | null> {
  const topLevel = [...new Set(modules.map(m => m.split('.')[0]!).filter(Boolean))]
  return probe({ command, args, origin: 'path' }, topLevel)
}

/** True when both paths name the same interpreter file. */
export function sameInterpreter(a: string, b: string): boolean {
  return executableKey(a) === executableKey(b)
}

/** The first interpreter that has any of `modules`, and which one it has. */
export async function findPythonWithModule(
  modules: string[],
  options: { cwd?: string } = {},
): Promise<{ env: PythonEnv; module: string; info: ModuleInfo } | { checked: PythonEnv[] }> {
  const probes = await probePythonModules(modules, options)
  for (const { env, found } of probes) {
    for (const module of modules) {
      const info = found[module.split('.')[0]!]
      if (info) return { env, module, info }
    }
  }
  return { checked: probes.map(p => p.env) }
}

/**
 * Where a missing package should go: the project's own environment when there
 * is one (an explicit override, the active env, the project venv), else the
 * first system Python.
 */
export function preferredInstallTarget(
  checked: readonly PythonEnv[],
): PythonEnv | undefined {
  return checked.find(env => env.origin !== 'path') ?? checked[0]
}

/**
 * Import names whose PyPI package is named differently. Installing the import
 * name gets a different, unrelated package for several of these (`fitz`,
 * `docx`, `sklearn`), so the real name matters.
 */
const KNOWN_DISTRIBUTIONS: Readonly<Record<string, string>> = {
  fitz: 'PyMuPDF',
  pymupdf: 'PyMuPDF',
  docx: 'python-docx',
  pptx: 'python-pptx',
  yaml: 'PyYAML',
  PIL: 'Pillow',
  cv2: 'opencv-python',
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  dotenv: 'python-dotenv',
  jwt: 'PyJWT',
  Crypto: 'pycryptodome',
  serial: 'pyserial',
  usb: 'pyusb',
  magic: 'python-magic',
  attr: 'attrs',
  win32api: 'pywin32',
  win32con: 'pywin32',
  win32com: 'pywin32',
  pywintypes: 'pywin32',
  OpenSSL: 'pyOpenSSL',
  MySQLdb: 'mysqlclient',
  pdfminer: 'pdfminer.six',
  gi: 'PyGObject',
  wx: 'wxPython',
  OpenGL: 'PyOpenGL',
  zmq: 'pyzmq',
  jose: 'python-jose',
  multipart: 'python-multipart',
  slugify: 'python-slugify',
  telegram: 'python-telegram-bot',
  dns: 'dnspython',
  git: 'GitPython',
  socks: 'PySocks',
}

/**
 * The package that provides `module`. `known` is what an interpreter that has
 * it reported; failing that the table above; failing that the import name,
 * marked uncertain so the caller can say so.
 */
export function distributionForModule(
  module: string,
  known?: string,
): { name: string; certain: boolean } {
  const top = module.split('.')[0]!
  if (known) return { name: known, certain: true }
  const mapped = KNOWN_DISTRIBUTIONS[top]
  if (mapped) return { name: mapped, certain: true }
  return { name: top, certain: false }
}

export type ShellKind = 'bash' | 'powershell'

/** An interpreter path as a shell argument. */
export function shellArg(
  path: string,
  shell: ShellKind,
  platform: NodeJS.Platform = process.platform,
): string {
  // Forward slashes work for Windows paths in Git Bash, PowerShell and the
  // programs themselves, and need no quoting when nothing else is special.
  const forward = platform === 'win32' ? path.replace(/\\/g, '/') : path
  if (/^[\w.:/+@-]+$/.test(forward)) return forward
  return shell === 'powershell'
    ? `'${path.replace(/'/g, "''")}'`
    : `"${forward.replace(/(["\\$`])/g, '\\$1')}"`
}

/** An interpreter path in command position. PowerShell needs `&` to run a quoted path. */
export function shellCommand(
  path: string,
  shell: ShellKind,
  platform: NodeJS.Platform = process.platform,
): string {
  const arg = shellArg(path, shell, platform)
  return shell === 'powershell' && arg.startsWith("'") ? `& ${arg}` : arg
}

/**
 * The command(s) that install `packages` into `env`, or advice when pip may
 * not install there at all (an OS-managed Python).
 */
export function pythonInstallSteps(
  env: PythonEnv,
  packages: readonly string[],
  shell: ShellKind,
  uvAvailable: boolean,
  platform: NodeJS.Platform = process.platform,
): { commands: string[]; advice?: string } {
  const names = packages.join(' ')
  const python = shellCommand(env.executable, shell, platform)
  const pythonArg = shellArg(env.executable, shell, platform)
  if (env.externallyManaged) {
    return {
      commands: [],
      advice: `This Python (${env.executable}) is managed by the operating system, so pip will not install into it. Create a virtual environment in the project (\`uv venv\`, or \`${python} -m venv .venv\`) and install ${names} there.`,
    }
  }
  // uv-made venvs usually have no pip, and uv installs faster anyway.
  if (uvAvailable && env.kind !== 'system' && (env.uv || !env.pip)) {
    return { commands: [`uv pip install --python ${pythonArg} ${names}`] }
  }
  if (env.pip) {
    return {
      commands: [
        `${python} -m pip install ${env.kind === 'system' ? '--user ' : ''}${names}`,
      ],
    }
  }
  return {
    commands: [
      `${python} -m ensurepip --upgrade`,
      `${python} -m pip install ${env.kind === 'system' ? '--user ' : ''}${names}`,
    ],
  }
}

let uvAvailable: Promise<boolean> | undefined

export function isUvAvailable(): Promise<boolean> {
  uvAvailable ??= which('uv').then(
    path => Boolean(path),
    () => false,
  )
  return uvAvailable
}

/** "C:\...\python.exe (3.11.9, project venv)" */
export function describePythonEnv(env: PythonEnv): string {
  const where =
    env.kind === 'conda'
      ? 'conda env'
      : env.kind === 'venv'
        ? env.origin === 'project-venv'
          ? 'project venv'
          : env.origin === 'active-venv'
            ? 'active venv'
            : 'venv'
        : 'system Python'
  return `${env.executable} (${env.version}, ${where})`
}

/** Install instructions as one sentence, for tool results. */
export async function describeInstall(
  env: PythonEnv,
  packages: readonly string[],
  shell: ShellKind,
): Promise<string> {
  const steps = pythonInstallSteps(env, packages, shell, await isUvAvailable())
  if (steps.advice) return steps.advice
  return steps.commands.length === 1
    ? `\`${steps.commands[0]}\``
    : steps.commands.map(c => `\`${c}\``).join(', then ')
}
