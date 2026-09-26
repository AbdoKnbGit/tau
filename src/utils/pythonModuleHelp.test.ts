/**
 * Failed-import parsing tests.
 *
 * Run: bun run src/utils/pythonModuleHelp.test.ts
 */

import { interpreterInCommand, missingPythonModule } from './pythonModuleHelp.js'

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

console.log('failed Python imports:')

test('the module from a traceback, the last one when several', () => {
  const out = [
    'Traceback (most recent call last):',
    '  File "x.py", line 1, in <module>',
    "ModuleNotFoundError: No module named 'pymupdf'",
    'During handling of the above exception, another exception occurred:',
    "ModuleNotFoundError: No module named 'fitz'",
  ].join('\n')
  assert(missingPythonModule(out) === 'fitz', String(missingPythonModule(out)))
})

test('dotted names and the old ImportError wording', () => {
  assert(missingPythonModule("ModuleNotFoundError: No module named 'google.protobuf'") === 'google.protobuf', 'dotted')
  assert(missingPythonModule('ImportError: No module named yaml') === 'yaml', 'python 2 style')
})

test('other import errors are not a missing module', () => {
  assert(missingPythonModule("ImportError: cannot import name 'x' from 'y'") === undefined, 'cannot import name')
  assert(missingPythonModule('Error: Cannot find module "lodash"') === undefined, 'node error')
})

test('the interpreter a command names', () => {
  assert(interpreterInCommand('python3 script.py')?.command === 'python3', 'bare python3')
  assert(interpreterInCommand('.venv/bin/python -m app')?.command === '.venv/bin/python', 'relative venv path')
  assert(interpreterInCommand('cd src && "C:/Program Files/Python312/python.exe" x.py')?.command === 'C:/Program Files/Python312/python.exe', 'quoted path with spaces')
  const py = interpreterInCommand('py -3.11 x.py')
  assert(py?.command === 'py' && py.args[0] === '-3', 'py launcher')
  assert(interpreterInCommand('python3.12 -c "import x"')?.command === 'python3.12', 'versioned name')
})

test('environment managers and non-Python commands name no interpreter', () => {
  for (const command of ['uv run python x.py', 'poetry run python x.py', 'conda run -n e python x.py', 'pytest -q', 'node x.js', 'pythonic-tool --help']) {
    assert(interpreterInCommand(command) === undefined, command)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
