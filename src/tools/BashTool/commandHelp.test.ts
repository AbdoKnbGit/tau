/**
 * Command help unit tests.
 *
 * Run: bun run src/tools/BashTool/commandHelp.test.ts
 */

import {
  _primeCacheForTest,
  extractCommandKey,
  isUsageFailure,
  maybeAppendCommandHelp,
  resetCommandHelpCache,
  summarizeHelp,
} from './commandHelp.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ok  ${name}`)
    })
    .catch((e: any) => {
      failed++
      console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
    })
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

async function main(): Promise<void> {
  console.log('commandHelp:')

  await test('extracts base command from simple invocation', () => {
    assert(extractCommandKey('tsc --noEmit') === 'tsc', 'expected tsc')
    assert(extractCommandKey('jest --watch') === 'jest', 'expected jest')
  })

  await test('extracts cmd + subcmd for known subcommand tools', () => {
    assert(extractCommandKey('docker run -p 80 img') === 'docker run', 'docker run')
    assert(extractCommandKey('kubectl get pods -n ns') === 'kubectl get', 'kubectl get')
    assert(extractCommandKey('git push origin main') === 'git push', 'git push')
    assert(extractCommandKey('npm install foo') === 'npm install', 'npm install')
  })

  await test('skips dash-prefixed flag tokens when finding the subcommand', () => {
    // Models conventionally put global flags AFTER the subcommand
    // (`kubectl get pods -n ns`), but cover the simple flag-skip case.
    assert(
      extractCommandKey('npm --silent install foo') === 'npm install',
      'expected npm install even after --silent',
    )
  })

  await test('strips env-var prefixes before the command', () => {
    assert(
      extractCommandKey('PYTHONIOENCODING=utf-8 FOO=bar python script.py') === 'python',
      'expected python',
    )
  })

  await test('strips path prefix and .exe suffix', () => {
    assert(extractCommandKey('/usr/bin/docker run img') === 'docker run', 'unix path')
    // Unquoted Windows paths with spaces are unparseable by the shell
    // itself, so only the no-spaces path case is meaningful here.
    assert(
      extractCommandKey('C:/bin/git.exe status') === 'git status',
      'windows path no-spaces',
    )
    assert(extractCommandKey('./node_modules/.bin/tsc --noEmit') === 'tsc', 'relative path')
  })

  await test('returns null for blocklisted / shell-builtin commands', () => {
    assert(extractCommandKey('rm -rf /tmp/x') === null, 'rm blocklisted')
    assert(extractCommandKey('cd /tmp') === null, 'cd blocklisted')
    assert(extractCommandKey('') === null, 'empty')
    assert(extractCommandKey('   ') === null, 'whitespace')
  })

  await test('only looks at first clause of chained commands', () => {
    assert(
      extractCommandKey('cd frontend && npm run build') === null,
      'cd is blocklisted; chain ignored',
    )
    assert(extractCommandKey('docker ps; docker rm x') === 'docker ps', 'first clause only')
  })

  await test('detects usage-failure patterns', () => {
    assert(isUsageFailure('Usage: docker run [OPTIONS] IMAGE'), 'usage:')
    assert(isUsageFailure("unknown flag: --foo"), 'unknown flag')
    assert(isUsageFailure('invalid option -- z'), 'invalid option')
    assert(isUsageFailure('Error: unknown command "frobnicate"'), 'error: unknown')
    assert(isUsageFailure("See 'docker run --help'."), 'see --help')
    assert(isUsageFailure("Try 'kubectl --help' for more information"), 'try --help')
    assert(isUsageFailure('option --output requires an argument'), 'requires an argument')
  })

  await test('does NOT match non-usage failures', () => {
    assert(!isUsageFailure('Permission denied'), 'permission')
    assert(!isUsageFailure('No such file or directory'), 'enoent')
    assert(!isUsageFailure('connection refused'), 'network')
    assert(!isUsageFailure(''), 'empty')
  })

  await test('summarizeHelp preserves usage line + flag section', () => {
    const help = [
      'docker run — run a command in a new container',
      '',
      'Usage: docker run [OPTIONS] IMAGE [COMMAND] [ARG...]',
      '',
      'Some long description that should be trimmed when too verbose.',
      'Another line of prose.',
      '',
      'Options:',
      '  -d, --detach              Run in background',
      '  -p, --publish list        Publish a container port to the host',
      '  -e, --env list            Set environment variables',
      '  -v, --volume list         Bind mount a volume',
    ].join('\n')

    const summary = summarizeHelp(help)
    assert(summary.includes('Usage: docker run'), 'usage line preserved')
    assert(summary.includes('Options:'), 'options section header')
    assert(summary.includes('-p, --publish'), '-p flag preserved')
    assert(summary.includes('-v, --volume'), '-v flag preserved')
  })

  await test('summarizeHelp caps total lines', () => {
    const lines: string[] = ['Usage: thing']
    for (let i = 0; i < 200; i++) lines.push(`  --flag${i}            description`)
    const summary = summarizeHelp(lines.join('\n'))
    const lineCount = summary.split('\n').length
    assert(lineCount <= 40, `expected <= 40 lines, got ${lineCount}`)
  })

  await test('summarizeHelp strips ANSI color codes', () => {
    const help = '\x1b[1mUsage:\x1b[0m \x1b[32mfoo\x1b[0m [OPTIONS]'
    const summary = summarizeHelp(help)
    assert(!summary.includes('\x1b'), 'no ANSI escapes')
    assert(summary.includes('Usage:'), 'content preserved')
  })

  await test('maybeAppendCommandHelp returns input unchanged on non-usage failure', async () => {
    resetCommandHelpCache()
    const output = 'cat: missing.txt: No such file or directory\n\nBash failure analysis:\n- Exit code: 1\n- Reason: not found'
    const result = await maybeAppendCommandHelp('cat missing.txt', output)
    assert(result === output, 'should not modify non-usage failures')
  })

  await test('maybeAppendCommandHelp appends verified syntax on usage failure (cached)', async () => {
    resetCommandHelpCache()
    // Prime the cache to avoid spawning a real process in tests
    _primeCacheForTest('docker run', {
      content: 'Usage: docker run [OPTIONS] IMAGE\n\nOptions:\n  -p, --publish list   Publish a port',
      source: 'help',
    })

    const failureOutput = [
      "unknown flag: --foo",
      '',
      'Bash failure analysis:',
      '- Exit code: 1',
      '- Reason: The command-line interface rejected the arguments.',
    ].join('\n')

    const result = await maybeAppendCommandHelp('docker run --foo image', failureOutput)
    assert(result.includes('Verified syntax'), 'verified syntax block appended')
    assert(result.includes('docker run --help'), 'attribution to docker run --help')
    assert(result.includes('-p, --publish'), 'flag content included')
  })

  await test('maybeAppendCommandHelp is idempotent', async () => {
    resetCommandHelpCache()
    _primeCacheForTest('git push', {
      content: 'Usage: git push [<options>] [<repository> [<refspec>...]]',
      source: 'help',
    })
    const base = "Error: unknown switch `--invalid'\n\nBash failure analysis:\n- Exit code: 1"
    const once = await maybeAppendCommandHelp('git push --invalid origin main', base)
    const twice = await maybeAppendCommandHelp('git push --invalid origin main', once)
    assert(once === twice, 'should not append twice')
  })

  await test('maybeAppendCommandHelp returns unchanged for blocklisted commands', async () => {
    resetCommandHelpCache()
    const output = "rm: invalid option -- 'z'\nUsage: rm [OPTION]..."
    const result = await maybeAppendCommandHelp('rm -z /tmp/x', output)
    assert(result === output, 'rm is blocklisted, should not fetch')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
