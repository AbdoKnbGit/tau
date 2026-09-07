/**
 * Foreign project rules, end to end against the real bundle.
 *
 * Two things are being pinned. First, correctness: a rule reaches the prompt
 * when its own tool would have applied it. Second, and more important, cost:
 * exactly which files land in the eagerly-loaded set, because that set is the
 * cached system prompt and everything in it is paid for on every request.
 *
 * getMemoryFiles() captures the original cwd at module-init time, so every
 * scenario runs in its own child process against a throwaway repo.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const distPath = resolve('dist/tau.mjs')
const harnessPath = join(
  dirname(distPath),
  `.foreign-rules-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __memory() {
  init_claudemd();
  return { getMemoryFiles, getConditionalRulesForCwdLevelDirectory };
}
`
writeFileSync(harnessPath, source)

const harnessUrl = new URL(
  `file:///${harnessPath.replaceAll('\\', '/')}`,
).href

function runInRepo(repoDir, body) {
  const script = `
    process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(join(repoDir, '.cfg'))};
    process.chdir(${JSON.stringify(repoDir)});
    const api = (await import(${JSON.stringify(harnessUrl)})).__memory();
    const base = ${JSON.stringify(repoDir)};
    const rel = p => p.slice(base.length + 1).replaceAll('\\\\', '/');
    ${body}
  `
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8', cwd: repoDir, timeout: 120_000 },
  )
  const line = out.split('\n').find(l => l.startsWith('@@'))
  assert.ok(line, `child produced no result. output:\n${out}`)
  return JSON.parse(line.slice(2))
}

/** Files loaded eagerly — i.e. what ends up in the cached system prompt. */
function eagerFiles(repoDir) {
  return runInRepo(
    repoDir,
    `const files = await api.getMemoryFiles();
     console.log('@@' + JSON.stringify(files.map(f => rel(f.path))));`,
  )
}

/** Rules that attach lazily when `target` is touched. */
function conditionalFor(repoDir, target) {
  return runInRepo(
    repoDir,
    `const files = await api.getConditionalRulesForCwdLevelDirectory(
       base, ${JSON.stringify(target)}, new Set());
     console.log('@@' + JSON.stringify(files.map(f => rel(f.path))));`,
  )
}

const created = []
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tau-foreign-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  mkdirSync(join(dir, '.cfg'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  created.push(dir)
  return dir
}

test.after(() => {
  try {
    unlinkSync(harnessPath)
  } catch {
    // already removed
  }
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

// ── Cursor ──────────────────────────────────────────────────────────────────

test('Cursor: only alwaysApply rules load eagerly', () => {
  const dir = repo({
    '.cursor/rules/security.mdc':
      '---\ndescription: sec\nalwaysApply: true\n---\nnever log card numbers\n',
    '.cursor/rules/db.mdc':
      '---\ndescription: db\nglobs: ["src/db/**/*.ts"]\nalwaysApply: false\n---\nuse qb()\n',
    '.cursor/rules/style.mdc':
      '---\ndescription: a long style guide\nalwaysApply: false\n---\nstyle stuff\n',
  })
  assert.deepEqual(eagerFiles(dir), ['.cursor/rules/security.mdc'])
})

test('Cursor: a globs rule attaches only for a matching file', () => {
  const dir = repo({
    '.cursor/rules/db.mdc':
      '---\nglobs: ["src/db/**/*.ts"]\nalwaysApply: false\n---\nuse qb()\n',
    'src/db/ledger.ts': '',
    'src/api/routes.ts': '',
  })
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/db/ledger.ts')), [
    '.cursor/rules/db.mdc',
  ])
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/api/routes.ts')), [])
})

test('Cursor: an Agent-Requested rule is never loaded', () => {
  const dir = repo({
    '.cursor/rules/style.mdc':
      '---\ndescription: style guide\nalwaysApply: false\n---\nlots of prose\n',
    'src/a.ts': '',
  })
  assert.deepEqual(eagerFiles(dir), [])
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/a.ts')), [])
})

// ── Copilot ─────────────────────────────────────────────────────────────────

test('Copilot: applyTo attaches lazily, missing applyTo loads nothing', () => {
  const dir = repo({
    '.github/instructions/tests.instructions.md':
      '---\napplyTo: "**/*.test.ts"\n---\nuse createTestPayment()\n',
    '.github/instructions/orphan.instructions.md': 'no frontmatter at all\n',
    'src/a.test.ts': '',
    'src/a.ts': '',
  })
  assert.deepEqual(eagerFiles(dir), [])
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/a.test.ts')), [
    '.github/instructions/tests.instructions.md',
  ])
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/a.ts')), [])
})

