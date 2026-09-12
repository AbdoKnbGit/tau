import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
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
    [/(?:^|\/)errors\.js$/, 'errors', `export const isENOENT = error => error?.code === 'ENOENT'; export const getErrnoCode = error => error?.code;`],
    [/(?:^|\/)file\.js$/, 'file', `export const FILE_NOT_FOUND_CWD_NOTE = ''; export const suggestPathUnderCwd = async () => undefined;`],
    [/permissions\/filesystem\.js$/, 'permissions', `
      export const checkReadPermissionForTool = async () => ({ behavior: 'allow' });
      export const getFileReadIgnorePatterns = context => context.denyPatterns ?? [];
      export const normalizePatternsToPath = patterns => patterns;
    `],
    [/plugins\/orphanedPluginFilter\.js$/, 'plugins', `import { state } from 'test:grep-state'; export const getGlobExclusionsForPluginCache = async () => state.pluginExclusions;`],
    [/^\.\/UI\.js$/, 'ui', `
      export const getToolUseSummary = () => '';
      export const renderToolResultMessage = () => null;
      export const renderToolUseErrorMessage = () => null;
      export const renderToolUseMessage = () => null;
    `],
    [/services\/analytics\/index\.js$/, 'analytics', `export const logEvent = () => {};`],
    [/(?:^|\/)debug\.js$/, 'debug', `export const logForDebugging = () => {};`],
    [/(?:^|\/)log\.js$/, 'log', `export const logError = () => {};`],
    [/(?:^|\/)slowOperations\.js$/, 'slow', `export const slowLogging = () => ({ [Symbol.dispose]() {} }); export const jsonStringify = JSON.stringify;`],
  ]
  const bundled = await build({
    stdin: {
      contents: `
        export { GrepTool } from './src/tools/GrepTool/GrepTool.ts';
        export { ripGrep, ripgrepCommand, getRipgrepMajorVersion } from './src/utils/ripgrep.ts';
        export { glob } from './src/utils/glob.ts';
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
          builder.onLoad({ filter: new RegExp(`^${name}$`), namespace: 'grep-test-service' }, () => ({ contents, loader: 'js' }))
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

  async function search(input: Record<string, unknown> = {}, denyPatterns: string[] = []) {
    const result = await tools.GrepTool.call(
      { pattern: 'needle', path: root, ...input },
      {
        abortController: new AbortController(),
        getAppState: () => ({ toolPermissionContext: { denyPatterns } }),
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

  test('explicit file and positive glob overrides still search ignored files', async () => {
    await file('.gitignore', 'ignored.ts\n')
    await file('source.ts')
    const ignored = await file('ignored.ts')
    expect(normalized((await search()).filenames)).toEqual(['source.ts'])
    expect(normalized((await search({ path: ignored })).filenames)).toEqual(['ignored.ts'])
    expect(normalized((await search({ glob: '*.ts' })).filenames)).toEqual(['ignored.ts', 'source.ts'])
    expect(normalized((await search({ glob: '*.ts !ignored.ts' })).filenames)).toEqual(['source.ts'])
  })

  test('deny patterns and orphaned-plugin exclusions retain precedence over a positive glob', async () => {
    await file('.gitignore', '*.ts\n')
    await file('source.ts')
    await file('denied.ts')
    await file('orphaned.ts')
    tools.state.pluginExclusions = ['!**/orphaned.ts']
    expect(normalized((await search({ glob: '*.ts' }, ['denied.ts'])).filenames)).toEqual(['source.ts'])
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

  test('default Glob still discovers ignored files after Grep filters them', async () => {
    await file('.gitignore', 'ignored.txt\n')
    await file('ignored.txt')
    await file('source.txt')
    expect((await search()).filenames).toEqual(['source.txt'])
    const result = await tools.glob('*.txt', root, { limit: 100, offset: 0 }, new AbortController().signal, {})
    expect(normalized(result.files.map((path: string) => relative(root, path)))).toEqual(['ignored.txt', 'source.txt'])
    expect(result.total).toBe(2)
  })
})
