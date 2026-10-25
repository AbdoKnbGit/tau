import { execFile } from 'child_process'
import { lstat, mkdir, realpath, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { gitExe } from '../git.js'
import { isWithinDirectory } from './pluginFiles.js'
import { PluginManifestSchema } from './schemas.js'
import { areSkillsDirectoryPluginsAllowed } from './skillsDirectory.js'

const components = new Set([
  'skills',
  'agents',
  'hooks',
  'mcp',
  'lsp',
  'output-style',
  'channel',
])
export type ScaffoldPluginOptions = {
  description?: string
  author?: string
  authorEmail?: string
  with?: string[]
  force?: boolean
}

export async function scaffoldPlugin(
  name: string,
  options: ScaffoldPluginOptions = {},
): Promise<string> {
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)
  ) {
    throw new Error(
      'Use a plugin name of 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit.',
    )
  }
  for (const value of options.with ?? [])
    if (!components.has(value)) throw new Error(`Unknown component: ${value}`)
  if (!areSkillsDirectoryPluginsAllowed())
    throw new Error(
      "Plugins from the skills directory are blocked by your organization's managed settings",
    )
  const root = join(getClaudeConfigHomeDir(), 'skills')
  const path = join(root, name)
  const manifestPath = join(path, '.claude-plugin', 'plugin.json')
  for (const target of [path, dirname(manifestPath), manifestPath]) {
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isSymbolicLink())
      throw new Error(`Cannot scaffold over a symbolic link: ${target}`)
    if (info && target === manifestPath && !options.force)
      throw new Error(
        `Plugin already exists at ${path}. Use --force to replace its manifest.`,
      )
  }
  const gitConfig = async (key: string) => {
    try {
      return (
        (
          await promisify(execFile)(gitExe(), ['config', '--get', key], {
            timeout: 2000,
            windowsHide: true,
          })
        ).stdout.trim() || undefined
      )
    } catch {
      return undefined
    }
  }
  const authorName = options.author ?? (await gitConfig('user.name'))
  const authorEmail = options.authorEmail ?? (await gitConfig('user.email'))
  const selected = new Set(options.with ?? [])
  const manifest = PluginManifestSchema().parse({
    name,
    version: '0.1.0',
    description: options.description ?? `Tools and instructions for ${name}`,
    ...(authorName
      ? {
          author: {
            name: authorName,
            ...(authorEmail ? { email: authorEmail } : {}),
          },
        }
      : {}),
    ...(selected.has('channel')
      ? { channels: [{ server: name }], mcpServers: './.mcp.json' }
      : {}),
  })
  const files: Record<string, string> = {
    'SKILL.md': `---\nname: ${name}\ndescription: ${JSON.stringify(manifest.description)}\n---\nDescribe the task you want this skill to perform.\n`,
  }
  if (selected.has('skills'))
    files['skills/example/SKILL.md'] =
      '---\nname: example\ndescription: Inspect a file and explain its contents\nallowed-tools: Read\n---\nRead the file requested by the user and explain its contents. Do not change it.\n'
  if (selected.has('agents'))
    files['agents/reviewer.md'] =
      '---\nname: reviewer\ndescription: Review code and report concrete issues\ntools: Read, Grep, Glob\n---\nReview the requested code and explain actionable findings. Do not change files.\n'
  if (selected.has('hooks'))
    files['hooks/hooks.json'] = JSON.stringify({ hooks: {} }, null, 2) + '\n'
  if (selected.has('lsp')) files['.lsp.json'] = '{}\n'
  if (selected.has('output-style'))
    files['output-styles/concise.md'] =
      '---\nname: concise\ndescription: Concise responses with concrete evidence\n---\nState the result first and include the evidence needed to assess it.\n'
  if (selected.has('mcp') || selected.has('channel')) {
    files['.mcp.json'] =
      JSON.stringify(
        {
          mcpServers: {
            [name]: {
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'],
            },
          },
        },
        null,
        2,
      ) + '\n'
    files['server.mjs'] = `import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}${selected.has('channel') ? ', experimental: { "claude/channel": {} }' : ''} }, serverInfo: { name: ${JSON.stringify(name)}, version: '0.1.0' } }
    : message.method === 'tools/list' ? { tools: [] } : message.method === 'ping' ? {} : undefined;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(result === undefined ? { error: { code: -32601, message: 'Method not found' } } : { result }) }) + '\\n');
});
`
  }
  // Validate every existing destination before creating any component. A
  // partially existing scaffold may contain links in intermediate directories.
  for (const relativePath of [
    ...Object.keys(files),
    '.claude-plugin/plugin.json',
  ]) {
    const destination = join(path, relativePath)
    for (
      let current = destination;
      current !== root;
      current = dirname(current)
    ) {
      const info = await lstat(current).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        },
      )
      if (info?.isSymbolicLink())
        throw new Error(`Cannot scaffold over a symbolic link: ${current}`)
      if (
        info &&
        !(current === destination ? info.isFile() : info.isDirectory())
      ) {
        throw new Error(`Invalid scaffold destination: ${current}`)
      }
    }
  }
  await mkdir(root, { recursive: true })
  await mkdir(path, { recursive: true })
  if (!isWithinDirectory(await realpath(root), await realpath(path)))
    throw new Error('Plugin directory escapes the skills directory')
  // Preserve existing skill/component contents, including during --force.
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = join(path, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    if (
      !isWithinDirectory(
        await realpath(path),
        await realpath(dirname(destination)),
      )
    )
      throw new Error(`Scaffold component escapes plugin: ${relativePath}`)
    await writeFile(destination, content, { flag: 'wx' }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      },
    )
  }
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
    flag: options.force ? 'w' : 'wx',
  })
  return path
}
