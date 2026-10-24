import { copyFile, mkdir, readdir, realpath, stat, symlink } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'

export function isWithinDirectory(root: string, path: string): boolean {
  const rel = relative(root, path)
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  )
}

/** Keep cached links independent of the source checkout. Shared marketplace
 * content is copied, while targets outside the permitted source are omitted. */
export async function copyDir(
  src: string,
  dest: string,
  marketplaceRoot?: string,
): Promise<void> {
  const pluginRoot = await realpath(src)
  const cacheRoot = resolve(dest)
  if (isWithinDirectory(pluginRoot, cacheRoot))
    throw new Error('Plugin cache cannot be inside its source directory')
  const allowedRoot = marketplaceRoot
    ? await realpath(marketplaceRoot)
    : pluginRoot
  if (!isWithinDirectory(allowedRoot, pluginRoot))
    throw new Error('Plugin is outside its marketplace')

  async function copyDirectory(
    from: string,
    to: string,
    ancestors: Set<string>,
  ): Promise<void> {
    const actual = await realpath(from)
    if (!isWithinDirectory(allowedRoot, actual) || ancestors.has(actual)) return
    const next = new Set(ancestors).add(actual)
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = join(from, entry.name)
      const target = join(to, entry.name)
      if (entry.isDirectory()) {
        await copyDirectory(source, target, next)
      } else if (entry.isFile()) {
        await copyFile(source, target)
      } else if (entry.isSymbolicLink()) {
        let resolved: string
        try {
          resolved = await realpath(source)
        } catch (error) {
          if (
            ['ENOENT', 'ELOOP'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            continue
          throw error
        }
        if (!isWithinDirectory(allowedRoot, resolved)) continue
        const info = await stat(resolved)
        if (isWithinDirectory(pluginRoot, resolved)) {
          const cachedTarget = join(cacheRoot, relative(pluginRoot, resolved))
          try {
            await symlink(
              relative(dirname(target), cachedTarget) || '.',
              target,
              info.isDirectory() ? 'dir' : 'file',
            )
            continue
          } catch (error) {
            // Windows without Developer Mode cannot create symlinks. Copy the
            // allowed content instead; never leave a link into the source tree.
            if (
              !['EPERM', 'ENOTSUP'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            )
              throw error
          }
        }
        if (info.isDirectory()) await copyDirectory(resolved, target, next)
        else if (info.isFile()) await copyFile(resolved, target)
      }
    }
  }
  await copyDirectory(pluginRoot, cacheRoot, new Set())
}
