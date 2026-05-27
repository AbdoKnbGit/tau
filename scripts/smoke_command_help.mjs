// Smoke test — invokes the real fetcher against locally-installed
// binaries to confirm end-to-end behavior (timeout, summarization,
// idempotent appending). Not part of the regular test suite.

import {
  fetchCommandHelp,
  isUsageFailure,
  maybeAppendCommandHelp,
  resetCommandHelpCache,
} from '../src/tools/BashTool/commandHelp.ts'

resetCommandHelpCache()

const FAKE_FAILURE = [
  'unknown flag: --foo',
  '',
  'Bash failure analysis:',
  '- Exit code: 1',
  '- Reason: The command-line interface rejected the arguments.',
].join('\n')

const cases = [
  { cmd: 'git push --foo', label: 'git push' },
  { cmd: 'node --foo', label: 'node' },
  { cmd: 'npm install --foo', label: 'npm install' },
]

for (const { cmd, label } of cases) {
  const t0 = Date.now()
  const result = await maybeAppendCommandHelp(cmd, FAKE_FAILURE)
  const elapsed = Date.now() - t0
  const appended = result !== FAKE_FAILURE
  console.log(`[${label}] elapsed=${elapsed}ms appended=${appended}`)
  if (appended) {
    const helpStart = result.indexOf('Verified syntax')
    console.log(`---`)
    console.log(result.slice(helpStart, helpStart + 400))
    console.log(`---`)
  }
}

console.log('\nisUsageFailure smoke:')
console.log(' usage: docker ...       =>', isUsageFailure('Usage: docker run [OPTIONS]'))
console.log(' permission denied       =>', isUsageFailure('Permission denied'))
console.log(' unknown flag: --foo     =>', isUsageFailure('unknown flag: --foo'))
