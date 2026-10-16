import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Run against the current build, or set TAU_MCP_TEST_BUNDLE to an isolated build.
// Real shells exercise the production normalizer, provider, exec and Bash tool.
const directory = mkdtempSync(join(tmpdir(), 'tau-bash-cwd-test-'))
process.env.NODE_ENV = 'test'
process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
process.env.CLAUDE_CODE_TMPDIR = join(directory, 'runtime')
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.DISABLE_TELEMETRY = '1'
delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
delete process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
delete process.env.CLAUDE_CODE_SHELL_PREFIX

const r = await loadMcpRuntime({
  paths: ['src/tools/BashTool/BashTool.tsx', 'src/utils/Shell.ts',
    'src/utils/shell/bashProvider.ts', 'src/lanes/codex/tools.ts',
    'src/lanes/gemini/tools.ts', 'src/lanes/openai-compat/tools.ts'],
  exports: ['BashTool', 'getShellConfig', 'findSuitableShell', 'createBashShellProvider',
    'setCwd', 'getCwd', 'setOriginalCwd', 'getOriginalCwd', 'hasPermissionsToUseTool',
    'checkRuleBasedPermissions', 'CODEX_TOOL_REGISTRY', 'GEMINI_TOOL_REGISTRY',
    'OPENAI_COMPAT_TOOL_REGISTRY'],
})
const previousCwd = r.getCwd()
const previousRoot = r.getOriginalCwd()
const shell = await r.findSuitableShell()
if (shell) {
  r.getShellConfig.cache.set(undefined, Promise.resolve({
    provider: await r.createBashShellProvider(shell, { skipSnapshot: true }),
  }))
}

const project = join(directory, 'project')
const source = join(project, 'src')
const destination = join(project, 'destination with spaces')
const outside = join(directory, 'outside')
for (const path of [source, destination, outside]) mkdirSync(path, { recursive: true })
writeFileSync(join(destination, 'marker.txt'), 'RESULT_READY')
const physical = path => (process.platform === 'win32'
  ? realpathSync.native(path) : realpathSync(path)).normalize('NFC')
const assertCwd = expected => assert.equal(physical(r.getCwd()), physical(expected))
const quotePath = path => "'" + path.replaceAll('\\', '/').replaceAll("'", "'\"'\"'") + "'"

function context(overrides = {}) {
  let state = {
    tasks: {}, mcp: { clients: [], tools: [r.BashTool] }, sessionHooks: new Map(),
    speculation: { status: 'idle' },
    toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
  }
  return fixtureContext([r.BashTool], {
    getAppState: () => state,
    setAppState: update => { state = update(state) },
    ...overrides,
  })
}

const call = (command, extra = {}, ctx = context()) => r.BashTool.call(
  { command, timeout: 5_000, dangerouslyDisableSandbox: true, ...extra }, ctx,
)
let callId = 0
async function pipelineCall(command, ctx = context(), extra = {}) {
  const block = { type: 'tool_use', id: `cwd-test-${++callId}`, name: 'Bash',
    input: { command, timeout: 5_000, dangerouslyDisableSandbox: true, ...extra } }
  const messages = []
  for await (const update of r.runToolUse(block,
    { type: 'assistant', uuid: `cwd-assistant-${callId}`,
      message: { id: `cwd-message-${callId}`, content: [block] } },
    r.hasPermissionsToUseTool, ctx)) {
    if (update.message?.type === 'user') messages.push(update.message)
  }
  const results = messages.flatMap(message => message.message.content)
    .filter(result => result.type === 'tool_result')
  assert.equal(results.length, 1, JSON.stringify(messages))
  return results[0]
}
const shellTest = (name, run) => test(name, { skip: !shell && 'No supported Bash/Zsh shell available' }, async t => {
  r.setCwd(project)
  r.setOriginalCwd(r.getCwd())
  delete process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
  await run(t)
})

