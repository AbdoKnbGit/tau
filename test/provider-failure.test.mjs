// A provider refusing a request has to look the same to a script on every route: a failed exit code,
// no wait for a limit that will not lift, and nothing left in the history for later requests. These run
// the print-mode lab's refusal scenarios, which drive the built CLI against a fake model.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

const lab = resolve('labs/print-mode/lab.mjs')

function runLab(provider) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [lab, '--provider', provider, '--only', 'failure', '--jobs', '3'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', part => { output += part })
    child.stderr.on('data', part => { output += part })
    child.once('error', reject)
    child.once('close', code => done({ code, output }))
  })
}

// One route for each way a provider reports a refusal: Anthropic's own client, its own native loop, the
// shared compat loop, a stream translator, the Anthropic client on a third party, and a request format
// the fake model cannot answer.
for (const provider of ['anthropic', 'agy', 'openai', 'copilot', 'opencode', 'xai', 'agentrouter', 'kiro']) {
  test(`a refused request fails cleanly on ${provider}`, { timeout: 300_000 }, async () => {
    const { code, output } = await runLab(provider)
    assert.equal(code, 0, output.slice(-2000))
    assert.doesNotMatch(output, /\bFAIL\b/, output.slice(-2000))
  })
}
