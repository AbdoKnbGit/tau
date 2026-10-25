import { readdir, stat } from 'fs/promises'
import { join, relative } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { hasExplicitWorkspaceTrust } from '../config.js'
import { getClaudeConfigHomeDir, isBareMode } from '../envUtils.js'
import { findCanonicalGitRoot, findGitRoot } from '../git.js'
import { isSettingSourceEnabled } from '../settings/constants.js'
import { getSettingsForSource } from '../settings/settings.js'
import { isSourceAllowedByPolicy } from './marketplaceHelpers.js'

export function areSkillsDirectoryPluginsAllowed(): boolean {
  const policy =
    getSettingsForSource('policySettings')?.strictPluginOnlyCustomization
  return (
    policy !== true &&
    !(Array.isArray(policy) && policy.length > 0) &&
    isSourceAllowedByPolicy({ source: 'skills-dir' })
  )
}

// The trust dialog may list candidates before consent; discovery only stats
// manifest paths and never reads or executes plugin components.
export async function discoverSkillsDirectoryPlugins(
  includeUntrustedProject = false,
): Promise<Array<{ path: string; scope: 'user' | 'project' }>> {
  if (isBareMode() || !areSkillsDirectoryPluginsAllowed()) return []
  const roots: Array<{ path: string; scope: 'user' | 'project' }> = []
  if (isSettingSourceEnabled('userSettings'))
    roots.push({
      path: join(getClaudeConfigHomeDir(), 'skills'),
      scope: 'user',
    })
  if (
    isSettingSourceEnabled('projectSettings') &&
    (includeUntrustedProject || hasExplicitWorkspaceTrust())
  ) {
    let project = getOriginalCwd()
    // Desktop worktrees share project customization with their main checkout.
    // Preserve the primary directory's relative path; do not walk its parents.
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') {
      const worktree = findGitRoot(project)
      const canonical = findCanonicalGitRoot(project)
      if (worktree && canonical && worktree !== canonical)
        project = join(canonical, relative(worktree, project))
    }
    roots.push({ path: join(project, '.claude', 'skills'), scope: 'project' })
  }
  const found: Array<{ path: string; scope: 'user' | 'project' }> = []
  for (const root of roots) {
    const entries = await readdir(root.path, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(root.path, entry.name)
      if (
        await stat(join(path, '.claude-plugin', 'plugin.json')).then(
          s => s.isFile(),
          () => false,
        )
      ) {
        found.push({ path, scope: root.scope })
      }
    }
  }
  return found
}