test.after(async () => {
  await new Promise(resolve => setImmediate(resolve))
  r.setCwd(previousCwd)
  r.setOriginalCwd(previousRoot)
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('tau-bash-cwd-test-'))
  rmSync(directory, { recursive: true, force: true })
})

shellTest('a converted leading cd persists the final directory when returning to the root', async () => {
  await call('cd src && pwd && cd .. && pwd')
  assertCwd(project)
  const next = await call('test -d src && printf root-follow-up')
  assert.match(next.data.stdout, /root-follow-up/)
})

shellTest('a converted leading cd persists a later destination, including spaces', async () => {
  const result = await call(`cd src && pwd && cd ${quotePath(destination)} && pwd`)
  assertCwd(destination)
  assert.equal(result.data.cwdNote, `Shell cwd is now ${physical(destination)}`)
})

shellTest('a simple leading cd still persists its target', async () => {
  await call('cd src && pwd')
  assertCwd(source)
})

for (const mode of ['default', 'bypassPermissions']) {
  shellTest(`the full permission pipeline preserves an absolute cd (${mode})`, async () => {
    const ctx = context()
    ctx.getAppState().toolPermissionContext.mode = mode
    r.setCwd(source)
    const result = await pipelineCall(`cd ${quotePath(destination)} && pwd`, ctx)
    assert.ok(!result.is_error, JSON.stringify(result))
    assertCwd(destination)
    const followup = await pipelineCall('pwd && cat marker.txt', ctx)
    assert.ok(!followup.is_error, JSON.stringify(followup))
    assert.match(followup.content, /RESULT_READY/)
  })
}

for (const [provider, registry, nativeName] of [
  ['OpenAI/Codex', r.CODEX_TOOL_REGISTRY, 'shell'],
  ['Gemini', r.GEMINI_TOOL_REGISTRY, 'run_shell_command'],
  ['OpenAI-compatible', r.OPENAI_COMPAT_TOOL_REGISTRY, 'execute_command'],
]) {
  shellTest(`${provider} shell calls retain cwd through the shared pipeline`, async () => {
    const registration = registry.find(tool => tool.nativeName === nativeName)
    assert.equal(registration.implId, r.BashTool.name)
    const ctx = context()
    const execute = command => {
      const input = registration.adaptInput({ command })
      assert.equal(input.command, command)
      return pipelineCall(input.command, ctx, input)
    }
    let result = await execute(`cd ${quotePath(destination)} && pwd`)
    assert.ok(!result.is_error, JSON.stringify(result))
    assertCwd(destination)
    ctx.getAppState().toolPermissionContext.mode = 'bypassPermissions'
    result = await execute(`cd ${quotePath(source)} && printf checkpoint && cd "../destination with spaces" && (exit 7)`)
    assert.equal(result.is_error, true)
    assert.match(result.content, /Exit code 7/)
    assertCwd(destination)
    result = await execute('pwd && cat marker.txt')
    assert.ok(!result.is_error, JSON.stringify(result))
    assert.match(result.content, /RESULT_READY/)
  })
}

shellTest('the full pipeline persists the final cwd after a failing compound command', async () => {
  const ctx = context()
  ctx.getAppState().toolPermissionContext.mode = 'bypassPermissions'
  const result = await pipelineCall('cd src && printf checkpoint && cd "../destination with spaces" && (exit 7)', ctx)
  assert.equal(result.is_error, true)
  assert.match(result.content, /Exit code 7/)
  assertCwd(destination)
  const followup = await pipelineCall('pwd && cat marker.txt', ctx)
  assert.ok(!followup.is_error, JSON.stringify(followup))
  assert.match(followup.content, /RESULT_READY/)
})

