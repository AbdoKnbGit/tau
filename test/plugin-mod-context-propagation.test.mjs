import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { z } from 'zod/v4'
import {
  loadMcpRuntime,
  fixtureContext,
  fixtureTool,
} from './helpers/mcp-built-runtime.mjs'

const original = process.cwd(),
  root = mkdtempSync(join(tmpdir(), 'tau-mod-context-')),
  project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '',
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  TAU_MCP_TEST_BUNDLE: resolve('dist/tau.mjs'),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: [
    'src/utils/plugins/mods/manager.ts',
    'src/services/tools/StreamingToolExecutor.ts',
    'src/services/tools/toolOrchestration.ts',
  ],
  exports: [
    'StreamingToolExecutor',
    'runTools',
    'startPluginMods',
    'stopPluginMods',
    'setInlinePlugins',
    'resetSettingsCache',
    'clearAllCaches',
    'getModWarnings',
    'setOriginalCwd',
    'setSessionTrustAccepted',
    'setAllowedSettingSources',
    'setIsInteractive',
    'getManagedFilePath',
    'createAssistantMessage',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setIsInteractive(false)
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
afterEach(async () => {
  await r.stopPluginMods()
  r.setInlinePlugins([])
  r.resetSettingsCache()
  r.clearAllCaches()
})
after(() => {
  process.chdir(original)
  rmSync(root, { recursive: true, force: true, maxRetries: 10 })
})

for (const event of ['tool.call', 'tool.check'])
  for (const streaming of [true, false]) {
    test(`${event} nested effects survive the ${streaming ? 'streaming' : 'batch'} executor exactly once and reach the following tool`, async () => {
      const plugin = join(root, event + '-' + streaming)
      write(join(plugin, '.claude-plugin/plugin.json'), {
        name: 'context-' + event.replace('.', '-') + '-' + streaming,
        version: '1.0.0',
      })
      write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
      write(
        join(plugin, 'hooks/register.ts'),
        `export function register(on){on('${event}',{tool:'Outer'},async($,e,next)=>{await $.tool.call({tool:'ChangeContext',path:${event === 'tool.call' ? 'e.path' : 'e.input.path'}});return next(e)});}`,
      )
      r.setInlinePlugins([plugin])
      r.resetSettingsCache()
      r.clearAllCaches()
      await r.startPluginMods(true)
      assert.deepEqual(r.getModWarnings(), [])
      const observed = [],
        applied = []
      const make = (name, call) =>
        fixtureTool({
          name,
          isEnabled: () => true,
          inputSchema: z.object({ path: z.string() }),
          isConcurrencySafe: () => true,
          call,
          mapToolResultToToolResultBlockParam: (value, id) => ({
            type: 'tool_result',
            tool_use_id: id,
            content: JSON.stringify(value),
          }),
        })
      const inner = make('ChangeContext', async input => ({
        data: { changed: input.path },
        contextModifier: current => {
          applied.push(input.path)
          return {
            ...current,
            contextTrace: [...(current.contextTrace ?? []), input.path],
            options: {
              ...current.options,
              querySource: 'changed-' + input.path,
            },
          }
        },
      }))
      const outer = make('Outer', async (input, current) => {
        observed.push({
          path: input.path,
          trace: [...(current.contextTrace ?? [])],
          source: current.options.querySource,
        })
        return { data: { complete: input.path } }
      })
      const context = fixtureContext([inner, outer], {
        setInProgressToolUseIDs() {},
      })
      context.options.mainLoopModel = 'claude-sonnet-4-6'
      const controller = context.abortController
      const calls = ['first', 'second'].map(path => ({
        type: 'tool_use',
        id: 'context-' + path,
        name: 'Outer',
        input: { path },
      }))
      const assistant = r.createAssistantMessage({ content: calls })
      const permission = async (_tool, input) => ({
        behavior: 'allow',
        updatedInput: input,
      })
      let updated = context
      if (streaming) {
        const executor = new r.StreamingToolExecutor(
          [inner, outer],
          permission,
          context,
        )
        for (const call of calls) executor.addTool(call, assistant)
        for await (const _ of executor.getRemainingResults()) {
        }
        updated = executor.getUpdatedContext()
      } else
        for await (const update of r.runTools(
          calls,
          [assistant],
          permission,
          context,
        ))
          updated = update.newContext
      assert.deepEqual(
        applied,
        ['first', 'second'],
        'Each actual callback must execute once',
      )
      assert.deepEqual(observed, [
        { path: 'first', trace: ['first'], source: 'changed-first' },
        {
          path: 'second',
          trace: ['first', 'second'],
          source: 'changed-second',
        },
      ])
      assert.deepEqual(updated.contextTrace, ['first', 'second'])
      assert.equal(updated.options.querySource, 'changed-second')
      assert.equal(
        updated.abortController,
        controller,
        'A nested temporary controller must not escape',
      )
    })
  }
