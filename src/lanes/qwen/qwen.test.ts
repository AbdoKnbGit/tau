/**
 * Qwen lane unit tests — invariants + system-slot cache discipline.
 *
 * Run:  bun run src/lanes/qwen/qwen.test.ts
 */

import { qwenLane } from './loop.js'
import { QWEN_TOOL_REGISTRY, buildQwenTools, getQwenRegistrationByNativeName } from './tools.js'
import { assembleQwenSystemPrompt } from './prompt.js'
import {
  generatePKCE,
  QWEN_OAUTH_CLIENT_ID,
  QWEN_OAUTH_DEVICE_CODE_ENDPOINT,
  QWEN_OAUTH_TOKEN_ENDPOINT,
} from './oauth.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function main(): void {
  console.log('qwen lane:')

  // ── model support ───────────────────────────────────────────────
  test('supportsModel qwen3-coder-plus', () => {
    assert(qwenLane.supportsModel('qwen3-coder-plus'), 'expected support')
  })
  test('supportsModel qwen-max', () => {
    assert(qwenLane.supportsModel('qwen-max'), 'expected support')
  })
  test('supportsModel coder-model (alias)', () => {
    assert(qwenLane.supportsModel('coder-model'), 'expected support')
  })
  test('does NOT support claude-*', () => {
    assert(!qwenLane.supportsModel('claude-sonnet-4-6'), 'Claude must go to Claude lane')
  })
  test('does NOT support gpt-*', () => {
    assert(!qwenLane.supportsModel('gpt-5-codex'), 'GPT must go to Codex lane')
  })

  // ── tool registry ───────────────────────────────────────────────
  test('tool registry has read_file', () => {
    assert(getQwenRegistrationByNativeName('read_file'), 'read_file missing')
  })
  test('tool registry has run_shell_command', () => {
    assert(getQwenRegistrationByNativeName('run_shell_command'), 'run_shell_command missing')
  })
  test('run_shell_command advertises Bash syntax for the Bash implementation', () => {
    const reg = getQwenRegistrationByNativeName('run_shell_command')!
    assert(reg.implId === 'Bash', 'run_shell_command must be backed by Bash')
    assert(/Bash\/POSIX/i.test(reg.nativeDescription), 'description must tell Qwen to use Bash syntax')
    assert(reg.nativeDescription.includes('is_background=true'), 'description must steer to tracked background execution')
    assert(reg.nativeDescription.includes('echo $!'), 'description must warn against pid capture')
    assert(reg.nativeDescription.includes('docker compose up -d'), 'description must warn against Docker detach')
    assert(!/powershell/i.test(reg.nativeDescription), 'description must not advertise PowerShell')
    const command = reg.nativeSchema.properties?.command
    assert(typeof command === 'object' && command !== null && !Array.isArray(command), 'command schema missing')
    assert(String((command as { description?: unknown }).description ?? '').includes('echo $!'),
      'command field must warn against pid capture')
  })
  test('buildQwenTools shape is OpenAI function-calling', () => {
    const tools = buildQwenTools()
    assert(tools.length > 0, 'no tools built')
    const t = tools[0]!
    assert(t.type === 'function', 'expected type=function')
    assert(typeof t.function.name === 'string', 'function.name not string')
    assert(typeof t.function.description === 'string', 'function.description not string')
    assert(typeof t.function.parameters === 'object', 'function.parameters not object')
  })
  test('read_file adaptInput converts 1-based → 0-based offset', () => {
    const reg = getQwenRegistrationByNativeName('read_file')!
    const adapted = reg.adaptInput({ file_path: '/a', offset: 5 })
    assert((adapted as any).offset === 4, `expected offset=4, got ${(adapted as any).offset}`)
  })

  // ── smallFastModel ──────────────────────────────────────────────
  test('smallFastModel returns qwen-turbo', () => {
    assert(qwenLane.smallFastModel?.() === 'qwen-turbo', 'expected qwen-turbo')
  })

  // ── system prompt split ─────────────────────────────────────────
  test('assembleQwenSystemPrompt returns stable/volatile split', () => {
    const p = assembleQwenSystemPrompt('qwen3-coder-plus', {
      memory: 'mem',
      environment: 'env',
      gitStatus: 'branch:main',
      toolsAddendum: '',
      mcpIntro: '',
      skillsContext: '',
      customInstructions: 'custom',
    })
    assert(String(p.stable).length > 0, 'stable is empty')
    assert(String(p.volatile).includes('env'), 'volatile should include environment')
    assert(String(p.volatile).includes('mem'), 'volatile should include memory')
    assert(!String(p.stable).includes('branch:main'), 'stable should NOT leak git status')
    assert(!String(p.stable).includes('env'), 'stable should NOT leak environment')
    assert(String(p.stable).includes('custom'), 'stable should include customInstructions')
  })

  test('stable slot byte-identical across turns when only volatile changes', () => {
    const base = {
      toolsAddendum: '', mcpIntro: '', skillsContext: '', customInstructions: 'c',
    }
    const t1 = assembleQwenSystemPrompt('qwen-max', {
      ...base, memory: 'a', environment: 'e1', gitStatus: 'g1',
    })
    const t2 = assembleQwenSystemPrompt('qwen-max', {
      ...base, memory: 'b', environment: 'e2', gitStatus: 'g2',
    })
    assert(String(t1.stable) === String(t2.stable), 'stable slot drifted — cache will miss')
  })

  // ── OAuth endpoints ─────────────────────────────────────────────
  test('OAuth client id matches qwen-code reference', () => {
    assert(QWEN_OAUTH_CLIENT_ID === 'f0304373b74a44d2b584a3fb70ca9e56',
      `client id drifted: ${QWEN_OAUTH_CLIENT_ID}`)
  })
  test('device code endpoint is chat.qwen.ai', () => {
    assert(QWEN_OAUTH_DEVICE_CODE_ENDPOINT.startsWith('https://chat.qwen.ai'), 'wrong endpoint')
  })
  test('token endpoint is chat.qwen.ai', () => {
    assert(QWEN_OAUTH_TOKEN_ENDPOINT.startsWith('https://chat.qwen.ai'), 'wrong endpoint')
  })

  // ── PKCE ───────────────────────────────────────────────────────
  test('generatePKCE produces verifier + challenge pair', () => {
    const p = generatePKCE()
    assert(p.verifier.length >= 43 && p.verifier.length <= 128, 'verifier length out of range')
    assert(p.challenge.length > 0, 'challenge empty')
    assert(/^[A-Za-z0-9_-]+$/.test(p.verifier), 'verifier contains invalid chars')
    assert(/^[A-Za-z0-9_-]+$/.test(p.challenge), 'challenge contains invalid chars')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
