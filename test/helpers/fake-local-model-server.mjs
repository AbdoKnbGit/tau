// A stand-in for a local model server, so tests run without any model or
// server installed. It speaks both protocols Tau uses for local models:
//   - Ollama's native /api/chat (NDJSON), with Ollama's own timing fields on
//     the last chunk;
//   - the OpenAI-compatible /v1/chat/completions stream (SSE) that LM Studio
//     and cloud providers use.
// Each scripted reply has known timing, which gives the exact answer Tau's
// speed figures should match. Every request is kept, so a test can also check
// what Tau sent.
//
// Only chat requests whose last user message contains `marker` get a scripted
// reply, in order. Anything else on the same model (titles, other background
// work) gets a short instant reply and leaves the script alone.
import { createServer } from 'node:http'

// Every streamed piece is four characters, so Tau's estimate of four
// characters per token is exact when the server sends no token counts.
const TEXT_PIECE = 'tok '
const THINKING_PIECE = 'thnk'
const NANOSECONDS_PER_MS = 1_000_000

const sleepUntil = target => new Promise(done => setTimeout(done, Math.max(0, target - performance.now())))

/**
 * A scripted reply:
 *   waitMs           delay before the first streamed piece (prompt processing, model loading)
 *   tokensPerSecond  streaming rate for every piece after the first
 *   thinkingTokens   pieces streamed first as thinking. On /api/chat they go
 *                    in message.thinking; on SSE under `thinkingField`
 *                    ('reasoning', 'reasoning_content' or 'thinking')
 *   textTokens       answer pieces after the thinking
 *   sendUsage        whether the server reports a token count (SSE usage, or
 *                    Ollama's eval_count)
 *   ollamaTimings    /api/chat only: Ollama's own figures for the last chunk,
 *                    { evalMs, promptMs, loadMs }, reported as given
 */
export async function startFakeLocalModelServer({ model, marker, replies }) {
  const requests = []
  let nextReply = 0

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let raw = ''
    for await (const part of request) raw += part
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    requests.push({ method: request.method, path: url.pathname, body })

    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return sendJson(response, { object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'fake-local' }] })
    }
    if (request.method === 'GET' && url.pathname === '/api/tags') {
      return sendJson(response, { models: [{ name: model, model, modified_at: '2026-01-01T00:00:00Z', size: 1, digest: 'fake', details: {} }] })
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/models') {
      return sendJson(response, { models: [] })
    }
    const isOllamaChat = request.method === 'POST' && url.pathname === '/api/chat'
    const isOpenAIChat = request.method === 'POST' && url.pathname.endsWith('/chat/completions')
    if (isOllamaChat || isOpenAIChat) {
      const scripted = lastUserText(body).includes(marker) && nextReply < replies.length
      const reply = scripted ? replies[nextReply++] : { waitMs: 0, tokensPerSecond: 1000, textTokens: 2, sendUsage: true }
      return isOllamaChat ? streamOllama(response, reply, model) : streamOpenAI(response, reply, model)
    }
    sendJson(response, { error: { message: `fake local server: no route for ${request.method} ${url.pathname}` } }, 404)
  })
  server.on('connection', socket => socket.setNoDelay(true))

  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()

  return {
    // Tau appends the API path itself: /api/chat for Ollama, /chat/completions otherwise.
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    chatRequests: () => requests.filter(entry => entry.method === 'POST' && (entry.path === '/api/chat' || entry.path.endsWith('/chat/completions'))),
    scriptedRepliesUsed: () => nextReply,
    close: () => new Promise(done => {
      server.closeAllConnections?.()
      server.close(() => done())
    }),
  }
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return JSON.stringify(messages[index].content ?? '')
  }
  return ''
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(data))
}

function scriptOf(reply) {
  const { waitMs = 0, tokensPerSecond = 40, thinkingTokens = 0, textTokens = 0 } = reply
  return { waitMs, interval: 1000 / tokensPerSecond, thinkingTokens, textTokens }
}

// Scheduled against the clock rather than chained timers, so the total
// streaming time stays exact however late a single timer fires.
async function playPieces(reply, write) {
  const { waitMs, interval, thinkingTokens, textTokens } = scriptOf(reply)
  const pieces = [
    ...Array.from({ length: thinkingTokens }, () => 'thinking'),
    ...Array.from({ length: textTokens }, () => 'text'),
  ]
  const firstAt = performance.now() + waitMs
  for (let index = 0; index < pieces.length; index++) {
    await sleepUntil(firstAt + index * interval)
    write(pieces[index], index)
  }
  return pieces.length
}

async function streamOllama(response, reply, model) {
  response.writeHead(200, { 'content-type': 'application/x-ndjson' })
  const line = data => response.write(`${JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', ...data })}\n`)
  const count = await playPieces(reply, kind => line({
    message: kind === 'thinking'
      ? { role: 'assistant', content: '', thinking: THINKING_PIECE }
      : { role: 'assistant', content: TEXT_PIECE },
    done: false,
  }))
  const timings = reply.ollamaTimings
  response.end(`${JSON.stringify({
    model,
    created_at: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    ...(reply.sendUsage !== false && { prompt_eval_count: 100, eval_count: count }),
    ...(timings && {
      total_duration: (timings.loadMs + timings.promptMs + timings.evalMs) * NANOSECONDS_PER_MS,
      load_duration: timings.loadMs * NANOSECONDS_PER_MS,
      prompt_eval_duration: timings.promptMs * NANOSECONDS_PER_MS,
      eval_duration: timings.evalMs * NANOSECONDS_PER_MS,
    }),
  })}\n`)
}

async function streamOpenAI(response, reply, model) {
  const { thinkingField = 'reasoning', sendUsage = true } = reply
  const id = `chatcmpl-fake-${Math.random().toString(36).slice(2)}`
  const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: 0, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const count = await playPieces(reply, (kind, index) => {
    const delta = kind === 'thinking' ? { [thinkingField]: THINKING_PIECE } : { content: TEXT_PIECE }
    response.write(chunk(index === 0 ? { role: 'assistant', ...delta } : delta))
  })
  response.write(chunk({}, 'stop'))
  if (sendUsage) {
    response.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created: 0, model, choices: [],
      usage: { prompt_tokens: 100, completion_tokens: count, total_tokens: 100 + count },
    })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}