// ── Whole-project fallback chain ────────────────────────────────────────────

test('copilot-instructions.md loads when there is nothing native', () => {
  const dir = repo({
    '.github/copilot-instructions.md': '# repo\nalways use pnpm\n',
  })
  assert.deepEqual(eagerFiles(dir), ['.github/copilot-instructions.md'])
})

test('the fallback yields to AGENTS.md', () => {
  const dir = repo({
    'AGENTS.md': '# repo\nthe maintained one\n',
    '.github/copilot-instructions.md': '# stale\nleftover from copilot\n',
    '.clinerules': 'leftover from cline\n',
    '.windsurfrules': 'leftover from windsurf\n',
  })
  assert.deepEqual(
    eagerFiles(dir),
    ['AGENTS.md'],
    'three stale whole-project files must not stack onto the cached prefix',
  )
})

test('the fallback yields to CLAUDE.md', () => {
  const dir = repo({
    'CLAUDE.md': '# repo\nnative\n',
    '.clinerules': 'leftover\n',
  })
  assert.deepEqual(eagerFiles(dir), ['CLAUDE.md'])
})

test('only the first fallback wins', () => {
  const dir = repo({
    '.github/copilot-instructions.md': '# copilot\nfirst\n',
    '.clinerules': 'second\n',
    '.windsurfrules': 'third\n',
  })
  assert.deepEqual(eagerFiles(dir), ['.github/copilot-instructions.md'])
})

test('.clinerules as a directory loads its files', () => {
  const dir = repo({
    '.clinerules/coding.md': 'early returns\n',
    '.clinerules/testing.md': 'no inline fixtures\n',
  })
  assert.deepEqual(eagerFiles(dir).sort(), [
    '.clinerules/coding.md',
    '.clinerules/testing.md',
  ])
})

test('.clinerules files can scope themselves to paths', () => {
  const dir = repo({
    '.clinerules/db.md': '---\npaths: src/db/**\n---\nno raw sql\n',
    '.clinerules/all.md': 'applies everywhere\n',
    'src/db/x.ts': '',
    'src/api/y.ts': '',
  })
  assert.deepEqual(eagerFiles(dir), ['.clinerules/all.md'])
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/db/x.ts')), [
    '.clinerules/db.md',
  ])
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/api/y.ts')), [])
})

test('.windsurfrules loads, and .windsurf/rules honors trigger', () => {
  const dir = repo({
    '.windsurf/rules/always.md': '---\ntrigger: always_on\n---\nalways this\n',
    '.windsurf/rules/manual.md': '---\ntrigger: manual\n---\nonly on request\n',
    '.windsurf/rules/scoped.md':
      '---\ntrigger: glob\nglobs: "**/*.test.ts"\n---\ntest rule\n',
    'src/a.test.ts': '',
  })
  assert.deepEqual(eagerFiles(dir), ['.windsurf/rules/always.md'])
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/a.test.ts')), [
    '.windsurf/rules/scoped.md',
  ])
})

// ── No-overlap / no-regression guarantees ───────────────────────────────────

test('a repo with only native files is completely unaffected', () => {
  const dir = repo({
    'CLAUDE.md': '# claude\nnative\n',
    '.claude/rules/style.md': '# style\nunconditional\n',
    '.claude/rules/scoped.md': '---\npaths: src/**\n---\nscoped\n',
  })
  assert.deepEqual(eagerFiles(dir).sort(), [
    '.claude/rules/style.md',
    'CLAUDE.md',
  ])
})

test('legacy .cursorrules is ignored, as Cursor itself ignores it', () => {
  const dir = repo({ '.cursorrules': 'deprecated legacy rules\n' })
  assert.deepEqual(eagerFiles(dir), [])
})

