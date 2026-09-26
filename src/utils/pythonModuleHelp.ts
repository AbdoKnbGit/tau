/**
 * The precheck behind a failed Python import, shared by the Eval, Bash and
 * PowerShell tools.
 *
 * "No module named 'x'" alone sends a model guessing: it installs into some
 * interpreter, re-runs in another, or gives up and switches tools. Before that
 * happens, tau checks every interpreter it can find (pythonEnv.ts) and states
 * the facts in one note: which Python ran the code, which ones have the
 * package, and the one call that fixes it. Nothing is installed here; the
 * model makes that call through a normal, visible tool call.
 */
import { existsSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { getCwd } from './cwd.js'
import {
  describePythonEnv,
  distributionForModule,
  isUvAvailable,
  preferredInstallTarget,
  probePythonInterpreter,
  probePythonModules,
  pythonInstallSteps,
  sameInterpreter,
  shellCommand,
  type ModuleProbe,
  type PythonEnv,
  type ShellKind,
} from './pythonEnv.js'

function formatSteps(commands: readonly string[]): string {
  return commands.map(c => `\`${c}\``).join(', then ')
}

/** The module a Python traceback in `output` failed to import, if any. */
export function missingPythonModule(output: string): string | undefined {
  const pattern =
    /(?:ModuleNotFoundError|ImportError): No module named ['"]?([A-Za-z_][\w.]*)['"]?/g
  let last: string | undefined
  for (const match of output.matchAll(pattern)) last = match[1]
  return last
}

/**
 * The interpreter a shell command runs, when the command says: an explicit
 * path to a python executable, or a bare `python`/`python3.x`/`py`. Commands
 * that pick the interpreter some other way (`uv run`, a shebang, pytest)
 * return undefined, and the note then says only where the module is.
 */
export function interpreterInCommand(
  command: string,
): { command: string; args: string[] } | undefined {
  // An environment manager picks the interpreter itself (usually the
  // project's venv), whatever `python` on PATH is.
  if (/\b(?:uv|poetry|pipenv|pdm|hatch|conda|mamba|micromamba|rye)\s+run\b|\buvx\b|\bpipx\s+run\b/i.test(command)) {
    return undefined
  }
  const name = String.raw`(?:python(?:\d+(?:\.\d+)?)?|py)(?:\.exe)?`
  // A quoted path may contain spaces; an unquoted one ends at whitespace.
  const quoted = new RegExp(String.raw`(?:^|[\s;&|(])(["'])((?:[^"']*[\\/])?${name})\1(?=\s|$)`, 'i')
  const bare = new RegExp(String.raw`(?:^|[\s;&|(])((?:[^\s"';&|()]*[\\/])?${name})(?=\s|$)`, 'i')
  const matches = [quoted.exec(command), bare.exec(command)].filter(
    (m): m is RegExpExecArray => m !== null,
  )
  const first = matches.sort((a, b) => a.index - b.index)[0]
  if (!first) return undefined
  const found = (first.length > 2 ? first[2] : first[1])!
  if (/^py(?:\.exe)?$/i.test(found)) return { command: 'py', args: ['-3'] }
  return { command: found, args: [] }
}

/** Where the project's own module `top` lives, if it is one. */
function localModulePath(top: string, cwd: string): string | undefined {
  for (const dir of [cwd, join(cwd, 'src')]) {
    for (const candidate of [join(dir, `${top}.py`), join(dir, top, '__init__.py')]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export async function describeMissingPythonModule(options: {
  module: string
  tool: 'eval' | 'bash' | 'powershell'
  /** The interpreter that ran the code, when known (the Eval kernel's). */
  interpreter?: string
  /** The shell command that ran, for Bash and PowerShell. */
  command?: string
  cwd?: string
}): Promise<string | undefined> {
  const cwd = options.cwd ?? getCwd()
  const top = options.module.split('.')[0]!
  if (!top) return undefined

  const local = localModulePath(top, cwd)
  if (local) {
    return `Python environment check: \`${top}\` is this project's own module (${local}), not a package to install. Run the code from the directory that contains it, or add that directory to sys.path / PYTHONPATH.`
  }

  let named: { command: string; args: string[] } | undefined
  if (options.interpreter) named = { command: options.interpreter, args: [] }
  else if (options.command) named = interpreterInCommand(options.command)
  if (named && /[\\/]/.test(named.command) && !isAbsolute(named.command)) {
    named = { ...named, command: resolve(cwd, named.command) }
  }

  const [probes, ranProbe] = await Promise.all([
    probePythonModules([top], { cwd }),
    named ? probePythonInterpreter(named.command, [top], named.args) : Promise.resolve(null),
  ])
  // Prefer the candidate's record of the same interpreter: it knows whether
  // this is the project's venv.
  const ran: ModuleProbe | undefined = ranProbe
    ? (probes.find(p => sameInterpreter(p.env.executable, ranProbe.env.executable)) ?? ranProbe)
    : undefined
  // The interpreter that ran it has the module after all: the failure is
  // about something else (sys.path, a shadowing file), so say nothing.
  if (ran?.found[top]) return undefined

  const isRan = (env: PythonEnv) =>
    ran !== undefined && sameInterpreter(env.executable, ran.env.executable)
  const others = probes.filter(p => p.found[top] && !isRan(p.env))
  if (!ran && probes.length === 0) return undefined

  const known = others.find(p => p.found[top]?.dist)?.found[top]?.dist
  const dist = distributionForModule(top, known)
  const shell: ShellKind = options.tool === 'powershell' ? 'powershell' : 'bash'
  const parts: string[] = []

  parts.push(
    ran
      ? `Python environment check: \`${top}\` is not installed for the Python that ran this — ${describePythonEnv(ran.env)}.`
      : `Python environment check: \`${top}\` could not be imported.`,
  )
  if (others.length > 0) {
    const where = others
      .slice(0, 3)
      .map(p => {
        const info = p.found[top]
        const pkg = info?.dist ? ` as ${info.dist}${info.version ? ` ${info.version}` : ''}` : ''
        return `${describePythonEnv(p.env)}${pkg}`
      })
      .join('; ')
    parts.push(`It is installed for: ${where}. A package installed for one Python cannot be imported by another.`)
  } else {
    const checked = probes.filter(p => !isRan(p.env)).map(p => describePythonEnv(p.env))
    if (checked.length > 0) parts.push(`No other Python here has it either (checked: ${checked.join('; ')}).`)
  }

  if (options.tool === 'eval') {
    parts.push(
      `Install it into the kernel's own environment with a cell: \`%pip install ${dist.name}\`, then re-run the cell. Do not switch to another interpreter mid-task: the kernel keeps its state in this one.`,
    )
  } else {
    // The project's own environment first (venv, then the rest), the way the
    // project would run it; the interpreter that ran the command otherwise.
    const envs = probes.map(p => p.env)
    const target =
      envs.find(env => env.origin !== 'path') ?? ran?.env ?? preferredInstallTarget(envs)
    const withModule = others.find(p => p.env.origin !== 'path') ?? others[0]
    const uv = await isUvAvailable()
    const installInto = (env: PythonEnv) =>
      pythonInstallSteps(env, [dist.name], shell, uv)
    if (withModule) {
      const run = shellCommand(withModule.env.executable, shell)
      const steps =
        target && !others.some(p => sameInterpreter(p.env.executable, target.executable))
          ? installInto(target)
          : undefined
      parts.push(
        steps && steps.commands.length > 0
          ? `Run it with that interpreter (\`${run} …\`), or install it into ${describePythonEnv(target!)}: ${formatSteps(steps.commands)}.`
          : `Run it with that interpreter: \`${run} …\`.`,
      )
    } else if (target) {
      const steps = installInto(target)
      if (steps.advice) {
        parts.push(steps.advice)
      } else {
        const rerun =
          ran && !sameInterpreter(target.executable, ran.env.executable)
            ? `, then run the command with that interpreter (\`${shellCommand(target.executable, shell)} …\`)`
            : ', then re-run'
        parts.push(`Install it into ${describePythonEnv(target)}: ${formatSteps(steps.commands)}${rerun}.`)
      }
    }
  }
  if (!dist.certain) {
    parts.push(`(If \`${top}\`'s package on PyPI has another name, install that name.)`)
  }
  return parts.join(' ')
}

/**
 * The precheck note for a failed command's output, when a Python import is
 * what failed. Never throws: the note is a help, not part of the command.
 */
export async function pythonModuleNoteFor(
  output: string,
  options: { tool: 'bash' | 'powershell'; command: string; cwd?: string },
): Promise<string | undefined> {
  const module = missingPythonModule(output)
  if (!module || output.includes('Python environment check:')) return undefined
  try {
    return await describeMissingPythonModule({ module, ...options })
  } catch {
    return undefined
  }
}

/** Append the precheck note to a failed command's output, when it applies. */
export async function appendPythonModuleHelp(
  output: string,
  options: { tool: 'bash' | 'powershell'; command: string; cwd?: string },
): Promise<string> {
  const note = await pythonModuleNoteFor(output, options)
  return note ? `${output.trimEnd()}\n\n${note}` : output
}

export type { PythonEnv }
