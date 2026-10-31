// Stands in for Google during a real CLI run, so print mode on Antigravity can be tested without an
// account. It refuses the one system prompt identity Google answers with a bare 429, and records the
// identity line of every system prompt it receives. Load with: node --import
import { appendFileSync } from 'node:fs'

const refusedIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})
const real = globalThis.fetch

globalThis.fetch = async function fetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)))
  if (!url.hostname.endsWith('googleapis.com')) return real(input, init)
  if (url.pathname.includes('loadCodeAssist')) {
    return json({ cloudaicompanionProject: 'fixture-project', currentTier: { id: 'free-tier' } })
  }
  if (!/:(stream)?generateContent/i.test(url.pathname)) return json({})

  const lines = JSON.parse(init.body).request.systemInstruction.parts.map(part => part.text).join('\n').split('\n')
  appendFileSync(process.env.TAU_TEST_FAKE_GOOGLE_RECORD, `${lines.find(line => line.startsWith('You are ')) ?? ''}\n`)
  if (process.env.TAU_TEST_FAKE_GOOGLE_BODIES) appendFileSync(process.env.TAU_TEST_FAKE_GOOGLE_BODIES, `${init.body}\n`)
  if (lines.includes(refusedIdentity)) {
    return json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, 429)
  }
  const response = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'ANSWERED' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  }
  return new Response(`data: ${JSON.stringify({ response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
