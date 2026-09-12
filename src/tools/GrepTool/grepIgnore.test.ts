import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getGrepIgnoreArgs } from './grepIgnore.js'

describe('Grep ignore policy', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tau-grep-ignore-'))
  })

  afterEach(async () => {
    // Never let a bad fixture path make recursive cleanup escape its temp root.
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(root).toContain('tau-grep-ignore-')
    await rm(root, { recursive: true, force: true })
  })

  test('enables gitignore outside a repository only on supported ripgrep', async () => {
    for (const version of [null, 0, 11]) {
      expect(await getGrepIgnoreArgs(root, version)).toEqual([])
    }
    for (const version of [12, 14, 15, 99]) {
      expect(await getGrepIgnoreArgs(root, version)).toEqual(['--no-require-git'])
    }
  })

  test('recognizes a .git directory at the target or any ancestor', async () => {
    await mkdir(join(root, '.git'))
    const nested = join(root, 'packages', 'app', 'src')
    await mkdir(nested, { recursive: true })
    expect(await getGrepIgnoreArgs(root, 15)).toEqual([])
    expect(await getGrepIgnoreArgs(nested, 15)).toEqual([])
  })

  test('recognizes the .git files used by worktrees and submodules', async () => {
    await writeFile(join(root, '.git'), 'gitdir: /external/git-directory\n')
    const nested = join(root, 'src')
    await mkdir(nested)
    expect(await getGrepIgnoreArgs(nested, 15)).toEqual([])
  })

  test('recognizes Jujutsu repository boundaries only for ripgrep 15+', async () => {
    await mkdir(join(root, '.jj'))
    const nested = join(root, 'src')
    await mkdir(nested)
    expect(await getGrepIgnoreArgs(nested, 14)).toEqual(['--no-require-git'])
    expect(await getGrepIgnoreArgs(nested, 15)).toEqual([])
  })

  test('rechecks repository state when a marker is added and removed', async () => {
    expect(await getGrepIgnoreArgs(root, 15)).toEqual(['--no-require-git'])
    const marker = join(root, '.git')
    await writeFile(marker, 'gitdir: /new/worktree\n')
    expect(await getGrepIgnoreArgs(root, 15)).toEqual([])
    await rm(marker)
    expect(await getGrepIgnoreArgs(root, 15)).toEqual(['--no-require-git'])
  })

  test('a sibling repository does not change the search target policy', async () => {
    await mkdir(join(root, 'sibling', '.git'), { recursive: true })
    const target = join(root, 'download')
    await mkdir(target)
    expect(await getGrepIgnoreArgs(target, 15)).toEqual(['--no-require-git'])
  })

  test('a repository below a non-repository search root does not redefine the root', async () => {
    const repo = join(root, 'child-repository')
    await mkdir(join(repo, '.git'), { recursive: true })
    expect(await getGrepIgnoreArgs(root, 15)).toEqual(['--no-require-git'])
    expect(await getGrepIgnoreArgs(repo, 15)).toEqual([])
  })

  test('keeps explicit files searchable even when their parent ignores them', async () => {
    await writeFile(join(root, '.gitignore'), '*.txt\n')
    const target = join(root, 'explicit.txt')
    await writeFile(target, 'needle\n')
    expect(await getGrepIgnoreArgs(target, 15)).toEqual([])
  })

  test('resolves a directory link before checking repository ancestors', async () => {
    const repo = join(root, 'repo')
    const source = join(repo, 'src')
    await mkdir(source, { recursive: true })
    await mkdir(join(repo, '.git'))
    const alias = join(root, 'linked-source')
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await getGrepIgnoreArgs(alias, 15)).toEqual([])
  })

  test('a link out of a repository uses its real non-repository target', async () => {
    const repo = join(root, 'repo')
    const target = join(root, 'download')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(target)
    const alias = join(repo, 'linked-download')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await getGrepIgnoreArgs(alias, 15)).toEqual(['--no-require-git'])
  })

  test('leaves missing paths to the existing search validation', async () => {
    expect(await getGrepIgnoreArgs(join(root, 'missing'), 15)).toEqual([])
  })

  test('does not inspect UNC paths during argument preparation', async () => {
    expect(await getGrepIgnoreArgs('\\\\unreachable.invalid\\share\\folder', 15)).toEqual([])
    expect(await getGrepIgnoreArgs('//unreachable.invalid/share/folder', 15)).toEqual([])
  })

  test('honors cancellation before traversing ancestors', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(getGrepIgnoreArgs(root, 15, controller.signal)).rejects.toThrow()
  })
})
