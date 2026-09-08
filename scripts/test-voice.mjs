import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Node 20 on Windows does not expand test globs; pass exact argument paths.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = readdirSync(join(root, 'test')).filter(name => /^(?:live|native)-voice.*\.test\.mjs$/.test(name)).sort()
if (!files.length) throw new Error('No voice regression tests found')
const result = spawnSync(process.execPath, ['--test', ...files.map(name => join(root, 'test', name))], {
  cwd: root, stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
