#!/usr/bin/env node
// Runs every test file that no other CI step names, so a new one cannot go unrun by accident. `node build.mjs` first.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const named = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const files = readdirSync(resolve(root, 'test'))
  // The voice tests have a step of their own, which finds them by this name.
  .filter(name => name.endsWith('.test.mjs') && !/^(?:live|native)-voice/.test(name))
  .map(name => `test/${name}`)
  .filter(file => !named.includes(file))
console.log(`${files.length} test files no other step names`)
const { status } = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
process.exitCode = status ?? 1
