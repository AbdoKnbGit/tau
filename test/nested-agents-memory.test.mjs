import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const cwd = process.cwd()
// Rules and includes resolve real paths; keep fixtures in that same namespace
// when the OS exposes its temporary directory through a symlink.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-nested-agents-memory-')))
const project = join(root, 'project')
const config = join(root, 'config')
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
}
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(config)
write(join(project, 'AGENTS.md'), 'ROOT-AGENTS-CONTEXT\n')
write(join(project, 'CLAUDE.md'), 'ROOT-CLAUDE-CONTEXT\n')
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
  CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
  CLAUDE_CODE_SIMPLE: '0',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)

after(async () => {
  process.chdir(cwd)
  assert.equal(dirname(resolve(root)), realpathSync(tmpdir()))
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const r = await loadBuiltRuntime({
  paths: ['src/utils/claudemd.ts', 'src/utils/attachments.ts', 'src/context.ts',
    'src/utils/fileStateCache.ts', 'src/utils/settings/settingsCache.ts'],
  exports: ['getMemoryFiles', 'getUserContext', 'getClaudeMds',
    'getMemoryFilesForNestedDirectory', 'getNestedMemoryAttachmentsForFile',
    'memoryFilesToAttachments', 'getDirectoriesToProcess', 'createFileStateCacheWithSizeLimit',
    'getAllMemoryFilePaths', 'isMemoryFilePath', 'setAllowedSettingSources',
    'resetSettingsCache', 'setOriginalCwd'],
})
r.setOriginalCwd(project)
r.setAllowedSettingSources(['projectSettings', 'localSettings'])
r.resetSettingsCache()
const initialMemory = await r.getMemoryFiles()
const initialMemoryJson = JSON.stringify(initialMemory)
const initialUserContext = await r.getUserContext()
const initialUserContextJson = JSON.stringify(initialUserContext)
assert.match(initialUserContext.claudeMd, /ROOT-AGENTS-CONTEXT/)
assert.match(initialUserContext.claudeMd, /ROOT-CLAUDE-CONTEXT/)

function fixture(name, files) {
  const dir = join(project, name)
  for (const [path, content] of Object.entries({ 'main.js': '// target\n', ...files })) {
    write(join(dir, path), content)
  }
  return { dir, target: join(dir, 'main.js') }
}
function context(maxEntries = 100) {
  return {
    readFileState: r.createFileStateCacheWithSizeLimit(maxEntries),
    loadedNestedMemoryPaths: new Set(),
  }
}
const appState = () => r.getDefaultAppState()
const attach = (target, ctx = context()) =>
  r.getNestedMemoryAttachmentsForFile(target, ctx, appState())
const paths = (attachments, dir) => attachments.map(a => relative(dir, a.path))

test('reading below the startup cwd lazily attaches AGENTS.md and preserves CLAUDE.md-only discovery', async () => {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const f = fixture(`only-${name}`, { [name]: `NESTED-${name}\n` })
    const attachments = await attach(f.target)
    assert.deepEqual(paths(attachments, f.dir), [name])
    assert.equal(attachments[0].type, 'nested_memory')
    assert.equal(attachments[0].content.type, 'Project')
    assert.equal(attachments[0].content.content, `NESTED-${name}\n`)
  }
})

test('distinct nested instructions retain AGENTS/native/local/rule precedence', async () => {
  const f = fixture('precedence', {
    'AGENTS.md': 'AGENTS-PRECEDENCE\n',
    'CLAUDE.md': 'CLAUDE-PRECEDENCE\n',
    '.claude/CLAUDE.md': 'DOT-CLAUDE-PRECEDENCE\n',
    'CLAUDE.local.md': 'LOCAL-PRECEDENCE\n',
    '.claude/rules/style.md': 'RULE-PRECEDENCE\n',
  })
  const attachments = await attach(f.target)
  assert.deepEqual(paths(attachments, f.dir), ['AGENTS.md', 'CLAUDE.md',
    join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md', join('.claude', 'rules', 'style.md')])
  assert.deepEqual(attachments.map(a => a.content.type),
    ['Project', 'Project', 'Project', 'Local', 'Project'])
})

test('each nested directory attaches parent instructions before child instructions', async () => {
  const f = fixture('tree', {
    'AGENTS.md': 'PARENT-AGENTS\n', 'CLAUDE.md': 'PARENT-CLAUDE\n',
    'child/AGENTS.md': 'CHILD-AGENTS\n', 'child/CLAUDE.md': 'CHILD-CLAUDE\n',
    'child/main.js': '// child target\n',
  })
  const ctx = context()
  const attachments = await attach(join(f.dir, 'child', 'main.js'), ctx)
  assert.deepEqual(paths(attachments, f.dir), ['AGENTS.md', 'CLAUDE.md',
    join('child', 'AGENTS.md'), join('child', 'CLAUDE.md')])
  assert.deepEqual(await attach(f.target, ctx), [], 'returning to the parent must not repeat its instructions')
})

test('identical bytes and hardlinks retain the native instruction once', async () => {
  for (const kind of ['duplicate', 'hardlink']) {
    const f = fixture(kind, { 'CLAUDE.md': `SHARED-${kind}\n` })
    if (kind === 'hardlink') linkSync(join(f.dir, 'CLAUDE.md'), join(f.dir, 'AGENTS.md'))
    else write(join(f.dir, 'AGENTS.md'), readFileSync(join(f.dir, 'CLAUDE.md'), 'utf8'))
    assert.deepEqual(paths(await attach(f.target), f.dir), ['CLAUDE.md'])
  }
})

test('AGENTS content already supplied by an unconditional native rule is attached once', async () => {
  const f = fixture('duplicate-rule', {
    'AGENTS.md': 'SHARED-RULE-INSTRUCTIONS\n',
    '.claude/rules/style.md': 'SHARED-RULE-INSTRUCTIONS\n',
  })
  assert.deepEqual(paths(await attach(f.target), f.dir), [join('.claude', 'rules', 'style.md')])
})

test('only a matching conditional rule can supersede duplicate AGENTS content', async () => {
  for (const [name, pattern, expected] of [
    ['matching-rule', 'main.js', [join('.claude', 'rules', 'scoped.md')]],
    ['nonmatching-rule', 'other/**', ['AGENTS.md']],
  ]) {
    const f = fixture(name, {
      'AGENTS.md': 'CONDITIONAL-SHARED-CONTENT\n',
      '.claude/rules/scoped.md': `---\npaths: ${pattern}\n---\nCONDITIONAL-SHARED-CONTENT\n`,
    })
    assert.deepEqual(paths(await attach(f.target), f.dir), expected, name)
  }
})

test('a nested AGENTS symlink to CLAUDE.md is not attached twice', async t => {
  const f = fixture('symlink', { 'CLAUDE.md': 'SYMLINK-INSTRUCTIONS\n' })
  try {
    symlinkSync(join(f.dir, 'CLAUDE.md'), join(f.dir, 'AGENTS.md'), 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('file symlinks are not available to this host/user')
      return
    }
    throw error
  }
  assert.deepEqual(paths(await attach(f.target), f.dir), ['CLAUDE.md'])
})

test('AGENTS includes follow native loop/path dedup and exclude external files', async () => {
  write(join(root, 'outside.md'), 'OUTSIDE-MUST-NOT-ATTACH\n')
  const f = fixture('includes', {
    'AGENTS.md': 'AGENTS-INCLUDES\n@./included.md\n@./included.md\n@../../outside.md\n',
    'included.md': 'INCLUDED-INSTRUCTIONS\n@./AGENTS.md\n',
  })
  const ctx = context()
  const attachments = await attach(f.target, ctx)
  assert.deepEqual(paths(attachments, f.dir), ['AGENTS.md', 'included.md'])
  assert.equal(attachments[1].content.parent, join(f.dir, 'AGENTS.md'))
  assert.ok(attachments.every(a => !a.content.content.includes('OUTSIDE-MUST-NOT-ATTACH')))
  assert.equal(ctx.readFileState.size, 2)
  assert.deepEqual(await attach(f.target, ctx), [], 'a second Read must not repeat instructions')
})

test('shared native/AGENTS imports appear once with their original native parent', async () => {
  const f = fixture('shared-import', {
    'CLAUDE.md': 'NATIVE-IMPORT\n@./shared.md\n',
    'AGENTS.md': 'AGENTS-IMPORT\n@./shared.md\n',
    'shared.md': 'SHARED-IMPORT-CONTENT\n',
  })
  const attachments = await attach(f.target)
  assert.deepEqual(paths(attachments, f.dir), ['AGENTS.md', 'CLAUDE.md', 'shared.md'])
  assert.equal(attachments[2].content.parent, join(f.dir, 'CLAUDE.md'))
})

test('explicit instruction includes retain a rule that does not match the target file', async () => {
  for (const filename of ['CLAUDE.md', 'AGENTS.md']) {
    const f = fixture(`explicit-rule-${filename}`, {
      [filename]: 'EXPLICIT-RULE-INCLUDE\n@./.claude/rules/other.md\n',
      '.claude/rules/other.md': '---\npaths: other/**\n---\nEXPLICIT-NONMATCHING-RULE\n',
      '.claude/rules/unrequested.md': '---\npaths: other/**\n---\nUNREQUESTED-NONMATCHING-RULE\n',
    })
    const attachments = await attach(f.target)
    assert.deepEqual(paths(attachments, f.dir), [filename, join('.claude', 'rules', 'other.md')])
    assert.match(attachments[1].content.content, /EXPLICIT-NONMATCHING-RULE/)
    assert.equal(attachments[1].content.parent, join(f.dir, filename))
    assert.ok(attachments.every(a => !a.content.content.includes('UNREQUESTED-NONMATCHING-RULE')))
  }
})

test('nested attachment dedup survives read-cache eviction and retains raw bytes for partial views', async () => {
  const raw = '<!-- hidden instruction comment -->\nPUBLIC-AGENTS-INSTRUCTIONS\n'
  const f = fixture('cache', { 'AGENTS.md': raw })
  const ctx = context(1)
  const [attachment] = await attach(f.target, ctx)
  assert.equal(attachment.path, join(f.dir, 'AGENTS.md'))
  assert.ok(!attachment.content.content.includes('hidden instruction comment'))
  assert.match(attachment.content.content, /PUBLIC-AGENTS-INSTRUCTIONS/)
  const cached = ctx.readFileState.get(attachment.path)
  assert.equal(cached.content, raw, 'edit/change checks require the actual on-disk bytes')
  assert.equal(cached.isPartialView, true)
  assert.equal(cached.offset, undefined)
  assert.equal(cached.limit, undefined)
  ctx.readFileState.set(f.target, { content: '// target\n', timestamp: Date.now(),
    offset: undefined, limit: undefined })
  assert.equal(ctx.readFileState.has(attachment.path), false, 'the one-entry LRU must really evict memory')
  assert.deepEqual(await attach(f.target, ctx), [])
  assert.equal(ctx.readFileState.get(f.target).content, '// target\n')
})

test('explicit claudeMdExcludes applies to lazy AGENTS and its includes', async () => {
  const f = fixture('excluded', {
    'AGENTS.md': 'EXCLUDED-AGENTS\n@./extra.md\n',
    'extra.md': 'EXCLUDED-AGENTS-INCLUDE\n',
    'CLAUDE.md': 'VISIBLE-NATIVE-INSTRUCTIONS\n',
  })
  write(join(project, '.claude', 'settings.json'), { claudeMdExcludes: ['**/excluded/AGENTS.md'] })
  r.resetSettingsCache()
  try {
    assert.deepEqual(paths(await attach(f.target), f.dir), ['CLAUDE.md'])
  } finally {
    write(join(project, '.claude', 'settings.json'), {})
    r.resetSettingsCache()
  }
})

test('disabling the project settings source suppresses both AGENTS and native project memory', async () => {
  const f = fixture('disabled-project', {
    'AGENTS.md': 'DISABLED-AGENTS\n', 'CLAUDE.md': 'DISABLED-NATIVE\n',
    'CLAUDE.local.md': 'STILL-ENABLED-LOCAL\n',
  })
  r.setAllowedSettingSources(['localSettings'])
  r.resetSettingsCache()
  try {
    assert.deepEqual(paths(await attach(f.target), f.dir), ['CLAUDE.local.md'])
  } finally {
    r.setAllowedSettingSources(['projectSettings', 'localSettings'])
    r.resetSettingsCache()
  }
})

test('an out-of-workspace target cannot attach its instruction files', async () => {
  const target = join(root, 'unapproved', 'main.js')
  write(target, '// unapproved target\n')
  write(join(dirname(target), 'AGENTS.md'), 'UNAPPROVED-INSTRUCTIONS\n')
  const ctx = context()
  assert.deepEqual(await attach(target, ctx), [])
  assert.equal(ctx.readFileState.size, 0)
  assert.equal(ctx.loadedNestedMemoryPaths.size, 0)
})

test('nested traversal uses directory boundaries rather than a sibling path prefix', () => {
  assert.deepEqual(r.getDirectoriesToProcess(join(project, 'main.js'), project).nestedDirs, [])
  for (const sibling of [`${project}-sibling`, `${project}copy`]) {
    assert.deepEqual(r.getDirectoriesToProcess(join(sibling, 'nested', 'main.js'), project).nestedDirs, [])
  }
})

test('Windows path casing preserves lazy discovery and cannot reinject the same memory', {
  skip: process.platform !== 'win32',
}, async () => {
  const f = fixture('case-variant', { 'AGENTS.md': 'WINDOWS-CASE-INSTRUCTIONS\n' })
  const upperTarget = f.target.toUpperCase()
  const normalize = path => path.replaceAll('/', '\\').toLowerCase()
  assert.deepEqual(r.getDirectoriesToProcess(upperTarget, project).nestedDirs.map(normalize), [normalize(f.dir)])
  assert.deepEqual(r.getDirectoriesToProcess(f.target, project.toUpperCase()).nestedDirs.map(normalize), [normalize(f.dir)])
  const ctx = context()
  const attachments = await attach(upperTarget, ctx)
  assert.equal(attachments.length, 1)
  assert.equal(normalize(attachments[0].path), normalize(join(f.dir, 'AGENTS.md')))
  assert.equal(attachments[0].content.content, 'WINDOWS-CASE-INSTRUCTIONS\n')
  ctx.readFileState.clear()
  assert.deepEqual(await attach(f.target, ctx), [], 'case spelling must not bypass the persistent loaded-memory ledger')
  assert.deepEqual(await attach(upperTarget.replaceAll('\\', '/'), ctx), [])
  assert.equal(ctx.loadedNestedMemoryPaths.size, 1)
})

test('memory classification includes canonical AGENTS, follows host casing, and rejects ordinary files', () => {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']) {
    assert.equal(r.isMemoryFilePath(name), true)
    assert.equal(r.isMemoryFilePath(join(project, 'nested', name)), true)
    assert.equal(r.isMemoryFilePath(join(project, 'nested', name).replaceAll(sep, '/')), true)
  }
  assert.equal(r.isMemoryFilePath(join('.claude', 'rules', 'nested', 'style.md')), true)
  assert.equal(r.isMemoryFilePath(join(project, '.claude', 'rules', 'style.md')), true)
  const windows = process.platform === 'win32'
  for (const name of ['agents.MD', 'claude.MD', 'CLAUDE.LOCAL.MD']) {
    assert.equal(r.isMemoryFilePath(join(project, 'nested', name)), windows)
  }
  if (windows) {
    assert.equal(r.isMemoryFilePath('C:\\Example\\Nested\\aGeNtS.Md'), true)
    assert.equal(r.isMemoryFilePath('c:/EXAMPLE/Nested/cLaUdE.mD'), true)
    assert.equal(r.isMemoryFilePath('C:\\Example\\.CLAUDE\\RULES\\style.md'), true)
  }
  for (const path of ['AGENT.md', 'agents.txt', 'AGENTS.md.bak', 'README.md',
    join('rules', 'style.md'), join('.claude', 'rules-other', 'style.md'),
    join('.claude', 'rules', 'style.MD')]) {
    assert.equal(r.isMemoryFilePath(path), false, path)
  }
  const ctx = context()
  const agentsPath = join(project, 'classified', 'AGENTS.md')
  ctx.readFileState.set(agentsPath, { content: 'nested', timestamp: 1 })
  ctx.readFileState.set(join(project, 'classified', 'normal.md'), { content: 'normal', timestamp: 1 })
  assert.deepEqual(r.getAllMemoryFilePaths([], ctx.readFileState), [agentsPath])
})

test('lazy nested attachments leave the memoized startup context and files unchanged', async () => {
  assert.equal(await r.getMemoryFiles(), initialMemory)
  assert.equal(await r.getUserContext(), initialUserContext)
  assert.equal(JSON.stringify(initialMemory), initialMemoryJson)
  assert.equal(JSON.stringify(initialUserContext), initialUserContextJson)
  assert.ok(!initialUserContext.claudeMd.includes('NESTED-AGENTS.md'))
  assert.ok(!initialUserContext.claudeMd.includes('AGENTS-PRECEDENCE'))
})
