// Loaded into tau with `node --import`. Two modes (E2E_NET):
//   fake  answers every model request with the scripted model (script.mjs);
//         catalog/setup calls get minimal stubs; every other host is refused
//   live  sends every request to the real provider untouched
// Both append each model request body to E2E_LOG (one JSON line each). Live
// mode also records the usage the provider reported for it, read from the
// response as it streams past (a clone would come back empty on lanes that
// abort right after the last event). Headers are never logged.
import { appendFileSync } from 'node:fs'
import { alphaReply, chatReply, geminiReply, kiroReply, ollamaReply, responsesReply, view } from './formats.mjs'
import { anthropicReply } from './anthropic-reply.mjs'
import { script } from './script.mjs'

const realFetch = globalThis.fetch
const LOG = process.env.E2E_LOG
const NET = process.env.E2E_NET ?? 'fake'
const MODEL = process.env.E2E_MODEL ?? 'e2e-model'
const LOCAL = process.env.E2E_LOCAL ?? ''
let seq = 0
const log = entry => appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...entry }) + '\n')

function modelFormat(url, method) {
  if (method !== 'POST' || url.includes('count_tokens')) return null
  if (/\/v1\/messages(\?|$)/.test(url)) return 'anthropic'
  if (/\/chat\/completions(\?|$)/.test(url)) return 'chat'
  if (/\/api\/chat(\?|$)/.test(url)) return 'ollama'
  if (/\/responses(\?|$)/.test(url)) return 'responses'
  if (url.includes('/alpha/generate')) return 'alpha'
  if (url.includes('v1internal:streamGenerateContent')) return 'antigravity'
  if (url.includes(':streamGenerateContent') || url.includes(':generateContent')) return 'gemini'
  if (url.includes('generateAssistantResponse')) return 'kiro'
  return null
}

const USAGE_KEYS = [
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
  'prompt_tokens', 'completion_tokens', 'cached_tokens', 'cache_write_tokens',
  'promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount',
]
function lastUsage(text) {
  const out = {}
  for (const k of USAGE_KEYS) {
    const re = new RegExp(`"${k}"\\s*:\\s*(\\d+)`, 'g')
    let m
    let v
    while ((m = re.exec(text))) v = Number(m[1])
    if (v !== undefined) out[k] = v
  }
  return out
}

function tap(res, id) {
  if (!res.body) {
    log({ kind: 'end', id, status: res.status })
    return res
  }
  const decoder = new TextDecoder()
  let text = ''
  let last = ''
  const record = () => {
    const usage = lastUsage(text)
    const s = JSON.stringify(usage)
    if (s !== last && s !== '{}') {
      last = s
      log({ kind: 'usage', id, status: res.status, usage })
    }
  }
  const stream = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      const piece = decoder.decode(chunk, { stream: true })
      if (text.length < 8e6) text += piece
      if (/token|Token/.test(piece)) record()
    },
    flush() {
      record()
      log({ kind: 'end', id, status: res.status, ...(res.status >= 400 && { error: text.slice(0, 600) }) })
    },
    // Lanes that stop reading after the last event cancel instead of draining.
    cancel() {
      record()
      log({ kind: 'end', id, status: res.status, canceled: true })
    },
  })
  return new Response(res.body.pipeThrough(stream), { status: res.status, statusText: res.statusText, headers: res.headers })
}

function bodyText(input, init) {
  const b = init?.body
  if (typeof b === 'string') return b
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) return Buffer.from(b).toString('utf8')
  return ''
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
const MODELS = {
  object: 'list',
  data: [{ id: MODEL, object: 'model', owned_by: 'e2e', context_length: 200000, name: MODEL,
    pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], top_provider: { context_length: 200000 } }],
  models: [{ name: `models/${MODEL}`, id: MODEL, supportedGenerationMethods: ['generateContent'] }],
}

function fakeReply(format, body) {
  const { action } = script(format, body)
  switch (format) {
    case 'anthropic': return sse(anthropicReply(action, MODEL))
    case 'chat': return sse(chatReply(action, MODEL))
    case 'ollama': return new Response(ollamaReply(action, MODEL), { headers: { 'content-type': 'application/x-ndjson' } })
    case 'responses': return sse(responsesReply(action))
    case 'alpha': return sse(alphaReply(action))
    case 'antigravity': return sse(geminiReply(action, true))
    case 'gemini': return sse(geminiReply(action, false))
    case 'kiro': return new Response(kiroReply(action), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init.method ?? (typeof input === 'object' && input.method) ?? 'GET').toUpperCase()
  const format = modelFormat(url, method)
  let id
  if (format) {
    const raw = bodyText(input, init)
    let body = null
    try { body = JSON.parse(raw) } catch {}
    id = `${process.pid}-${++seq}`
    const main = body ? view(format === 'ollama' ? 'chat' : format, body).tools.length > 0 : false
    log({ kind: 'req', id, url: url.replace(/key=[^&]+/, 'key=<redacted>'), format, main, body })
  }

  if (NET === 'live') {
    const res = await realFetch(input, init)
    return format ? tap(res, id) : res
  }

  // ── fake network ──
  // The Anthropic and Responses lanes are pointed at the runner's local
  // server; it answers, this side logs (once, with this process's id).
  if (LOCAL && url.startsWith(LOCAL)) {
    const res = await realFetch(input, init)
    return format ? tap(res, id) : res
  }
  if (method === 'HEAD') return new Response(null, { status: 200 })
  if (format) {
    const res = fakeReply(format, JSON.parse(bodyText(input, init)))
    log({ kind: 'end', id, status: 200 })
    return res
  }
  if (url.includes('v1internal:loadCodeAssist')) {
    return json({ cloudaicompanionProject: 'c28-project', currentTier: { id: 'standard-tier', name: 'Standard' }, allowedTiers: [{ id: 'standard-tier', isDefault: true }] })
  }
  if (url.includes('v1internal:onboardUser')) return json({ done: true, response: { cloudaicompanionProject: { id: 'c28-project' } } })
  if (url.includes('v1internal:')) return json({})
  if (url.includes('oauth2.googleapis.com/token') || url.includes('/oauth/token') || url.includes('refreshToken') || url.includes('/token')) {
    return json({ access_token: 'c28-refreshed', expires_in: 3600, token_type: 'Bearer', accessToken: 'c28-refreshed', expiresAt: Date.now() + 3600e3 })
  }
  if (method === 'GET') return json(MODELS)
  log({ kind: 'blocked', url, method })
  return json({ error: { message: `no stub for ${method} ${url}` } }, 404)
}