test('foreign rules are project-scoped: a fake HOME copy is ignored', () => {
  // Every foreign source must resolve from the project walk only. A user's
  // ~/.cursor or ~/.clinerules is maintained for a different tool, and letting
  // it move tau's cached prompt prefix would be both surprising and expensive.
  const home = mkdtempSync(join(tmpdir(), 'tau-fakehome-'))
  for (const [p, c] of Object.entries({
    '.cursor/rules/home.mdc': '---\nalwaysApply: true\n---\nHOME-CURSOR\n',
    '.windsurf/rules/home.md': '---\ntrigger: always_on\n---\nHOME-WINDSURF\n',
    '.github/instructions/home.instructions.md':
      '---\napplyTo: "**"\n---\nHOME-COPILOT\n',
    '.clinerules': 'HOME-CLINE\n',
    '.windsurfrules': 'HOME-WINDSURFRULES\n',
    '.github/copilot-instructions.md': 'HOME-COPILOT-GENERIC\n',
  })) {
    const full = join(home, p)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, c)
  }
  created.push(home)

  const dir = repo({ 'CLAUDE.md': 'PROJECT-ONLY\n' })
  const loaded = runInRepo(
    dir,
    `process.env.HOME = ${JSON.stringify(home)};
     process.env.USERPROFILE = ${JSON.stringify(home)};
     const files = await api.getMemoryFiles();
     console.log('@@' + JSON.stringify(files.map(f => f.content)));`,
  )
  const blob = loaded.join('\n')
  for (const marker of [
    'HOME-CURSOR',
    'HOME-WINDSURF',
    'HOME-COPILOT',
    'HOME-CLINE',
    'HOME-WINDSURFRULES',
    'HOME-COPILOT-GENERIC',
  ]) {
    assert.ok(
      !blob.includes(marker),
      `${marker} leaked in from the home directory`,
    )
  }
  assert.ok(blob.includes('PROJECT-ONLY'))
})

test('native instructions rank above inherited ones', () => {
  // Later files are higher priority in this module, so the order must run
  // foreign -> AGENTS.md -> native. A rule inherited from another tool must
  // not outrank the repo's own CLAUDE.md.
  const dir = repo({
    'CLAUDE.md': 'CLAUDE-BODY\n',
    'AGENTS.md': 'AGENTS-BODY\n',
    '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nCURSOR-BODY\n',
  })
  assert.deepEqual(eagerFiles(dir), [
    '.cursor/rules/always.mdc',
    'AGENTS.md',
    'CLAUDE.md',
  ])
})

test('a foreign conditional rule ranks below native rules', () => {
  const dir = repo({
    '.claude/rules/native.md': '---\npaths: src/**\n---\nNATIVE-SCOPED\n',
    '.cursor/rules/db.mdc': '---\nglobs: "src/**"\n---\nCURSOR-SCOPED\n',
    'src/x.ts': '',
  })
  assert.deepEqual(conditionalFor(dir, join(dir, 'src/x.ts')), [
    '.cursor/rules/db.mdc',
    '.claude/rules/native.md',
  ])
})

test('an explicit @include into a foreign rules dir still resolves', () => {
  // Dialect is chosen by location, but an @include names a file directly. It
  // must keep native semantics, or a Cursor-dir target would be classified
  // dormant and silently vanish from content the author asked for by name.
  const dir = repo({
    'CLAUDE.md': '# root\n@./.cursor/rules/shared.mdc\nmain body\n',
    '.cursor/rules/shared.mdc': 'SHARED-INCLUDE-BODY\n',
  })
  const names = eagerFiles(dir)
  assert.ok(
    names.includes('.cursor/rules/shared.mdc'),
    `explicit @include was dropped; loaded: ${JSON.stringify(names)}`,
  )
})

test('an empty .claude/rules does not suppress the fallback', () => {
  // A rules directory holding nothing (or only a .gitkeep) contributes no
  // guidance, so it must not gate out the only instructions the repo has.
  const dir = repo({ '.github/copilot-instructions.md': '# repo\nuse pnpm\n' })
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true })
  assert.deepEqual(eagerFiles(dir), ['.github/copilot-instructions.md'])
})

test('an empty CLAUDE.md does not suppress the fallback', () => {
  const dir = repo({
    'CLAUDE.md': '',
    '.github/copilot-instructions.md': '# repo\nuse pnpm\n',
  })
  assert.deepEqual(eagerFiles(dir), ['.github/copilot-instructions.md'])
})

test('the kitchen-sink repo keeps the eager set minimal', () => {
  // Everything a repo could accumulate migrating across five tools.
  const dir = repo({
    'AGENTS.md': '# repo\nbuild with pnpm\n',
    '.cursor/rules/sec.mdc': '---\nalwaysApply: true\n---\nno card logs\n',
    '.cursor/rules/db.mdc': '---\nglobs: "src/db/**"\n---\nuse qb()\n',
    '.cursor/rules/style.mdc': '---\ndescription: style\n---\nprose\n',
    '.github/instructions/t.instructions.md':
      '---\napplyTo: "**/*.test.ts"\n---\nfactories\n',
    '.github/copilot-instructions.md': '# stale copilot\n',
    '.clinerules': 'stale cline\n',
    '.windsurfrules': 'stale windsurf\n',
    '.cursorrules': 'stale legacy cursor\n',
  })
  // Only the maintained whole-project file and the one explicitly-always rule.
  assert.deepEqual(eagerFiles(dir).sort(), [
    '.cursor/rules/sec.mdc',
    'AGENTS.md',
  ])
})
