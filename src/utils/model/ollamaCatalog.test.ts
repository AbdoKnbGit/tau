/**
 * The Ollama model picker sorts models on this machine by what Ollama says
 * they can do, not by their names. `:cloud` aliases keep their old rules.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'tau-ollama-catalog-'))
const saved = { config: process.env.CLAUDE_CONFIG_DIR, host: process.env.OLLAMA_HOST, base: process.env.OLLAMA_BASE_URL }
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.OLLAMA_HOST = 'http://127.0.0.1:11999'
delete process.env.OLLAMA_BASE_URL

const { getOllamaCatalog, resetOllamaCatalogForTests } = await import('./ollamaCatalog.js')

afterAll(() => {
  for (const [key, value] of [['CLAUDE_CONFIG_DIR', saved.config], ['OLLAMA_HOST', saved.host], ['OLLAMA_BASE_URL', saved.base]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(configDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetOllamaCatalogForTests()
})

const TAGS = [
  { name: 'qwen3:4b', digest: 'd1' },
  { name: 'phi4-mini:latest', digest: 'd2' },
  { name: 'llama3.2-vision:11b', digest: 'd3' },
  { name: 'nomic-embed-text:latest', digest: 'd4' },
  { name: 'qwen2.5-old:7b', digest: 'd5' },
  { name: 'minimax-m2.7:cloud', digest: 'd6' },
  { name: 'qwen3-preview:cloud', digest: 'd7' },
]
// What /api/show lists per model; undefined is an older Ollama with no list.
const CAPABILITIES: Record<string, string[] | undefined> = {
  'qwen3:4b': ['completion', 'tools', 'thinking'],
  'phi4-mini:latest': ['completion', 'tools'],
  'llama3.2-vision:11b': ['completion', 'vision'],
  'nomic-embed-text:latest': ['embedding'],
  'qwen2.5-old:7b': undefined,
  'minimax-m2.7:cloud': ['completion', 'tools'],
  // A cloud alias whose name says tools; its capabilities are not used.
  'qwen3-preview:cloud': ['completion'],
}

async function catalogWith(): Promise<{ catalog: Awaited<ReturnType<typeof getOllamaCatalog>>; shown: string[] }> {
  const shown: string[] = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path === '/api/tags') return Response.json({ models: TAGS })
    if (path === '/api/show') {
      const model = JSON.parse(String(init?.body)).model as string
      shown.push(model)
      const capabilities = CAPABILITIES[model]
      return Response.json(capabilities ? { capabilities } : { model_info: {} })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  try {
    return { catalog: await getOllamaCatalog(), shown }
  } finally {
    globalThis.fetch = oldFetch
  }
}

const ids = (models: Array<{ id: string }>) => models.map(model => model.id)

describe('models on this machine', () => {
  test("are sorted by Ollama's own capabilities, not by name", async () => {
    const { catalog } = await catalogWith()
    // phi4-mini is not on the name list but has tools; llama3.2-vision is on
    // it (llama3.2) but has none.
    expect(ids(catalog.local)).toContain('phi4-mini:latest')
    expect(ids(catalog.toolless)).toContain('llama3.2-vision:11b')
    const qwen = catalog.local.find(model => model.id === 'qwen3:4b')
    expect(qwen).toMatchObject({ supportsTools: true, supportsThinking: true })
  })

  test('a model that cannot chat (an embedding model) is left out', async () => {
    const { catalog } = await catalogWith()
    const all = [...catalog.local, ...catalog.toolless, ...catalog.cloud]
    expect(ids(all)).not.toContain('nomic-embed-text:latest')
  })

  test('an older Ollama with no capabilities falls back to the name list', async () => {
    const { catalog } = await catalogWith()
    expect(catalog.local.find(model => model.id === 'qwen2.5-old:7b')).toMatchObject({ supportsTools: true, supportsThinking: false })
  })

  test('capabilities are read once per model version', async () => {
    const first = await catalogWith()
    const second = await catalogWith()
    const local = ['qwen3:4b', 'phi4-mini:latest', 'llama3.2-vision:11b', 'nomic-embed-text:latest']
    for (const model of local) expect(first.shown).toContain(model)
    for (const model of local) expect(second.shown).not.toContain(model)
  })
})

describe(':cloud aliases keep their old rules', () => {
  test('a curated cloud model stays in the cloud section; another alias is sorted by name', async () => {
    const { catalog } = await catalogWith()
    expect(catalog.cloud.find(model => model.id === 'minimax-m2.7:cloud')).toMatchObject({ pulled: true, supportsTools: true })
    expect(catalog.local.find(model => model.id === 'qwen3-preview:cloud')).toMatchObject({ supportsTools: true, supportsThinking: false })
  })
})