shellTest('the full pipeline accepts a double-quoted shell absolute path', async () => {
  const shellPath = destination.replaceAll('\\', '/')
    .replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`)
  const result = await pipelineCall(`cd "${shellPath}" && pwd`)
  assert.ok(!result.is_error, JSON.stringify(result))
  assertCwd(destination)
})

shellTest('model-supplied cwd and simulated edit internals remain stripped', async () => {
  const marker = join(destination, 'marker.txt')
  const result = await pipelineCall('pwd', context(), {
    workdir: source, _workdirFromCd: true,
    _simulatedSedEdit: { filePath: marker, newContent: 'UNEXPECTED' },
  })
  assert.ok(!result.is_error, JSON.stringify(result))
  assertCwd(project)
  assert.equal(readFileSync(marker, 'utf8'), 'RESULT_READY')
})

shellTest('explicit deny rules still block cd-prefixed commands', async () => {
  const ctx = context()
  ctx.getAppState().toolPermissionContext.alwaysDenyRules = { session: ['Bash(pwd)'] }
  const result = await pipelineCall('cd src && pwd', ctx)
  assert.equal(result.is_error, true)
  assertCwd(project)
})

shellTest('the hook permission recheck retains the validated directory', async () => {
  const input = { command: 'cd src && pwd' }
  assert.equal((await r.BashTool.validateInput(input)).result, true)
  let checkedInput
  const observedTool = { ...r.BashTool, checkPermissions: async (input, ctx) => {
    checkedInput = input
    return r.BashTool.checkPermissions(input, ctx)
  } }
  assert.equal(await r.checkRuleBasedPermissions(observedTool, input, context()), null)
  assert.equal(physical(checkedInput.workdir), physical(source))
  assert.equal(checkedInput._workdirFromCd, true)
})

shellTest('the complete smoke workflow creates quoted paths and retains cwd after exit 7', async () => {
  const ctx = context()
  ctx.getAppState().toolPermissionContext.mode = 'bypassPermissions'
  let result = await pipelineCall('mkdir -p "workflow/child" "workflow/result folder" && printf RESULT_READY > "workflow/result folder/marker.txt"', ctx)
  assert.ok(!result.is_error, JSON.stringify(result))
  result = await pipelineCall('cd "workflow" && pwd', ctx)
  assert.ok(!result.is_error, JSON.stringify(result))
  assertCwd(join(project, 'workflow'))
  result = await pipelineCall('cd child && printf checkpoint && cd "../result folder" && (exit 7)', ctx)
  assert.equal(result.is_error, true)
  assert.match(result.content, /Exit code 7/)
  assertCwd(join(project, 'workflow', 'result folder'))
  result = await pipelineCall('pwd && cat marker.txt', ctx)
  assert.ok(!result.is_error, JSON.stringify(result))
  assert.match(result.content, /RESULT_READY/)
})

shellTest('a bare cd still persists its target through ordinary shell tracking', async () => {
  // Keep this compatibility check outside OS temp aliases: their conversion
  // in ordinary (non-normalized) shell tracking is an existing separate issue.
  const bareRoot = mkdtempSync(join(process.cwd(), '.tau-bare-cwd-test-'))
  try {
    mkdirSync(join(bareRoot, 'src'))
    r.setCwd(bareRoot)
    r.setOriginalCwd(r.getCwd())
    await call('cd src')
    assertCwd(join(bareRoot, 'src'))
  } finally {
    r.setCwd(project)
    r.setOriginalCwd(r.getCwd())
    assert.equal(dirname(realpathSync(bareRoot)), realpathSync(process.cwd()))
    assert.ok(basename(bareRoot).startsWith('.tau-bare-cwd-test-'))
    rmSync(bareRoot, { recursive: true, force: true })
  }
})

shellTest('a failing command preserves its exit status and the last reached directory', async () => {
  await assert.rejects(call(`cd src && pwd && cd ${quotePath(destination)} && (exit 7)`),
    error => error.name === 'ShellError' && error.code === 7)
  assertCwd(destination)
})

shellTest('failure immediately after a leading cd still preserves that directory', async () => {
  await assert.rejects(call('cd src && false'),
    error => error.name === 'ShellError' && error.code === 1)
  assertCwd(source)
})

shellTest('legacy explicit workdir remains local to the invocation', async () => {
  await call(`pwd && cd ${quotePath(destination)} && pwd`, { workdir: source })
  assertCwd(project)
})

for (const [name, overrides] of [
  ['hidden user command', { hiddenShellCommand: true }],
  ['subagent command', { agentId: 'cwd-test-agent' }],
]) {
  shellTest(`${name} cannot change the parent session directory`, async () => {
    await call(`cd src && pwd && cd ${quotePath(destination)} && pwd`, {}, context(overrides))
    assertCwd(project)
  })
}

shellTest('maintaining the project working directory still resets a converted cd', async () => {
  process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1'
  try {
    await call(`cd src && pwd && cd ${quotePath(destination)} && pwd`)
    assertCwd(project)
  } finally {
    delete process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
  }
})

shellTest('background commands leave the session cwd unchanged before and after completion', async () => {
  const ctx = context()
  const result = await call(`cd src && pwd && cd ${quotePath(destination)} && sleep 0.5 && pwd`,
    { run_in_background: true }, ctx)
  const task = ctx.getAppState().tasks[result.data.backgroundTaskId]
  assert.ok(task?.shellCommand, 'the real command was registered in the background')
  const cwdWhileRunning = r.getCwd()
  try {
    const completion = await task.shellCommand.result
    assert.equal(completion.code, 0)
    assert.equal(physical(cwdWhileRunning), physical(project))
    assertCwd(project)
  } finally {
    task.unregisterCleanup?.()
    await task.shellCommand.taskOutput.flush()
    task.shellCommand.cleanup()
    // Let the registry's completion handler finish its asynchronous cleanup.
    await new Promise(resolve => setImmediate(resolve))
  }
})

shellTest('a missing leading cd target does not change the session directory', async () => {
  await assert.rejects(call(`cd ${quotePath(join(project, 'missing-cwd-target'))} && printf never`),
    /does not exist/)
  assertCwd(project)
})

shellTest('a final cwd outside approved roots cannot move the session out of the project', async () => {
  await call(`cd src && pwd && cd ${quotePath(outside)} && pwd`)
  assertCwd(project)
})

shellTest('an additional approved root can be the final directory', async () => {
  const ctx = context()
  ctx.getAppState().toolPermissionContext.additionalWorkingDirectories.set(outside, {})
  await call(`cd src && pwd && cd ${quotePath(outside)} && pwd`, {}, ctx)
  assertCwd(outside)
})

if (process.platform === 'win32') {
  for (const additionalRoot of [false, true]) {
    shellTest(`Windows short directory aliases retain cwd (${additionalRoot ? 'additional root' : 'project root'})`, async t => {
      const root = additionalRoot ? outside : project
      const target = additionalRoot ? outside : destination
      const shortPath = execFileSync(shell, ['-c', 'cygpath -d -- "$1"', 'cwd-test', physical(root)],
        { encoding: 'utf8', windowsHide: true }).trim()
      if (shortPath.toLowerCase() === physical(root).toLowerCase()) {
        t.skip('Filesystem does not provide a distinct short directory alias')
        return
      }
      const ctx = context()
      if (additionalRoot) {
        ctx.getAppState().toolPermissionContext.additionalWorkingDirectories.set(shortPath, {})
      } else {
        r.setCwd(shortPath)
        r.setOriginalCwd(shortPath)
      }
      await call(`cd ${quotePath(source)} && pwd && cd ${quotePath(physical(target))} && pwd`, {}, ctx)
      assertCwd(target)
      const followup = await call('pwd', {}, ctx)
      assert.match(followup.data.stdout, new RegExp(basename(target)))
    })
  }
}

shellTest('a directory link cannot persist cwd outside approved roots', async () => {
  const link = join(project, 'outside-link')
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await call(`cd src && pwd && cd ${quotePath(link)} && pwd`)
  assertCwd(project)
})
