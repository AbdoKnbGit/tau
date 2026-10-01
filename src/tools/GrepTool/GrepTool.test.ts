import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// Bundle the production GrepTool, ignore policy, ripgrep process wrapper, path
// helpers and Glob together. Only unrelated application services are replaced:
// no terminal, user settings, accounts or telemetry are initialized by a search.
// The permission fixture supplies deny patterns; Grep's ordering and exclusions
// still run against a real ripgrep process, including explicit-glob overrides.
async function loadSearchTools() {
  const stubs: Array<[RegExp, string, string]> = [
    [/^test:grep-state$/, 'state', `export const state = { cwd: '', pluginExclusions: [] };`],
    [/(?:^|\/)Tool\.js$/, 'tool', `export const buildTool = definition => definition;`],
    [/(?:^|\/)cwd\.js$/, 'cwd', `import { state } from 'test:grep-state'; export const getCwd = () => state.cwd;`],
    [/(?:^|\/)errors\.js$/, 'errors', `export const isENOENT = error => error?.code === 'ENOENT'; export const getErrnoCode = error => error?.code; export const toError = error => error instanceof Error ? error : new Error(String(error));`],
    [/(?:^|\/)file\.js$/, 'file', `export const FILE_NOT_FOUND_CWD_NOTE = ''; export const suggestPathUnderCwd = async () => undefined;`],
    [/permissions\/filesystem\.js$/, 'permissions', `
      import ignore from 'ignore';
      import { isAbsolute, relative } from 'node:path';
      import { state } from 'test:grep-state';
      export const checkReadPermissionForTool = async (tool, input) => ({ behavior: 'allow', updatedInput: input, checkedPath: tool.getPath?.(input) });
      export const getFileReadIgnorePatterns = context => new Map([[null, context.denyPatterns ?? []], ...(context.denyRules ?? [])]);
      // Read's matcher in small: gitignore lines under their root (the working folder when none).
      export const matchingRuleForInput = (path, context, toolType, behavior) => {
        if (toolType !== 'read' || behavior !== 'deny') return null;
        for (const [root, patterns] of getFileReadIgnorePatterns(context)) {
          const rel = relative(root ?? state.cwd, path).replaceAll('\\\\', '/');
          if (!patterns.length || !rel || rel.startsWith('../') || isAbsolute(rel)) continue;
          if (ignore().add(patterns.map(pattern => pattern.replace(/\\/\\*\\*$/, ''))).ignores(rel)) return { ruleBehavior: 'deny' };
        }
        return null;
      };
    `],
    [/plugins\/orphanedPluginFilter\.js$/, 'plugins', `import { state } from 'test:grep-state'; export const getGlobExclusionsForPluginCache = async () => state.pluginExclusions;`],
    [/^\.\/UI\.js$/, 'ui', `
      export const getToolUseSummary = () => '';
      export const renderToolResultMessage = () => null;
      export const renderToolUseErrorMessage = () => null;
      export const renderToolUseMessage = () => null;
      export const userFacingName = () => 'Search';
    `],
    [/services\/analytics\/index\.js$/, 'analytics', `export const logEvent = () => {};`],
    [/(?:^|\/)debug\.js$/, 'debug', `export const logForDebugging = () => {};`],
    [/(?:^|\/)log\.js$/, 'log', `export const logError = () => {};`],
    [/(?:^|\/)slowOperations\.js$/, 'slow', `export const slowLogging = () => ({ [Symbol.dispose]() {} }); export const jsonStringify = JSON.stringify;`],
    [/(?:^|\/)ink\.js$/, 'ink', `export const Text = () => null;`],
  ]
  const bundled = await build({
    stdin: {
      contents: `
        export { GrepTool } from './src/tools/GrepTool/GrepTool.ts';
        export { GlobTool } from './src/tools/GlobTool/GlobTool.ts';
        export { VisualDesignAuditTool } from './src/tools/VisualDesignAuditTool/VisualDesignAuditTool.ts';
        export { ripGrep, ripgrepCommand, getRipgrepMajorVersion } from './src/utils/ripgrep.ts';
        export { glob, formatIgnoredNote } from './src/utils/glob.ts';
        export { listProjectFiles, foldersWithProjectFiles } from './src/utils/projectFiles.ts';
        export { readDenyExclusionGlobs } from './src/utils/permissions/readDenyGlobs.ts';
        export { retrieveCodebase, CodebaseRetrievalTool } from './src/tools/CodebaseRetrievalTool/CodebaseRetrievalTool.ts';
        export { primeLspServers } from './src/services/lsp/prime.ts';
        export { state } from 'test:grep-state';
      `,
      resolveDir: projectRoot,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    define: {
      'process.env.NODE_ENV': '"test"',
      'process.env.USER_TYPE': '"external"',
      'process.env.USE_BUILTIN_RIPGREP': 'undefined',
      'process.env.CLAUDE_CODE_GLOB_NO_IGNORE': 'undefined',
      'process.env.CLAUDE_CODE_GLOB_HIDDEN': 'undefined',
      // Test-mode ripgrep resolves ../../../vendor relative to this filename.
      // Use the project's actual distribution vendor folder without replacing
      // the production binary selector or its real version/availability probes.
      'import.meta.url': JSON.stringify(pathToFileURL(join(projectRoot, 'dist/src/utils/ripgrep.ts')).href),
    },
    plugins: [{
      name: 'isolate-search-services',
      setup(builder) {
        for (const [filter, name, contents] of stubs) {
          builder.onResolve({ filter }, args => {
            // Names such as errors.js and cwd.js also occur in dependencies.
            // Only replace Tau services; third-party code stays intact.
            if (args.importer.replaceAll('\\', '/').includes('/node_modules/')) return
            return { path: name, namespace: 'grep-test-service' }
          })
          builder.onLoad({ filter: new RegExp(`^${name}$`), namespace: 'grep-test-service' }, () => ({ contents, loader: 'js', resolveDir: projectRoot }))
        }
      },
    }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

describe('GrepTool with real ripgrep', () => {
  let tools: Awaited<ReturnType<typeof loadSearchTools>>
  let root: string
  let configRoot: string
  const environmentKeys = ['RIPGREP_CONFIG_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const
  const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]))

  async function cleanTemporaryDirectory(target: string, prefix: string) {
    expect(dirname(resolve(target))).toBe(resolve(tmpdir()))
    expect(target).toContain(prefix)
    await rm(target, { recursive: true, force: true })
  }

  beforeAll(async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'tau-grep-config-'))
    const emptyConfig = join(configRoot, 'empty-git-config')
    await writeFile(emptyConfig, '')
    process.env.RIPGREP_CONFIG_PATH = ''
    process.env.GIT_CONFIG_GLOBAL = emptyConfig
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    tools = await loadSearchTools()
  })

  afterAll(async () => {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (configRoot) await cleanTemporaryDirectory(configRoot, 'tau-grep-config-')
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tau-grep-tool-'))
    tools.state.cwd = root
    tools.state.pluginExclusions = []
  })

  afterEach(async () => {
    if (root) await cleanTemporaryDirectory(root, 'tau-grep-tool-')
  })

  async function file(name: string, content = 'needle\n') {
    const target = join(root, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    return target
  }

  async function search(input: Record<string, unknown> = {}, denyPatterns: string[] = [], denyRules: Array<[string, string[]]> = []) {
    const result = await tools.GrepTool.call(
      { pattern: 'needle', path: root, ...input },
      {
        abortController: new AbortController(),
        getAppState: () => ({ toolPermissionContext: { denyPatterns, denyRules } }),
      },
    )
    return result.data
  }

  const normalized = (paths: string[]) => paths.map(path => path.replaceAll('\\', '/')).sort()

  test('the production selector executes the vendored binary when it is available', async () => {
    const binary = join(projectRoot, 'dist', 'vendor', 'ripgrep', `${process.arch}-${process.platform}`, process.platform === 'win32' ? 'rg.exe' : 'rg')
    const command = tools.ripgrepCommand()
    if (existsSync(binary)) expect(command.rgPath).toBe(binary)
    const version = execFileSync(command.rgPath, [...command.rgArgs, '--version'], { encoding: 'utf8', windowsHide: true })
    const major = Number(/^ripgrep (\d+)\./.exec(version)?.[1])
    expect(major).toBeGreaterThanOrEqual(12)
    expect(await tools.getRipgrepMajorVersion()).toBe(major)
  })

  test('an extracted project excludes dependencies and generated files in every output mode', async () => {
    await file('.gitignore', 'node_modules/\ndist/\n')
    await file('src/auth.ts', 'needle one\nneedle two\n')
    await file('dist/auth.js')
    await file('node_modules/dependency/index.js')

    const files = await search()
    expect(normalized(files.filenames)).toEqual(['src/auth.ts'])
    expect(files.numFiles).toBe(1)
    const content = await search({ output_mode: 'content' })
    expect(content.numLines).toBe(2)
    expect(content.content).toContain('auth.ts:1:needle one')
    expect(content.content).toContain('auth.ts:2:needle two')
    expect(content.content).not.toContain('dist')
    expect(content.content).not.toContain('node_modules')
    const count = await search({ output_mode: 'count' })
    expect(count.numFiles).toBe(1)
    expect(count.numMatches).toBe(2)
    expect(count.content.replaceAll('\\', '/')).toBe('src/auth.ts:2')
  })

  test('nested ignore rules and negations stay local instead of leaking into siblings', async () => {
    await file('.gitignore', '*.log\n!keep.log\n')
    await file('ignored.log')
    await file('keep.log')
    await file('a/.gitignore', 'private.txt\n')
    await file('a/private.txt')
    await file('a/public.txt')
    await file('b/private.txt')
    expect(normalized((await search()).filenames)).toEqual(['a/public.txt', 'b/private.txt', 'keep.log'])
  })

  test('a child Git repository remains searchable under a parent ignoring everything', async () => {
    await file('.gitignore', '*\n')
    const repo = join(root, 'child')
    await mkdir(join(repo, '.git'), { recursive: true })
    await file('child/.gitignore', 'generated.txt\n')
    await file('child/source.txt')
    await file('child/generated.txt')
    expect(normalized((await search({ path: repo })).filenames)).toEqual(['child/source.txt'])
  })

  test('worktree .git files preserve the repository boundary', async () => {
    await file('.gitignore', '*\n')
    await file('worktree/.git', 'gitdir: /outside/worktree-metadata\n')
    await file('worktree/source.txt')
    expect(normalized((await search({ path: join(root, 'worktree') })).filenames)).toEqual(['worktree/source.txt'])
  })

  test('Jujutsu markers follow the installed ripgrep repository-boundary support', async () => {
    await file('.gitignore', '*\n')
    const repo = join(root, 'jujutsu')
    await mkdir(join(repo, '.jj'), { recursive: true })
    await file('jujutsu/source.txt')
    await file('jujutsu/.gitignore', 'generated.txt\n')
    await file('jujutsu/generated.txt')
    const supportsJujutsu = (await tools.getRipgrepMajorVersion()) >= 15
    expect(normalized((await search({ path: repo })).filenames)).toEqual(
      supportsJujutsu ? ['jujutsu/source.txt'] : [],
    )
  })

  test('repository creation and removal during a session update the search boundary', async () => {
    await file('.gitignore', '*\n')
    await file('download/source.txt')
    const target = join(root, 'download')
    expect((await search({ path: target })).filenames).toEqual([])
    const marker = join(target, '.git')
    await writeFile(marker, 'gitdir: /outside/worktree-metadata\n')
    expect(normalized((await search({ path: target })).filenames)).toEqual(['download/source.txt'])
    await rm(marker)
    expect((await search({ path: target })).filenames).toEqual([])
  })

  test('explicit targets outside the current repository get their own ignore policy', async () => {
    await mkdir(join(root, 'cwd', '.git'), { recursive: true })
    tools.state.cwd = join(root, 'cwd')
    await file('download/.gitignore', 'generated.txt\n')
    await file('download/source.txt')
    await file('download/generated.txt')
    const result = await search({ path: join(root, 'download') })
    expect(result.numFiles).toBe(1)
    expect(result.filenames[0]).toContain('source.txt')
  })

  test('an explicit file or include_ignored searches ignored files; a glob that names them does not', async () => {
    await file('.gitignore', 'ignored.ts\n')
    await file('source.ts')
    const ignored = await file('ignored.ts')
    expect(normalized((await search()).filenames)).toEqual(['source.ts'])
    expect(normalized((await search({ path: ignored })).filenames)).toEqual(['ignored.ts'])
    expect(normalized((await search({ glob: '*.ts' })).filenames)).toEqual(['source.ts'])
    expect(normalized((await search({ glob: '*.ts', include_ignored: true })).filenames)).toEqual(['ignored.ts', 'source.ts'])
    expect(normalized((await search({ glob: '*.ts !ignored.ts', include_ignored: true })).filenames)).toEqual(['source.ts'])
  })

  test('globs that match folder names do not search ignored folders', async () => {
    await file('.venv/.gitignore', '*\n')
    await file('.venv/Lib/site-packages/pkg/mod.py')
    await file('app.py')
    await file('src/model.py')
    for (const glob of ['*', '*.*', '**', '**/*', '*.py,*.md']) {
      expect(normalized((await search({ glob })).filenames)).toEqual(['app.py', 'src/model.py'])
    }
    expect((await search({ glob: '*', include_ignored: true })).filenames).toHaveLength(3)
    // Path globs keep their meaning, anchored at the searched folder.
    expect(normalized((await search({ glob: 'src/**' })).filenames)).toEqual(['src/model.py'])
    expect(normalized((await search({ glob: '*.py !app.py' })).filenames)).toEqual(['src/model.py'])
  })

  test('deny patterns and orphaned-plugin exclusions retain precedence over a positive glob', async () => {
    await file('.gitignore', '*.ts\n')
    await file('source.ts')
    await file('denied.ts')
    await file('orphaned.ts')
    tools.state.pluginExclusions = ['!**/orphaned.ts']
    const input = { glob: '*.ts', include_ignored: true }
    expect(normalized((await search(input, ['denied.ts'])).filenames)).toEqual(['source.ts'])
    // Beside `type` the glob stays an override; exclusions still win.
    expect(normalized((await search({ ...input, type: 'ts' }, ['denied.ts'])).filenames)).toEqual(['source.ts'])
  })

  test('a type filter preserves ignores while including hidden source and excluding VCS metadata', async () => {
    await file('.gitignore', 'ignored.ts\n')
    await file('ignored.ts')
    await file('.hidden.ts')
    await file('source.ts')
    await file('source.js')
    await file('.svn/private.ts')
    expect(normalized((await search({ type: 'ts' })).filenames)).toEqual(['.hidden.ts', 'source.ts'])
  })

  test('pagination and context operate on the filtered results', async () => {
    await file('.gitignore', 'ignored.txt\n')
    await file('ignored.txt')
    await file('a.txt', 'before\nneedle\nafter\n')
    await file('b.txt')
    await file('c.txt')
    const page = await search({ head_limit: 1, offset: 1 })
    expect(page.filenames).toEqual(['b.txt'])
    expect(page.appliedLimit).toBe(1)
    expect(page.appliedOffset).toBe(1)
    const context = await search({ output_mode: 'content', glob: 'a.txt', context: 1 })
    expect(context.numLines).toBe(3)
    expect(context.content).toContain('before')
    expect(context.content).toContain('needle')
    expect(context.content).toContain('after')
  })

  test('case-insensitive multiline search and no-match results preserve their output shapes', async () => {
    await file('.gitignore', 'ignored.txt\n')
    await file('ignored.txt', 'NEEDLE\nsecond\n')
    await file('source.txt', 'NEEDLE\nsecond\n')
    expect((await search({ pattern: 'needle.*second', '-i': true, multiline: true })).filenames).toEqual(['source.txt'])
    expect((await search({ pattern: 'not present' })).numFiles).toBe(0)
    expect((await search({ pattern: 'not present', output_mode: 'content' })).numLines).toBe(0)
    expect((await search({ pattern: 'not present', output_mode: 'count' })).numMatches).toBe(0)
  })

  test('cancellation remains a failure instead of an empty successful search', async () => {
    await file('source.txt')
    const controller = new AbortController()
    controller.abort()
    await expect(tools.GrepTool.call(
      { pattern: 'needle', path: root },
      { abortController: controller, getAppState: () => ({ toolPermissionContext: {} }) },
    )).rejects.toThrow()
  })

  test('invalid regular expressions fail in every output mode instead of reporting no matches', async () => {
    await file('source.txt')
    for (const output_mode of ['files_with_matches', 'content', 'count']) {
      await expect(search({ pattern: '[', output_mode })).rejects.toThrow('regex parse error')
    }
  })

  test('unsupported ripgrep flags fail instead of returning an empty successful search', async () => {
    await expect(tools.ripGrep(
      ['--tau-unsupported-regression-flag', '--', 'needle'],
      root,
      new AbortController().signal,
      { strictErrors: true },
    )).rejects.toThrow('tau-unsupported-regression-flag')
  })

  test('optional directory discovery keeps its empty fallback unless strict errors are requested', async () => {
    const missing = join(root, '.claude')
    expect(await tools.ripGrep(['--files'], missing, new AbortController().signal)).toEqual([])
    await expect(tools.ripGrep(
      ['--files'],
      missing,
      new AbortController().signal,
      { strictErrors: true },
    )).rejects.toThrow('.claude')
  })

  test('ripgrep exit 2 preserves valid results when another explicit input cannot be read', async () => {
    const source = await file('source.txt')
    const args = ['--files-with-matches', '--', 'needle', join(root, 'missing.txt')]
    const command = tools.ripgrepCommand()
    // Confirm this fixture exercises the partial-output error path, rather
    // than relying on platform-dependent permissions to produce an I/O error.
    const raw = spawnSync(command.rgPath, [...command.rgArgs, ...args, root], {
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(raw.status).toBe(2)
    expect(raw.stderr).toContain('missing.txt')
    expect(raw.stdout).toContain('source.txt')
    expect(await tools.ripGrep(args, root, new AbortController().signal, { strictErrors: true })).toEqual([source])
  })

  test('the process wrapper propagates caller ABORT_ERR cancellation', async () => {
    await file('source.txt')
    const controller = new AbortController()
    controller.abort()
    await expect(tools.ripGrep(['--', 'needle'], root, controller.signal, { strictErrors: true })).rejects.toMatchObject({
      code: 'ABORT_ERR',
    })
  })

  test('default discovery callers keep timeout-style cancellation handling', async () => {
    await file('source.txt')
    const controller = new AbortController()
    controller.abort()
    await expect(tools.ripGrep(['--files'], root, controller.signal)).rejects.toMatchObject({
      name: 'RipgrepTimeoutError',
      partialResults: [],
    })
  })

  test('Glob, like Grep, leaves out ignored files unless asked to include them', async () => {
    await file('.gitignore', 'ignored.txt\n')
    await file('ignored.txt')
    await file('source.txt')
    expect((await search()).filenames).toEqual(['source.txt'])
    const result = await globIn(root, '*.txt')
    expect(names(result.files)).toEqual(['source.txt'])
    expect(result.total).toBe(1)
    expect(places(result.ignored)).toEqual([['ignored.txt', 1]])
    const all = await globIn(root, '*.txt', { includeIgnored: true })
    expect(names(all.files)).toEqual(['ignored.txt', 'source.txt'])
    expect(all.total).toBe(2)
    expect(all.ignored).toBeUndefined()
  })

  function globIn(dir: string, pattern: string, options: { includeIgnored?: boolean } = {}, denyPatterns: string[] = [], denyRules: Array<[string, string[]]> = []) {
    return tools.glob(pattern, dir, { limit: 100, offset: 0 }, new AbortController().signal, { denyPatterns, denyRules }, options)
  }
  const names = (paths: string[]) => normalized(paths.map(path => relative(root, path)))
  const places = (ignored: { places: Array<{ path: string, count: number }> } | undefined) =>
    ignored?.places.map(place => [relative(root, place.path).replaceAll('\\', '/'), place.count])

  // A virtualenv as uv, virtualenv and Python 3.13+ write it: it ignores itself.
  async function virtualenv() {
    await file('.venv/.gitignore', '*\n')
    await file('.venv/Lib/site-packages/pkg/__init__.py')
    await file('.venv/Lib/site-packages/pkg/util.py')
  }

  test('Glob drops a self-ignoring virtualenv outside a repository and says where it went', async () => {
    await virtualenv()
    await file('app.py')
    await file('src/model.py')
    for (const pattern of ['**/*.py', '*.py']) {
      const result = await globIn(root, pattern)
      expect(names(result.files)).toEqual(['app.py', 'src/model.py'])
      expect(result.ignored.count).toBe(2)
      expect(places(result.ignored)).toEqual([['.venv', 2]])
    }
  })

  test('patterns that also match folders do not walk into ignored ones', async () => {
    await virtualenv()
    await file('.gitignore', 'build/\nsecret.py\n')
    await file('build/generated.py')
    await file('secret.py')
    await file('app.py')
    await file('src/model.py')
    for (const pattern of ['**/*', '*', '**', '**/*.*']) {
      const result = await globIn(root, pattern)
      expect(names(result.files)).toEqual(['.gitignore', 'app.py', 'src/model.py'])
      // .venv holds three: its own .gitignore matches its `*` too.
      expect(places(result.ignored)).toEqual([['.venv', 3], ['build', 1], ['secret.py', 1]])
      expect(result.ignored.count).toBe(5)
    }
  })

  test('path patterns keep their own meaning and still drop ignored matches', async () => {
    await file('.gitignore', 'src/generated/\n')
    await file('src/a.ts')
    await file('src/sub/b.ts')
    await file('src/generated/c.ts')
    await file('lib/d.ts')
    const nested = await globIn(root, 'src/**/*.ts')
    expect(names(nested.files)).toEqual(['src/a.ts', 'src/sub/b.ts'])
    expect(places(nested.ignored)).toEqual([['src/generated', 1]])
    const shallow = await globIn(root, 'src/*.ts')
    expect(names(shallow.files)).toEqual(['src/a.ts'])
    expect(shallow.ignored.count).toBe(0)
    const braced = await globIn(root, '{src,lib}/*.ts')
    expect(names(braced.files)).toEqual(['lib/d.ts', 'src/a.ts'])
  })

  test('both listing routes keep oldest-first order, with and without ignored files', async () => {
    await file('.gitignore', 'old.ts\n')
    const stamps: Array<[string, number]> = [['src/newest.ts', 4000], ['src/old.ts', 1000], ['src/middle.ts', 2000], ['src/older.ts', 1500]]
    for (const [name, seconds] of stamps) {
      const target = await file(name)
      await utimes(target, seconds, seconds)
    }
    const expected = ['src/older.ts', 'src/middle.ts', 'src/newest.ts']
    for (const pattern of ['**/*.ts', 'src/**/*.ts']) {
      const result = await globIn(root, pattern)
      expect(result.files.map((path: string) => relative(root, path).replaceAll('\\', '/'))).toEqual(expected)
    }
    const all = await globIn(root, '**/*.ts', { includeIgnored: true })
    expect(all.files.map((path: string) => relative(root, path).replaceAll('\\', '/'))).toEqual(['src/old.ts', ...expected])
  })

  test('searching inside an ignored folder lists nothing but reports what is there', async () => {
    await virtualenv()
    const result = await globIn(join(root, '.venv', 'Lib'), '**/*.py')
    expect(result.files).toEqual([])
    expect(places(result.ignored)).toEqual([['.venv/Lib/site-packages', 2]])
    const included = await globIn(join(root, '.venv', 'Lib'), '**/*.py', { includeIgnored: true })
    expect(included.files).toHaveLength(2)
  })

  test('deny rules and plugin exclusions still win, and what they hide is not counted', async () => {
    await file('.gitignore', 'ignored.py\n')
    await file('ignored.py')
    await file('denied.py')
    await file('orphaned.py')
    await file('source.py')
    // A rule rooted at the searched folder must anchor there, not in the
    // directory tau was started from.
    await file('secret/key.py')
    tools.state.pluginExclusions = ['!**/orphaned.py']
    const rooted: Array<[string, string[]]> = [[root, ['/secret/**']]]
    const result = await globIn(root, '*.py', {}, ['denied.py'], rooted)
    expect(names(result.files)).toEqual(['source.py'])
    expect(places(result.ignored)).toEqual([['ignored.py', 1]])
    const all = await globIn(root, '*.py', { includeIgnored: true }, ['denied.py'], rooted)
    expect(names(all.files)).toEqual(['ignored.py', 'source.py'])
  })

  test('a deny rule applies wherever the search starts: at, below or above its root', async () => {
    await file('keys/root.pem')
    await file('app/src/main.ts')
    await file('app/src/leaked.pem')
    await file('app/secret/token.txt')
    await file('app/private/notes.txt')
    await file('other/free.pem')
    const app = join(root, 'app')
    // Rooted above the search: `**` walks down to it, a literal must match.
    const above: Array<[string, string[]]> = [[root, ['/**/*.pem', '/app/secret/**', '/elsewhere/**']]]
    const fromApp = await globIn(app, '**/*', {}, [], above)
    expect(names(fromApp.files)).toEqual(['app/private/notes.txt', 'app/src/main.ts'])
    expect(fromApp.ignored.count).toBe(0)
    const grep = await search({ path: app, pattern: '.', output_mode: 'files_with_matches' }, [], above)
    expect(normalized(grep.filenames)).toEqual(['app/private/notes.txt', 'app/src/main.ts'])
    // Rooted below the search: the path between them is prefixed.
    const below: Array<[string, string[]]> = [[app, ['/private/**']]]
    const fromRoot = await globIn(root, '**/*.txt', {}, [], below)
    expect(names(fromRoot.files)).toEqual(['app/secret/token.txt'])
    // Another tree entirely: nothing to exclude.
    const unrelated: Array<[string, string[]]> = [[join(root, 'other'), ['/**']]]
    expect(names((await globIn(app, '**/*.pem', {}, [], unrelated)).files)).toEqual(['app/src/leaked.pem'])
  })

  test('deny rule paths with glob characters in folder names match those folders only', async () => {
    await file('we[ird]/{x}/secret.txt')
    await file('we[ird]/{x}/other/keep.txt')
    await file('wei/x/secret.txt')
    const rules: Array<[string, string[]]> = [[join(root, 'we[ird]', '{x}'), ['/secret.txt']]]
    expect(names((await globIn(root, '**/*.txt', {}, [], rules)).files))
      .toEqual(['we[ird]/{x}/other/keep.txt', 'wei/x/secret.txt'])
  })

  test('Grep globs with a folder part anchor at the searched path, wherever tau runs', async () => {
    await file('src/a.ts')
    await file('lib/src/b.ts')
    await file('docs/c.ts')
    // The test process runs in the repository, not in this temporary root.
    expect(process.cwd()).not.toBe(root)
    expect(normalized((await search({ glob: 'src/**/*.ts' })).filenames)).toEqual(['src/a.ts'])
    expect(normalized((await search({ glob: './src/*.ts' })).filenames)).toEqual(['src/a.ts'])
    expect(normalized((await search({ glob: '*.ts' })).filenames)).toEqual(['docs/c.ts', 'lib/src/b.ts', 'src/a.ts'])
    const content = await search({ glob: 'src/**/*.ts', output_mode: 'content' })
    expect(content.numLines).toBe(1)
    expect(content.content.replaceAll('\\', '/')).toEndWith('src/a.ts:1:needle')
    const count = await search({ glob: 'src/**/*.ts', output_mode: 'count' })
    expect(count.content.replaceAll('\\', '/')).toBe('src/a.ts:1')
  })

  test('VCS metadata is never listed or searched, even by a pattern that matches everything', async () => {
    await file('.git/HEAD', 'needle\n')
    await file('.git/hooks/pre-commit.sample', 'needle\n')
    await file('.hg/store/data', 'needle\n')
    await file('src/main.ts')
    for (const pattern of ['**/*', '*', '**']) {
      const result = await globIn(root, pattern, { includeIgnored: pattern === '*' })
      expect(names(result.files)).toEqual(['src/main.ts'])
      if (pattern !== '*') expect(result.ignored.count).toBe(0)
    }
    expect(normalized((await search({ glob: '*' })).filenames)).toEqual(['src/main.ts'])
    expect(normalized((await search({ path: join(root, '.git') })).filenames)).toEqual(['.git/HEAD', '.git/hooks/pre-commit.sample'])
  })

  test('a root spelled with forward slashes comes back in the platform spelling', async () => {
    await file('src/a.ts')
    const slashed = root.replaceAll('\\', '/')
    const expected = [join(root, 'src', 'a.ts')]
    expect((await globIn(slashed, 'src/*.ts')).files).toEqual(expected)
    expect((await globIn(root, `${slashed}/src/*.ts`)).files).toEqual(expected)
    const signal = new AbortController().signal
    expect(await tools.listProjectFiles(slashed, { hidden: 'none', signal })).toEqual(expected)
  })

  test('a search root reached through a symlink still anchors folder globs', async () => {
    // macOS /tmp and /var are symlinks: the OS reports rg's working folder
    // with them resolved, which an absolute target would no longer match.
    await file('real/src/a.ts')
    await file('real/.gitignore', 'src/gen/\n')
    await file('real/src/gen/b.ts')
    const link = join(root, 'link')
    await symlink(join(root, 'real'), link, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await globIn(link, 'src/**/*.ts')).files).toEqual([join(link, 'src', 'a.ts')])
    expect(normalized((await search({ path: link, glob: 'src/**/*.ts' })).filenames)).toEqual(['link/src/a.ts'])
  })
  test('Glob patterns starting with ./ match like the same pattern without it', async () => {
    await file('src/a.ts')
    await file('src/sub/b.ts')
    await file('lib/c.ts')
    expect(names((await globIn(root, './src/**/*.ts')).files)).toEqual(['src/a.ts', 'src/sub/b.ts'])
    expect(names((await globIn(root, './*.ts')).files)).toEqual(['lib/c.ts', 'src/a.ts', 'src/sub/b.ts'])
    expect(names((await globIn(root, '././src/*.ts', { includeIgnored: true })).files)).toEqual(['src/a.ts'])
  })

  test('the project walk honours ignore files, skips VCS metadata, and never names a folder', async () => {
    await file('.venv/.gitignore', '*\n')
    await file('.venv/Lib/site-packages/pkg/mod.py')
    await file('.gitignore', 'node_modules/\ndist/\n')
    await file('node_modules/dep/index.js')
    await file('dist/app.js')
    await file('.git/config')
    await file('.config/settings.json')
    await file('.env')
    await file('build/keep.py')
    await file('src/app.py')
    const signal = new AbortController().signal
    const walk = (hidden: string, extra = {}) => tools.listProjectFiles(root, { hidden, signal, ...extra })
    expect(names(await walk('all'))).toEqual(['.config/settings.json', '.env', '.gitignore', 'build/keep.py', 'src/app.py'])
    expect(names(await walk('files'))).toEqual(['.env', '.gitignore', 'build/keep.py', 'src/app.py'])
    expect(names(await walk('none'))).toEqual(['build/keep.py', 'src/app.py'])
    expect(names(await walk('files', { names: ['*.[pP][yY]'] }))).toEqual(['build/keep.py', 'src/app.py'])
    expect(names(await walk('files', { maxDepth: 1 }))).toEqual(['.env', '.gitignore'])
    await mkdir(join(root, 'empty'))
    const folders = await tools.foldersWithProjectFiles(root, ['build', 'dist', 'empty', 'node_modules', 'src'], { hidden: 'files', signal })
    expect(folders).toEqual(['build', 'src'])
  })

  test('code retrieval outside a repository reads what the ignore files keep', async () => {
    await file('.venv/.gitignore', '*\n')
    await file('.venv/Lib/site-packages/tokenizer/core.py', 'def tokenize_prompt(): pass\n')
    await file('.gitignore', 'vendor_copy/\n')
    await file('vendor_copy/tokenizer.py', 'def tokenize_prompt(): pass\n')
    await file('app/tokenizer.py', 'def tokenize_prompt(): pass\n')
    const output = await tools.retrieveCodebase({ query: 'tokenize prompt', root }, { permissionContext: {} })
    expect(output.matches.map((match: { relativePath: string }) => match.relativePath.replaceAll('\\', '/'))).toEqual(['app/tokenizer.py'])
    expect(output.searchedFiles).toBe(2)
  })

  const retrieved = async (permissionContext: object, searchRoot = root) =>
    (await tools.retrieveCodebase({ query: 'tokenize prompt', root: searchRoot }, { permissionContext })).matches
      .map((match: { relativePath: string }) => match.relativePath.replaceAll('\\', '/'))
      .sort()

  test('code retrieval leaves out what a read-deny rule covers, listed by git or by the walk', async () => {
    const text = 'def tokenize_prompt(): return "tokenize prompt"\n'
    await file('app/tokenizer.py', text)
    await file('config/secret.txt', text)
    await file('private/keys.py', text)
    const deny = { denyPatterns: ['secret.txt', 'private/**'] }
    expect(await retrieved({})).toEqual(['app/tokenizer.py', 'config/secret.txt', 'private/keys.py'])
    expect(await retrieved(deny)).toEqual(['app/tokenizer.py'])
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    expect(await retrieved({})).toEqual(['app/tokenizer.py', 'config/secret.txt', 'private/keys.py'])
    expect(await retrieved(deny)).toEqual(['app/tokenizer.py'])
  })

  test('code retrieval applies a rule written for the real folder behind a symlinked root', async () => {
    const text = 'def tokenize_prompt(): return "tokenize prompt"\n'
    await file('real/app.py', text)
    await file('real/notes.md', text)
    const link = join(root, 'link')
    await symlink(join(root, 'real'), link, process.platform === 'win32' ? 'junction' : 'dir')
    const denyRealNotes = { denyRules: [[realpathSync(join(root, 'real')), ['notes.md']]] }
    expect(await retrieved({}, link)).toEqual(['app.py', 'notes.md'])
    expect(await retrieved(denyRealNotes, link)).toEqual(['app.py'])
  })

  test('code retrieval does not read a denied file through a symlink to it', async () => {
    const text = 'def tokenize_prompt(): return "tokenize prompt"\n'
    await file('app/tokenizer.py', text)
    await file('private/keys.py', text)
    try {
      await symlink(join(root, 'private', 'keys.py'), join(root, 'app', 'keys_link.py'), 'file')
    } catch (error) {
      // Windows without symlink rights: nothing to test on this machine.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    // Git lists a symlink as a file of its own; the walk skips symlinks.
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    expect(await retrieved({})).toContain('app/keys_link.py')
    expect(await retrieved({ denyPatterns: ['private/**'] })).toEqual(['app/tokenizer.py'])
  })

  test('code retrieval asks the read-permission check about the folder it will search', async () => {
    const context = { getAppState: () => ({ toolPermissionContext: {} }) }
    const checked = async (input: Record<string, unknown>) =>
      (await tools.CodebaseRetrievalTool.checkPermissions({ query: 'x', ...input }, context)).checkedPath
    expect(await checked({})).toBe(root)
    expect(await checked({ root: 'sub' })).toBe(join(root, 'sub'))
    expect(basename(await checked({ root: join(root, '..', 'elsewhere') }))).toBe('elsewhere')
  })

  test('LSP warm-up primes each server with its shallowest file the ignore files keep', async () => {
    await file('.venv/.gitignore', '*\n')
    await file('.venv/Lib/site-packages/a.py')
    await file('.gitignore', 'node_modules/\n')
    await file('node_modules/x/y.ts')
    await file('.storybook/main.ts')
    await file('packages/core/src/index.ts')
    await file('src/app.TS')
    await file('tools/run.py')
    tools.state.cwd = root
    const opened: string[] = []
    const server = (name: string, exts: string[]) => [name, {
      name,
      config: { alwaysOn: true, extensionToLanguage: Object.fromEntries(exts.map(ext => [ext, name])) },
      waitUntilReady: async () => {},
    }] as const
    const servers = new Map([server('ts', ['.ts', '.tsx']), server('py', ['.py'])])
    const manager = {
      getAllServers: () => servers,
      getServerForFile: (file: string) => servers.get(file.toLowerCase().endsWith('.py') ? 'py' : 'ts'),
      openFile: async (path: string) => { opened.push(path) },
    }
    await tools.primeLspServers(manager)
    // Each primer is opened once its file has been read.
    for (let i = 0; i < 100 && opened.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(names(opened)).toEqual(['src/app.TS', 'tools/run.py'])
  })

  test('deny rules become anchored exclusion globs for every root relationship', () => {
    const anchor = join(root, 'proj')
    const globs = (entries: Array<[string | null, string[]]>, at = anchor) => tools.readDenyExclusionGlobs(new Map(entries), at)
    expect(globs([[null, ['.env', 'secrets/**', 'build/']]])).toEqual(['!**/.env', '!**/secrets/**', '!**/build/'])
    expect(globs([[anchor, ['/secrets/**', 'key.pem']]])).toEqual(['!/secrets/**', '!/**/key.pem'])
    expect(globs([[join(anchor, 'a b', 'c*d'), ['/x.txt']]])).toEqual(['!/a b/c[*]d/x.txt'])
    expect(globs([[root, ['/proj/secret/**', '/**/*.key', '/other/**', '/proj', '/p*/tmp/']]])).toEqual([
      '!/secret/**', '!/**/*.key', '!**', '!/tmp/',
    ])
    expect(globs([[join(root, 'elsewhere'), ['/**']]])).toEqual([])
  })

  test('the Glob result leads with what was left out, and accepts include_ignored as a string', async () => {
    const ignored = { count: 3, places: [{ path: '.venv', count: 2 }, { path: 'build', count: 1 }], morePlaces: 0 }
    const note = '(Left out 3 matches excluded by .gitignore/.ignore rules: .venv (2), build (1). Pass include_ignored: true to include them.)'
    const listed = tools.GlobTool.mapToolResultToToolResultBlockParam({ filenames: ['app.py'], numFiles: 1, durationMs: 1, truncated: false, ignored }, 'id')
    expect(listed.content).toBe(`${note}\napp.py`)
    const empty = tools.GlobTool.mapToolResultToToolResultBlockParam({ filenames: [], numFiles: 0, durationMs: 1, truncated: false, ignored }, 'id')
    expect(empty.content).toBe(`No files found\n${note}`)
    const none = tools.GlobTool.mapToolResultToToolResultBlockParam({ filenames: [], numFiles: 0, durationMs: 1, truncated: false, ignored: { count: 0, places: [], morePlaces: 0 } }, 'id')
    expect(none.content).toBe('No files found')
    expect(tools.formatIgnoredNote({ count: 1, places: [{ path: '.env', count: 1 }], morePlaces: 0 }))
      .toBe('(Left out 1 match excluded by .gitignore/.ignore rules: .env (1). Pass include_ignored: true to include it.)')
    expect(tools.formatIgnoredNote({ count: 9, places: [{ path: 'a', count: 5 }], morePlaces: 2 }))
      .toBe('(Left out 9 matches excluded by .gitignore/.ignore rules: a (5), 2 more places. Pass include_ignored: true to include them.)')
    expect(tools.formatIgnoredNote({ count: null, places: [], morePlaces: 0 }))
      .toBe('(Matches excluded by .gitignore/.ignore rules are left out, and counting them failed. Pass include_ignored: true to include them.)')
    expect(tools.GlobTool.inputSchema.parse({ pattern: '*.py', include_ignored: 'true' }).include_ignored).toBe(true)
  })

  test('the Glob tool passes include_ignored through', async () => {
    await virtualenv()
    await file('app.py')
    const call = (input: Record<string, unknown>) => tools.GlobTool.call(
      { pattern: '**/*.py', path: root, ...input },
      { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: {} }) },
    ).then((result: { data: { filenames: string[], ignored?: { count: number } } }) => result.data)
    const plain = await call({})
    expect(plain.filenames.map((path: string) => path.replaceAll('\\', '/')).filter((path: string) => path.includes('.venv'))).toEqual([])
    expect(plain.ignored?.count).toBe(2)
    const all = await call({ include_ignored: true })
    expect(all.filenames).toHaveLength(3)
    expect(all.ignored).toBeUndefined()
  })

  test('the design audit scans what the ignore files keep and reports the rest', async () => {
    await file('.venv/.gitignore', '*\n')
    await file('.venv/Lib/site-packages/viewer/static/style.css', 'body { color: #fff }\n')
    await file('web/app.css', '@media (min-width: 40rem) { body { color: #000 } }\n')
    await file('web/index.html', '<img src="hero.png">\n')
    const audit = (input: Record<string, unknown>) => tools.VisualDesignAuditTool.call(
      { root, ...input },
      { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: {} }) },
    ).then((result: { data: Record<string, any> }) => result.data)
    const plain = await audit({})
    expect(plain.scannedFiles).toBe(2)
    expect(plain.styleFiles.map((path: string) => relative(root, path).replaceAll('\\', '/'))).toEqual(['web/app.css'])
    expect(places(plain.ignored)).toEqual([['.venv', 1]])
    const text = tools.VisualDesignAuditTool.mapToolResultToToolResultBlockParam(plain, 'id').content
    expect(text).toContain('(Left out 1 frontend file excluded by .gitignore/.ignore rules: ')
    const all = await audit({ include_ignored: true })
    expect(all.scannedFiles).toBe(3)
    expect(all.ignored).toBeUndefined()
    const capped = await audit({ maxFiles: 1 })
    expect(capped.scannedFiles).toBe(1)
    expect(tools.VisualDesignAuditTool.mapToolResultToToolResultBlockParam(capped, 'id').content).toContain('Scanned files: 1 of 2 found')
  })
})
