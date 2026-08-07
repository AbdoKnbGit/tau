#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

const root = process.cwd()
const crateDir = join(root, 'native', 'tau-rust-tools')
const manifestPath = join(crateDir, 'Cargo.toml')
const outDir = join(root, 'dist', 'native')
const binaryName = process.platform === 'win32' ? 'tau-rust-tools.exe' : 'tau-rust-tools'
const builtPath = join(crateDir, 'target', 'release', binaryName)
const outPath = join(outDir, binaryName)
const required = process.env.TAU_REQUIRE_NATIVE_RUST_TOOLS === '1'

function finish(status, message) {
  if (message) {
    const stream = status === 0 ? process.stdout : process.stderr
    stream.write(`${message}\n`)
  }
  process.exit(status)
}

if (!existsSync(manifestPath)) {
  finish(required ? 1 : 0, 'Native Rust tools source not found; skipping.')
}

const cargoProbe = spawnSync('cargo', ['--version'], {
  encoding: 'utf8',
  windowsHide: true,
})
if (cargoProbe.status !== 0) {
  finish(required ? 1 : 0, 'Cargo is not available; skipping native Rust tools build.')
}

const build = spawnSync(
  'cargo',
  ['build', '--manifest-path', manifestPath, '--release', '--locked'],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  },
)
if (build.status !== 0 || !existsSync(builtPath)) {
  finish(required ? build.status ?? 1 : 0, 'Native Rust tools build failed.')
}

mkdirSync(outDir, { recursive: true })
copyFileSync(builtPath, outPath)
if (process.platform !== 'win32') {
  chmodSync(outPath, 0o755)
}

finish(0, `Built native Rust tools ${outPath}`)
