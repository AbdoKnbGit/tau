/**
 * Skills in .agents/skills (where Codex, opencode, Cline and the `skills` CLI
 * keep them), exercised against the real bundle.
 *
 * Skill loading reads the original cwd and the home folder at module-init
 * time, so every scenario runs in its own child process against throwaway
 * folders (home and config included). The bundle is patched once (stripping
 * the `void main()` call, exporting the entry points) and shared by all
 * children. TAU_TEST_BUNDLE runs the suite against another build, e.g. one
 * made from HEAD to see which checks the change turns green.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve(process.env.TAU_TEST_BUNDLE ?? 'dist/tau.mjs')
const harnessPath = join(
  dirname(distPath),
  `.agents-skills-harness-${process.pid}-${Date.now()}.mjs`,
)

let source = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
// The plugin-only policy comes from managed settings in a system folder a
// test cannot write, so in this private copy an env var stands in for it.
const lockAnchor = 'function isRestrictedToPluginOnly(surface) {'
assert.ok(source.includes(lockAnchor), 'bundle has no isRestrictedToPluginOnly')
source = source.replace(
  lockAnchor,
  `${lockAnchor}\n  if (process.env.TAU_TEST_SKILLS_LOCKED === "1") return true;`,
)
const inits = [
  'src/bootstrap/state.ts',
  'src/utils/powerMode.ts',
  'src/utils/markdownConfigLoader.ts',
  'src/skills/loadSkillsDir.ts',
  'src/utils/permissions/filesystem.ts',
  'src/utils/sandbox/sandbox-adapter.ts',
  'src/tools/SkillTool/prompt.ts',
  'src/commands.ts',
].map(path => {
  const match = source.match(
    new RegExp(`var (init_\\w+) = __esm\\(\\{\\s*"${path.replaceAll('.', '\\.')}"\\(\\)`),
  )
  assert.ok(match, `missing built module ${path}`)
  return `${match[1]}();`
})
source += `
export function __agentsSkills() {
  init_analytics(); ${inits.join(' ')}
  return { getSkillDirCommands, discoverSkillDirsForPaths, addSkillDirectories, getDynamicSkills,
    activateConditionalSkillsForPaths, getProjectDirsUpToHome,
    checkPathSafetyForAutoEdit, convertToSandboxRuntimeConfig, setAdditionalDirectoriesForClaudeMd,
    setAllowedSettingSources, setSessionPowerMode, getCommands, getSkillToolCommands,
    formatCommandsWithinBudget };
}
`
writeFileSync(harnessPath, source)
const harnessUrl = pathToFileURL(harnessPath).href

const created = []
test.after(() => {
  try {
    unlinkSync(harnessPath)
  } catch {}
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const skill = (description, extra = '') =>
  `---\ndescription: ${description}\n${extra}---\n\n# ${description}\n`

/** Writes `files` under `root`; a name ending in "/" is an empty folder. */
function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = join(root, name)
    if (name.endsWith('/')) {
      mkdirSync(full, { recursive: true })
      continue
    }
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

/** A throwaway root with home/, config/ and a repo/ that has a .git folder. */
function makeRoot(files = {}) {
  // Real path: on macOS the temp folder sits behind a /var -> /private/var link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-agents-skills-')))
  created.push(root)
  for (const dir of ['home', 'config', join('repo', '.git')]) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  write(root, files)
  return root
}

/** A directory link: a junction on Windows (no privilege needed), else a symlink. */
function linkDir(root, target, link) {
  mkdirSync(dirname(join(root, link)), { recursive: true })
  symlinkSync(
    join(root, target),
    join(root, link),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
}

function childEnv(root, extra) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|TAU_)/i.test(key)),
  )
  return {
    ...env,
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra,
  }
}

/**
 * Runs `body` (the source of an async function taking the exported entry
 * points) in a child rooted at `cwd`, with HOME and CLAUDE_CONFIG_DIR inside
 * `root`. `rel` turns a path into one relative to `root` with forward slashes.
 */
