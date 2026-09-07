/**
 * AGENTS.md project-memory discovery, exercised against the real bundle.
 *
 * getMemoryFiles() reads the original cwd once at module-init time, so every
 * scenario runs in its own child process against a throwaway repo. The bundle
 * is patched once (stripping the `void main()` call and exporting the memory
 * entry points) and shared by all children.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const distPath = resolve('dist/tau.mjs')
const harnessPath = join(
  dirname(distPath),
  `.agents-md-harness-${process.pid}-${Date.now()}.mjs`,
)

let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __memory() {
  init_claudemd();
  return { getMemoryFiles };
}
`
writeFileSync(harnessPath, source)

/**
 * Runs getMemoryFiles() in a child process rooted at `repoDir` and returns the
 * loaded files as `{ name, content }`, in load order.
 */
function loadMemory(repoDir) {
  const script = `
    process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(join(repoDir, '.cfg'))};
    process.chdir(${JSON.stringify(repoDir)});
    const m = await import(${JSON.stringify(new URL(`file:///${harnessPath.replaceAll('\\', '/')}`).href)});
    const files = await m.__memory().getMemoryFiles();
    const rel = p => p.split(/[\\\\/]/).pop();
    console.log('@@' + JSON.stringify(files.map(f => ({ name: rel(f.path), content: f.content }))));
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoDir,
    timeout: 120_000,
  })
  const line = out.split('\n').find(l => l.startsWith('@@'))
  assert.ok(line, `child produced no result. output:\n${out}`)
  return JSON.parse(line.slice(2))
}

/** Creates an isolated repo root with an isolated config dir. */
function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tau-agents-md-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  mkdirSync(join(dir, '.cfg'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

const created = []
function repo(files) {
  const dir = makeRepo(files)
  created.push(dir)
  return dir
}

test.after(() => {
  try {
    unlinkSync(harnessPath)
  } catch {
    // harness already removed
  }
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // temp dir cleanup is best-effort
    }
  }
})

test('AGENTS.md alone is loaded as project memory', () => {
  const dir = repo({ 'AGENTS.md': '# Payments\npnpm only, never npm\n' })
  const files = loadMemory(dir)
  const names = files.map(f => f.name)
  assert.deepEqual(names, ['AGENTS.md'])
  assert.match(files[0].content, /pnpm only, never npm/)
})

test('CLAUDE.md and AGENTS.md both load, CLAUDE.md ranked higher', () => {
  const dir = repo({
    'CLAUDE.md': '# claude\nfrom-claude-md\n',
    'AGENTS.md': '# agents\nfrom-agents-md\n',
  })
  const names = loadMemory(dir).map(f => f.name)
  // This module treats later files as higher priority, so CLAUDE.md goes last:
  // a repo's own tau instructions outrank the cross-vendor file. AGENTS.md is
  // still *read* after CLAUDE.md so CLAUDE.md wins the content dedup.
  assert.deepEqual(names, ['AGENTS.md', 'CLAUDE.md'])
})

test('AGENTS.md is skipped when its content duplicates CLAUDE.md', () => {
  const shared = '# shared\nsame bytes in both files\n'
  const dir = repo({ 'CLAUDE.md': shared, 'AGENTS.md': shared })
  const names = loadMemory(dir).map(f => f.name)
  assert.deepEqual(
    names,
    ['CLAUDE.md'],
    'identical content must reach the prompt once, not twice',
  )
})

test('AGENTS.md hardlinked to CLAUDE.md is not loaded twice', () => {
  const dir = repo({ 'CLAUDE.md': '# claude\nlink-target-body\n' })
  // A hardlink is the strictest case: the two paths share bytes but have no
  // symlink relationship at all, so realpath dedup cannot see it and only the
  // content check prevents a double injection.
  linkSync(join(dir, 'CLAUDE.md'), join(dir, 'AGENTS.md'))
  const names = loadMemory(dir).map(f => f.name)
  assert.deepEqual(names, ['CLAUDE.md'])
})

test('AGENTS.md symlinked to CLAUDE.md is not loaded twice', t => {
  const dir = repo({ 'CLAUDE.md': '# claude\nsymlink-target-body\n' })
  try {
    symlinkSync(join(dir, 'CLAUDE.md'), join(dir, 'AGENTS.md'), 'file')
  } catch {
    // Windows refuses symlinks without elevation or Developer Mode. The
    // hardlink case above covers the same dedup path.
    t.skip('symlink creation not permitted on this host')
    return
  }
  const names = loadMemory(dir).map(f => f.name)
  assert.deepEqual(
    names,
    ['CLAUDE.md'],
    'path dedup only catches a symlink visited before its target, so content dedup must cover this',
  )
})

test('a repo with no AGENTS.md is completely unaffected', () => {
  // The cached system prompt must not move for existing users. The AGENTS.md
  // probe has to be a pure no-op when the file is absent.
  const dir = repo({
    'CLAUDE.md': '# claude\nonly-file-here\n',
    '.claude/rules/style.md': '# style\nunconditional-rule\n',
  })
  const names = loadMemory(dir).map(f => f.name)
  assert.deepEqual(names, ['CLAUDE.md', 'style.md'])
})

test('a directory named AGENTS.md does not break discovery', () => {
  const dir = repo({ 'CLAUDE.md': '# claude\nstill-loads\n' })
  mkdirSync(join(dir, 'AGENTS.md'), { recursive: true })
  const names = loadMemory(dir).map(f => f.name)
  assert.deepEqual(names, ['CLAUDE.md'])
})

test('a nested AGENTS.md loads after the parent directory files', () => {
  const dir = repo({
    'AGENTS.md': '# root\nroot-level-rule\n',
    'sub/AGENTS.md': '# sub\nsub-level-rule\n',
  })
  const nested = join(dir, 'sub')
  const files = loadMemory(nested)
  assert.deepEqual(files.map(f => f.name), ['AGENTS.md', 'AGENTS.md'])
  assert.match(files[0].content, /root-level-rule/)
  assert.match(files[1].content, /sub-level-rule/)
})
