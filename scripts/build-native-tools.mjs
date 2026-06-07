#!/usr/bin/env node

import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

const root = process.cwd()
const sourceDir = join(root, 'native', 'tau-tools')
const outDir = join(root, 'dist', 'native')
const binaryName = process.platform === 'win32' ? 'tau-tools.exe' : 'tau-tools'
const outPath = join(outDir, binaryName)
const required = process.env.TAU_REQUIRE_NATIVE_TOOLS === '1'

function finish(status, message) {
  if (message) {
    const stream = status === 0 ? process.stdout : process.stderr
    stream.write(`${message}\n`)
  }
  process.exit(status)
}

if (!existsSync(sourceDir)) {
  finish(required ? 1 : 0, 'Native Tau tools source not found; skipping.')
}

const goProbe = spawnSync('go', ['version'], {
  encoding: 'utf8',
  windowsHide: true,
})
if (goProbe.status !== 0) {
  finish(required ? 1 : 0, 'Go is not available; skipping native Tau tools build.')
}

mkdirSync(outDir, { recursive: true })

const build = spawnSync('go', ['build', '-C', sourceDir, '-o', outPath, '.'], {
  stdio: 'inherit',
  windowsHide: true,
})

if (build.status !== 0) {
  finish(required ? build.status ?? 1 : 0, 'Native Tau tools build failed.')
}

finish(0, `Built native Tau tools ${outPath}`)
