/**
 * Python environment discovery and install-command tests (pure parts).
 *
 * Run: bun run src/utils/pythonEnv.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  distributionForModule,
  parseProbeOutput,
  pythonCandidates,
  pythonInstallSteps,
  shellArg,
  shellCommand,
  type PythonEnv,
} from './pythonEnv.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function env(overrides: Partial<PythonEnv> = {}): PythonEnv {
  return {
    command: 'python',
    args: [],
    origin: 'path',
    executable: '/usr/bin/python3',
    version: '3.12.3',
    prefix: '/usr',
    kind: 'system',
    uv: false,
    pip: true,
    externallyManaged: false,
    ...overrides,
  }
}

console.log('python environments:')

test('a probe line becomes an environment and module facts', () => {
  const line = JSON.stringify({
    tau: 1, executable: 'C:\\p\\.venv\\Scripts\\python.exe', version: '3.11.9', prefix: 'C:\\p\\.venv',
    venv: true, conda: false, uv: true, pip: false, managed: false,
    found: { fitz: true, docx: false }, dist: { fitz: ['PyMuPDF', '1.24.0'] },
  })
  const parsed = parseProbeOutput({ command: 'x', args: [], origin: 'project-venv' }, `noise\n${line}\n`)
  assert(parsed, 'parsed')
  assert(parsed!.env.kind === 'venv' && parsed!.env.uv && !parsed!.env.pip, 'env facts')
  assert(parsed!.found.fitz?.dist === 'PyMuPDF' && parsed!.found.fitz?.version === '1.24.0', 'dist')
  assert(parsed!.found.docx === null, 'missing module is null')
})

test('anything that is not a Python 3 probe is rejected', () => {
  const c = { command: 'python3', args: [], origin: 'path' as const }
  assert(parseProbeOutput(c, 'Python was not found; run without arguments to install from the Microsoft Store') === null, 'store stub')
  assert(parseProbeOutput(c, JSON.stringify({ tau: 1, executable: 'x', version: '2.7.18' })) === null, 'python 2')
  assert(parseProbeOutput(c, '{"not": "ours"}') === null, 'foreign JSON')
})

test('an OS-managed flag only counts outside a venv', () => {
  const c = { command: 'python3', args: [], origin: 'path' as const }
  const managed = parseProbeOutput(c, JSON.stringify({ tau: 1, executable: '/usr/bin/python3', version: '3.12.3', venv: false, managed: true }))
  const inVenv = parseProbeOutput(c, JSON.stringify({ tau: 1, executable: '/p/.venv/bin/python', version: '3.12.3', venv: true, managed: true }))
  assert(managed!.env.externallyManaged && !inVenv!.env.externallyManaged, 'flags')
})

test('candidates: override, active env, project venv, then PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-pyenv-'))
  try {
    const venv = join(root, '.venv')
    mkdirSync(join(venv, 'bin'), { recursive: true })
    writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n')
    writeFileSync(join(venv, 'bin', 'python3'), '')
    const list = pythonCandidates({ cwd: root, env: { TAU_EVAL_PYTHON: '/opt/py' }, platform: 'linux' })
    const order = list.map(c => `${c.origin}:${c.command}`)
    assert(order[0] === 'override:/opt/py', order.join(', '))
    assert(order[1] === `project-venv:${join(venv, 'bin', 'python3')}`, order.join(', '))
    assert(order.slice(2).join(',') === 'path:python3,path:python', order.join(', '))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows adds the py launcher and looks in Scripts', () => {
  const list = pythonCandidates({ cwd: tmpdir(), env: {}, platform: 'win32' })
  assert(list.some(c => c.command === 'py' && c.args[0] === '-3'), 'py -3')
  assert(list.map(c => c.command).join(',').endsWith('python,py,python3'), list.map(c => c.command).join(','))
})

test('install into a uv venv uses uv', () => {
  const steps = pythonInstallSteps(env({ kind: 'venv', uv: true, pip: false, executable: 'C:\\p\\.venv\\Scripts\\python.exe' }), ['PyMuPDF'], 'bash', true, 'win32')
  assert(steps.commands[0] === 'uv pip install --python C:/p/.venv/Scripts/python.exe PyMuPDF', steps.commands[0]!)
})

test('install into a pip venv uses its pip, a system Python gets --user', () => {
  const venv = pythonInstallSteps(env({ kind: 'venv', executable: '/p/.venv/bin/python' }), ['openpyxl'], 'bash', false, 'linux')
  assert(venv.commands[0] === '/p/.venv/bin/python -m pip install openpyxl', venv.commands[0]!)
  const system = pythonInstallSteps(env(), ['openpyxl'], 'bash', false, 'linux')
  assert(system.commands[0] === '/usr/bin/python3 -m pip install --user openpyxl', system.commands[0]!)
})

test('no pip and no uv: bootstrap pip first', () => {
  const steps = pythonInstallSteps(env({ kind: 'venv', pip: false, executable: '/p/.venv/bin/python' }), ['xlrd'], 'bash', false, 'linux')
  assert(steps.commands.length === 2 && steps.commands[0] === '/p/.venv/bin/python -m ensurepip --upgrade', steps.commands.join(' | '))
})

test('an OS-managed Python gets advice, never --break-system-packages', () => {
  const steps = pythonInstallSteps(env({ externallyManaged: true }), ['PyMuPDF'], 'bash', true, 'linux')
  assert(steps.commands.length === 0 && steps.advice?.includes('virtual environment'), String(steps.advice))
  assert(!JSON.stringify(steps).includes('break-system-packages'), 'no override flag')
})

test('paths with spaces are quoted per shell', () => {
  const path = 'C:\\Program Files\\Python312\\python.exe'
  assert(shellArg(path, 'bash', 'win32') === '"C:/Program Files/Python312/python.exe"', shellArg(path, 'bash', 'win32'))
  assert(shellArg(path, 'powershell', 'win32') === "'C:\\Program Files\\Python312\\python.exe'", shellArg(path, 'powershell', 'win32'))
  assert(shellCommand(path, 'powershell', 'win32').startsWith("& '"), 'PowerShell runs a quoted path with &')
  assert(shellCommand('/usr/bin/python3', 'powershell', 'linux') === '/usr/bin/python3', 'plain path stays bare')
})

test('package names: reported, known mismatch, or uncertain', () => {
  assert(distributionForModule('fitz', 'pymupdf').name === 'pymupdf', 'reported wins')
  const docx = distributionForModule('docx')
  assert(docx.name === 'python-docx' && docx.certain, 'docx is python-docx')
  assert(distributionForModule('sklearn.linear_model').name === 'scikit-learn', 'dotted import')
  const other = distributionForModule('requests')
  assert(other.name === 'requests' && !other.certain, 'unknown stays uncertain')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