function inChild(root, { cwd = join(root, 'repo'), env = {}, body }) {
  const script = `
    import { join, relative, sep } from 'node:path';
    const ROOT = ${JSON.stringify(root)};
    const rel = p => p == null ? null : relative(ROOT, p).split(sep).join('/');
    const brief = s => ({ name: s.name, source: s.source, loadedFrom: s.loadedFrom,
      root: rel(s.skillRoot), description: s.description });
    process.chdir(${JSON.stringify(cwd)});
    const { __agentsSkills } = await import(${JSON.stringify(harnessUrl)});
    const t = __agentsSkills();
    const result = await (${body})(t);
    console.log('@@' + JSON.stringify(result));
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd,
    timeout: 120_000,
    env: childEnv(root, env),
  })
  const line = out.split('\n').find(l => l.startsWith('@@'))
  assert.ok(line, `child produced no result. output:\n${out}`)
  return JSON.parse(line.slice(2))
}

const LOAD = 'async t => (await t.getSkillDirCommands(process.cwd())).map(brief)'
const rows = skills => skills.map(s => [s.name, s.source, s.loadedFrom, s.root])

test('a repo without .agents/skills loads exactly the skills it loaded before', () => {
  const root = makeRoot({
    'config/skills/beta/SKILL.md': skill('user claude skill'),
    'repo/.claude/skills/alpha/SKILL.md': skill('project claude skill'),
    'repo/.claude/commands/gamma.md': 'Legacy command\n',
  })
  assert.deepEqual(rows(inChild(root, { body: LOAD })), [
    ['beta', 'userSettings', 'skills', 'config/skills/beta'],
    ['alpha', 'projectSettings', 'skills', 'repo/.claude/skills/alpha'],
    ['gamma', 'projectSettings', 'commands_DEPRECATED', null],
  ])
})

test('a project .agents/skills folder loads like .claude/skills, as a project skill', () => {
  const root = makeRoot({
    'repo/.claude/skills/alpha/SKILL.md': skill('project claude skill'),
    'repo/.agents/skills/gamma/SKILL.md': skill('project agents skill'),
  })
  const skills = inChild(root, { body: LOAD })
  assert.deepEqual(rows(skills), [
    ['alpha', 'projectSettings', 'skills', 'repo/.claude/skills/alpha'],
    ['gamma', 'projectSettings', 'skills', 'repo/.agents/skills/gamma'],
  ])
  assert.equal(skills[1].description, 'project agents skill')
})

test('~/.agents/skills loads as a user skill', () => {
  const root = makeRoot({ 'home/.agents/skills/delta/SKILL.md': skill('user agents skill') })
  assert.deepEqual(rows(inChild(root, { body: LOAD })), [
    ['delta', 'userSettings', 'skills', 'home/.agents/skills/delta'],
  ])
})

test('a name that is already taken keeps its .claude skill', () => {
  const root = makeRoot({
    'repo/.claude/skills/same1/SKILL.md': skill('claude project'),
    'repo/.agents/skills/same1/SKILL.md': skill('agents project'),
    'config/skills/same2/SKILL.md': skill('claude user'),
    'repo/.agents/skills/same2/SKILL.md': skill('agents project'),
    'home/.agents/skills/same3/SKILL.md': skill('agents user'),
    'repo/.agents/skills/same3/SKILL.md': skill('agents project'),
    'repo/.claude/commands/same4.md': 'claude legacy command\n',
    'repo/.agents/skills/same4/SKILL.md': skill('agents project'),
    'repo/.claude/skills/same5/SKILL.md': skill('claude project'),
    'home/.agents/skills/same5/SKILL.md': skill('agents user'),
  })
  const skills = inChild(root, { body: LOAD })
  const only = name => {
    const found = skills.filter(s => s.name === name)
    assert.equal(found.length, 1, `${name} listed ${found.length} times`)
    return found[0]
  }
  assert.equal(only('same1').root, 'repo/.claude/skills/same1')
  assert.deepEqual([only('same2').source, only('same2').root], ['userSettings', 'config/skills/same2'])
  assert.deepEqual([only('same3').source, only('same3').root], ['userSettings', 'home/.agents/skills/same3'])
  assert.equal(only('same4').loadedFrom, 'commands_DEPRECATED')
  assert.deepEqual([only('same5').source, only('same5').root], ['projectSettings', 'repo/.claude/skills/same5'])
})

test('a repo that links its skills between .claude and .agents loads each once, from .claude', () => {
  const root = makeRoot({
    'repo/.agents/skills/linked/SKILL.md': skill('lives in .agents'),
    'repo/.claude/skills/back/SKILL.md': skill('lives in .claude'),
  })
  linkDir(root, 'repo/.agents/skills/linked', 'repo/.claude/skills/linked')
  linkDir(root, 'repo/.claude/skills/back', 'repo/.agents/skills/back')
  assert.deepEqual(
    rows(inChild(root, { body: LOAD })).sort((a, b) => a[0].localeCompare(b[0])),
    [
      ['back', 'projectSettings', 'skills', 'repo/.claude/skills/back'],
      ['linked', 'projectSettings', 'skills', 'repo/.claude/skills/linked'],
    ],
  )
})

test('the project walk goes up to the git root and no further', () => {
  const root = makeRoot({
    '.agents/skills/outside/SKILL.md': skill('above the git root'),
    'repo/.agents/skills/top/SKILL.md': skill('repo root'),
    'repo/pkg/.agents/skills/mid/SKILL.md': skill('package'),
    'repo/pkg/app/': null,
  })
  const result = inChild(root, {
    cwd: join(root, 'repo', 'pkg', 'app'),
    body: `async t => ({
      agentsDirs: t.getProjectDirsUpToHome('skills', process.cwd(), '.agents').map(rel),
      claudeDirs: t.getProjectDirsUpToHome('skills', process.cwd()).map(rel),
      names: (await t.getSkillDirCommands(process.cwd())).map(s => s.name),
    })`,
  })
  assert.deepEqual(result, {
    agentsDirs: ['repo/pkg/.agents/skills', 'repo/.agents/skills'],
    claudeDirs: [],
    names: ['mid', 'top'],
  })
})

test('outside git the walk stops at home, and ~/.agents/skills counts once, as a user skill', () => {
  const root = makeRoot({
    'home/proj/.agents/skills/p1/SKILL.md': skill('project outside git'),
    'home/.agents/skills/u1/SKILL.md': skill('user'),
    'home/proj/sub/': null,
  })
  const pairs = 'async t => (await t.getSkillDirCommands(process.cwd())).map(s => [s.name, s.source])'
  assert.deepEqual(inChild(root, { cwd: join(root, 'home', 'proj', 'sub'), body: pairs }), [
    ['u1', 'userSettings'],
    ['p1', 'projectSettings'],
  ])
  assert.deepEqual(inChild(root, { cwd: join(root, 'home'), body: pairs }), [['u1', 'userSettings']])
})

test('setting sources gate .agents/skills like .claude/skills', () => {
  const root = makeRoot({
    'repo/.agents/skills/proj/SKILL.md': skill('project'),
    'home/.agents/skills/usr/SKILL.md': skill('user'),
  })
  const only = sources => `async t => {
    t.setAllowedSettingSources(${JSON.stringify(sources)});
    return (await t.getSkillDirCommands(process.cwd())).map(s => s.name);
  }`
  assert.deepEqual(inChild(root, { body: only(['userSettings']) }), ['usr'])
  assert.deepEqual(inChild(root, { body: only(['projectSettings']) }), ['proj'])
})

test('the plugin-only policy locks .agents/skills along with .claude/skills', () => {
  const root = makeRoot({
    'repo/.claude/skills/alpha/SKILL.md': skill('claude'),
    'repo/.agents/skills/proj/SKILL.md': skill('project'),
    'home/.agents/skills/usr/SKILL.md': skill('user'),
  })
  assert.deepEqual(inChild(root, { body: LOAD, env: { TAU_TEST_SKILLS_LOCKED: '1' } }), [])
})

test('--add-dir brings its .agents/skills, in --bare mode too', () => {
  const root = makeRoot({
    'extra/.claude/skills/addc/SKILL.md': skill('add-dir claude'),
    'extra/.agents/skills/adda/SKILL.md': skill('add-dir agents'),
    'extra/.claude/skills/both/SKILL.md': skill('claude both'),
    'extra/.agents/skills/both/SKILL.md': skill('agents both'),
    'repo/.agents/skills/proj/SKILL.md': skill('project'),
    'home/.agents/skills/usr/SKILL.md': skill('user'),
  })
  const withAddDir = `async t => {
    t.setAdditionalDirectoriesForClaudeMd([${JSON.stringify(join(root, 'extra'))}]);
    return (await t.getSkillDirCommands(process.cwd())).map(brief);
  }`
  const names = skills => skills.map(s => s.name).sort()

  const normal = inChild(root, { body: withAddDir })
  assert.deepEqual(names(normal), ['adda', 'addc', 'both', 'proj', 'usr'])
  assert.equal(normal.find(s => s.name === 'both').root, 'extra/.claude/skills/both')

  const bare = inChild(root, { body: withAddDir, env: { CLAUDE_CODE_SIMPLE: '1' } })
  assert.deepEqual(names(bare), ['adda', 'addc', 'both'])
  assert.equal(bare.find(s => s.name === 'both').root, 'extra/.claude/skills/both')

  assert.deepEqual(inChild(root, { body: LOAD, env: { CLAUDE_CODE_SIMPLE: '1' } }), [])
})

test('cheap power mode ignores .agents/skills like every folder skill', () => {
  const root = makeRoot({
    'repo/.agents/skills/proj/SKILL.md': skill('project'),
    'repo/pkg/.agents/skills/nested/SKILL.md': skill('nested'),
    'repo/pkg/src/a.ts': 'export {}\n',
  })
  const body = cheap => `async t => {
    if (${cheap}) t.setSessionPowerMode('cheap');
    const names = (await t.getCommands(process.cwd())).map(c => c.name);
    const found = await t.discoverSkillDirsForPaths([join(process.cwd(), 'pkg', 'src', 'a.ts')], process.cwd());
    return { proj: names.includes('proj'), found: found.map(rel) };
  }`
  assert.deepEqual(inChild(root, { body: body(false) }), {
    proj: true,
    found: ['repo/pkg/.agents/skills'],
  })
  assert.deepEqual(inChild(root, { body: body(true) }), { proj: false, found: [] })
})

test('a .agents/skills folder below the working folder is found when a file there is touched', () => {
  const root = makeRoot({
    'repo/pkg/.agents/skills/nested/SKILL.md': skill('nested agents skill'),
    'repo/pkg/src/a.ts': 'export {}\n',
  })
  const result = inChild(root, {
    body: `async t => {
      const file = join(process.cwd(), 'pkg', 'src', 'a.ts');
      const first = await t.discoverSkillDirsForPaths([file], process.cwd());
      await t.addSkillDirectories(first);
      const again = await t.discoverSkillDirsForPaths([file], process.cwd());
      return { first: first.map(rel), again, dynamic: t.getDynamicSkills().map(brief) };
    }`,
  })
  assert.deepEqual(result.first, ['repo/pkg/.agents/skills'])
  assert.deepEqual(result.again, [])
  assert.deepEqual(rows(result.dynamic), [
    ['nested', 'projectSettings', 'skills', 'repo/pkg/.agents/skills/nested'],
  ])
})

test('below the working folder .claude wins at equal depth and the deeper folder wins otherwise', () => {
  const root = makeRoot({
    'repo/pkg/.claude/skills/n/SKILL.md': skill('claude n'),
    'repo/pkg/.agents/skills/n/SKILL.md': skill('agents n'),
    'repo/pkg/.claude/skills/m/SKILL.md': skill('claude m'),
    'repo/pkg/deep/.agents/skills/m/SKILL.md': skill('deep agents m'),
    'repo/pkg/deep/f.ts': 'export {}\n',
  })
  const result = inChild(root, {
    body: `async t => {
      const dirs = await t.discoverSkillDirsForPaths([join(process.cwd(), 'pkg', 'deep', 'f.ts')], process.cwd());
      await t.addSkillDirectories(dirs);
      return { dirs: dirs.map(rel), dynamic: Object.fromEntries(t.getDynamicSkills().map(s => [s.name, s.description])) };
    }`,
  })
  assert.deepEqual(result.dirs, [
    'repo/pkg/deep/.agents/skills',
    'repo/pkg/.claude/skills',
    'repo/pkg/.agents/skills',
  ])
  assert.deepEqual(result.dynamic, { n: 'claude n', m: 'deep agents m' })
})

test('a skill found below the working folder never replaces one loaded at startup', () => {
  const root = makeRoot({
    'repo/.claude/skills/dup/SKILL.md': skill('startup'),
    'repo/pkg/.agents/skills/dup/SKILL.md': skill('nested'),
    'repo/pkg/src/a.ts': 'export {}\n',
  })
  const result = inChild(root, {
    body: `async t => {
      await t.getCommands(process.cwd());
      await t.addSkillDirectories(await t.discoverSkillDirsForPaths([join(process.cwd(), 'pkg', 'src', 'a.ts')], process.cwd()));
      return (await t.getCommands(process.cwd())).filter(c => c.name === 'dup').map(c => c.description);
    }`,
  })
  assert.deepEqual(result, ['startup'])
})

test('a gitignored folder keeps its .agents/skills out', t => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    t.skip('git is not installed')
    return
  }
  const root = makeRoot({
    'repo/.gitignore': 'vendor/\n',
    'repo/vendor/lib/.agents/skills/v/SKILL.md': skill('vendored'),
    'repo/vendor/lib/x.ts': 'export {}\n',
    'repo/kept/.agents/skills/k/SKILL.md': skill('kept'),
    'repo/kept/x.ts': 'export {}\n',
  })
  execFileSync('git', ['init', '-q'], { cwd: join(root, 'repo'), env: childEnv(root, {}) })
  const found = inChild(root, {
    body: `async t => (await t.discoverSkillDirsForPaths([
      join(process.cwd(), 'vendor', 'lib', 'x.ts'),
      join(process.cwd(), 'kept', 'x.ts'),
    ], process.cwd())).map(rel)`,
  })
  assert.deepEqual(found, ['repo/kept/.agents/skills'])
})

test('Windows symlink stubs and half-made skills are skipped without hiding the rest', () => {
  // With git's core.symlinks off (the Windows default) or after unzipping, a
  // symlink becomes a small text file holding its target path.
  const stubFolder = makeRoot({
    'repo/.agents/skills': '../skills',
    'repo/.claude/skills/ok/SKILL.md': skill('still loads'),
  })
  assert.deepEqual(
    inChild(stubFolder, { body: LOAD }).map(s => s.name),
    ['ok'],
  )
  const stubEntries = makeRoot({
    'repo/.agents/skills/stub': '../../.cline/skills/stub',
    'repo/.agents/skills/empty/': null,
    'repo/.agents/skills/real/SKILL.md': skill('real'),
  })
  assert.deepEqual(
    inChild(stubEntries, { body: LOAD }).map(s => s.name),
    ['real'],
  )
})

test('Agent Skills spec frontmatter loads', () => {
  const root = makeRoot({
    'repo/.agents/skills/spec/SKILL.md': [
      '---',
      'name: spec',
      'description: Spec-style skill',
      'license: Apache-2.0',
      'compatibility: Requires git',
      'metadata:',
      '  author: example',
      '  version: "1.0"',
      'allowed-tools: Read Grep',
      '---',
      '',
      'Body.',
      '',
    ].join('\n'),
  })
  const [spec] = inChild(root, { body: LOAD })
  assert.deepEqual([spec.name, spec.description, spec.root], [
    'spec',
    'Spec-style skill',
    'repo/.agents/skills/spec',
  ])
})

test('paths: frontmatter keeps a .agents skill waiting until a matching file is touched', () => {
  const root = makeRoot({
    'repo/.agents/skills/cond/SKILL.md': skill('conditional', 'paths: src/**/*.ts\n'),
    'repo/src/a.ts': 'export {}\n',
  })
  const result = inChild(root, {
    body: `async t => {
      const startup = (await t.getSkillDirCommands(process.cwd())).map(s => s.name);
      const elsewhere = t.activateConditionalSkillsForPaths([join(process.cwd(), 'docs', 'a.md')], process.cwd());
      const activated = t.activateConditionalSkillsForPaths([join(process.cwd(), 'src', 'a.ts')], process.cwd());
      return { startup, elsewhere, activated, dynamic: t.getDynamicSkills().map(s => s.name) };
    }`,
  })
  assert.deepEqual(result, { startup: [], elsewhere: [], activated: ['cond'], dynamic: ['cond'] })
})

test('edits to .agents/skills ask first, wherever it sits; the rest of .agents stays editable', () => {
  const root = makeRoot({
    'repo/.agents/skills/x/SKILL.md': skill('x'),
    'repo/.claude/skills/y/SKILL.md': skill('y'),
  })
  linkDir(root, 'repo/.agents/skills', 'repo/alias')
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  const unsafe = [
    join(repo, '.agents', 'skills', 'x', 'SKILL.md'),
    join(repo, '.agents', 'skills', 'new', 'SKILL.md'),
    join(repo, '.agents', 'skills'),
    join(repo, '.AGENTS', 'Skills', 'x', 'SKILL.md'),
    join(repo, 'pkg', '.agents', 'skills', 'x', 'SKILL.md'),
    join(home, '.agents', 'skills', 'x', 'SKILL.md'),
    `${repo.replaceAll('\\', '/')}/.agents/skills/x/SKILL.md`,
    join(repo, 'alias', 'x', 'SKILL.md'),
    join(repo, '.claude', 'skills', 'y', 'SKILL.md'),
  ]
  const safe = [
    join(repo, '.agents', 'notes', 'n.md'),
    join(repo, '.agents', 'skills.md'),
    join(repo, '.agents', 'skillset', 'x.md'),
    join(repo, '.agents'),
    join(repo, 'agents', 'skills', 'x.md'),
    join(repo, 'src', 'index.ts'),
  ]
  const verdicts = inChild(root, {
    body: `async t => ${JSON.stringify([...unsafe, ...safe])}.map(p => t.checkPathSafetyForAutoEdit(p).safe)`,
  })
  assert.deepEqual(verdicts, [...unsafe.map(() => false), ...safe.map(() => true)])
})

test('the Bash sandbox also blocks writes to .agents/skills', () => {
  const root = makeRoot()
  const denyWrite = inChild(root, {
    body: 'async t => t.convertToSandboxRuntimeConfig({}).filesystem.denyWrite.map(rel)',
  })
  assert.ok(denyWrite.includes('repo/.claude/skills'), JSON.stringify(denyWrite))
  assert.ok(denyWrite.includes('repo/.agents/skills'), JSON.stringify(denyWrite))
})

test('the model sees .agents skills in its skill list, after the .claude ones', () => {
  const root = makeRoot({
    'repo/.claude/skills/alpha/SKILL.md': skill('alpha from claude'),
    'repo/.agents/skills/gamma/SKILL.md': skill('gamma from agents'),
  })
  const result = inChild(root, {
    body: `async t => {
      const listed = await t.getSkillToolCommands(process.cwd());
      return { names: listed.map(c => c.name), text: t.formatCommandsWithinBudget(listed, 200000) };
    }`,
  })
  const alpha = result.names.indexOf('alpha')
  const gamma = result.names.indexOf('gamma')
  assert.ok(alpha >= 0 && gamma > alpha, JSON.stringify(result.names))
  assert.match(result.text, /gamma: gamma from agents/)
})
