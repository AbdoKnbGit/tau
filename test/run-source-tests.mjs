#!/usr/bin/env node
// Runs every src/**/*.test.ts the way the file itself expects, each in its own process with a time limit, and
// fails if any of them does. `node build.mjs` first: a few of them read the bundle.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const LIMIT_MS = 180_000

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return testFiles(path)
    return /\.test\.tsx?$/.test(entry.name) ? [relative(root, path).split(sep).join('/')] : []
  })
}

// A file that imports the test functions from bun:test, or calls describe() without defining it, needs the
// test runner. Everything else is a plain script that reports through its exit code.
function needsTestRunner(source) {
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]bun:test['"]/g)) {
    if (/\b(describe|test|it)\b/.test(match[1])) return true
  }
  return /^describe\(/m.test(source) && !source.includes('function describe')
}

function run(file) {
  return new Promise(done => {
    const args = needsTestRunner(readFileSync(join(root, file), 'utf8')) ? ['test', `./${file}`] : ['run', file]
    const child = spawn('bun', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', part => { output += part })
    child.stderr.on('data', part => { output += part })
    const timer = setTimeout(() => {
      output += `\nStopped after ${LIMIT_MS / 1000} seconds.`
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      else child.kill('SIGKILL')
    }, LIMIT_MS)
    child.once('error', error => { clearTimeout(timer); done({ file, code: 1, output: String(error) }) })
    child.once('close', code => { clearTimeout(timer); done({ file, code, output }) })
  })
}

const files = testFiles(join(root, 'src')).sort()
const failures = []
for (const file of files) {
  const result = await run(file)
  if (result.code !== 0) failures.push(result)
}
for (const { file, code, output } of failures) {
  console.log(`\n--- ${file} (exit ${code})\n${output.trim().split('\n').slice(-30).join('\n')}`)
}
console.log(`\n${files.length} source test files: ${files.length - failures.length} passed, ${failures.length} failed`)
process.exitCode = failures.length ? 1 : 0
