#!/usr/bin/env node
// One cross-platform entry point for every plan regression, including the real
// terminal tests. Keep discovery automatic so new plan cases cannot be omitted.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = process.argv.slice(2)
if (options.some((option) => option !== '--no-build')) {
  process.stderr.write('Usage: npm run test:plans -- [--no-build]\n')
  process.exitCode = 1
} else {
  const run = (args) => {
    const child = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    })
    if (child.error) process.stderr.write(String(child.error) + '\n')
    return child.status ?? 1
  }
  let status = options.includes('--no-build') ? 0 : run(['build.mjs'])
  if (status === 0) {
    const files = readdirSync(resolve(root, 'test'))
      .filter((name) => /^plan-.*\.test\.mjs$/.test(name))
      .sort()
      .map((name) => `test/${name}`)
    if (!files.length)
      throw new Error('No plan regression tests were discovered')
    process.stdout.write(
      `Running ${files.length} plan test files, including real CLI approval scenarios.\n`,
    )
    status = run(['--test', '--test-concurrency=2', ...files])
  }
  process.exitCode = status
}
