#!/usr/bin/env node
// Refresh src/utils/model/commandCodeRegistrySeed.json from Command Code's
// public client catalog, the one its own CLI reads. Run when Command Code adds
// models or changes prices:
//
//   node scripts/refresh-commandcode-models.mjs
//
// Keeps only the fields Tau reads (commandCodeRegistry.ts), one model per line.
import { writeFileSync } from 'node:fs'

const CATALOG_URL = 'https://api.commandcode.ai/provider/v1/models?view=client'
const OUT = new URL('../src/utils/model/commandCodeRegistrySeed.json', import.meta.url)

const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) })
if (!response.ok) throw new Error(`${CATALOG_URL} answered ${response.status}`)
const body = await response.json()
const rows = Array.isArray(body?.data) ? body.data : []
if (rows.length === 0) throw new Error(`${CATALOG_URL} listed no models`)

const data = rows
  .filter(row => typeof row?.id === 'string')
  .map(row => ({
    id: row.id,
    ...(row.name ? { name: row.name } : {}),
    ...(row.aliases?.length ? { aliases: row.aliases } : {}),
    context_length: row.context_length,
    inputModalities: row.inputModalities,
    ...(row.pricing ? { pricing: row.pricing } : {}),
    ...(row.display?.badge ? { display: { badge: row.display.badge } } : {}),
  }))

writeFileSync(OUT, [
  '{',
  `  "source": ${JSON.stringify(`${CATALOG_URL} on ${new Date().toISOString().slice(0, 10)}`)},`,
  `  "catalogVersion": ${JSON.stringify(body.catalogVersion ?? null)},`,
  '  "data": [',
  data.map(row => `    ${JSON.stringify(row)}`).join(',\n'),
  '  ]',
  '}',
  '',
].join('\n'))
console.log(`${data.length} models, ${data.filter(row => row.pricing).length} priced`)
