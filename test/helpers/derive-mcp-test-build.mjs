// Derive a build script from the repo's build.mjs that writes the bundle to
// OUT_DIR instead of dist/ (so the user's linked global `tau` is untouched),
// and stops before the launcher and native-tool steps.
//
// Usage: node derive-build.mjs <repoDir> <outDir>
//   then: node <outDir>/build-derived.mjs   (cwd = <repoDir>)
import { mkdirSync, readFileSync, symlinkSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [repoDir, outDirArg] = process.argv.slice(2)
if (!repoDir || !outDirArg) throw new Error('usage: derive-build.mjs <repoDir> <outDir>')
const outDir = resolve(outDirArg)
mkdirSync(outDir, { recursive: true })

let src = readFileSync(join(repoDir, 'build.mjs'), 'utf8')
const swap = (from, to) => {
  if (!src.includes(from)) throw new Error(`anchor not found: ${from}`)
  src = src.split(from).join(to)
}
const out = p => JSON.stringify(join(outDir, p).replaceAll('\\', '/'))

swap(`resolve(process.cwd(), 'dist/shim.js')`, out('shim.js'))
swap(`if (!existsSync('./dist')) {\n  mkdirSync('./dist')\n}`, `mkdirSync(${JSON.stringify(outDir.replaceAll('\\', '/'))}, { recursive: true })`)
swap(`outfile: './dist/tau.mjs',`, `outfile: ${out('tau.mjs')},`)
swap(`const outPath = './dist/tau.mjs'`, `const outPath = ${out('tau.mjs')}`)
const cut = src.indexOf('// ─── Launcher (bin entry)')
if (cut < 0) throw new Error('launcher anchor not found')
src = src.slice(0, cut)

writeFileSync(join(outDir, 'build-derived.mjs'), src)
// Externals resolve from the bundle's folder: junction the repo's node_modules.
const nm = join(outDir, 'node_modules')
if (!existsSync(nm)) symlinkSync(resolve(repoDir, 'node_modules'), nm, 'junction')
console.log(`derived: ${join(outDir, 'build-derived.mjs')}`)
