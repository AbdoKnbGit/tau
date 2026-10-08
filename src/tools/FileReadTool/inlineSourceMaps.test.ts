import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { inlineSourceMapView } from './inlineSourceMaps.js'
import { readFileInRange } from '../../utils/readFileInRange.js'

const map = { version: 3, sources: ['original.ts'], names: [], mappings: 'AAAA', sourcesContent: ['const n = 1;'.repeat(3000)] }
const payload = Buffer.from(JSON.stringify(map)).toString('base64')
const directive = `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${payload}`

describe('inline source map views', () => {
  for (const ext of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'TS']) {
    test(`${ext}: omits only a real map and preserves surrounding lines`, async () => {
      const content = `const n = 1;\n${directive}\nconst m = 2;\n`
      const result = await inlineSourceMapView(content, content, ext, 0)
      expect(result.omitted).toBe(true)
      expect(result.content.split('\n')).toHaveLength(4)
      expect(result.content.split('\n')[0]).toBe('const n = 1;')
      expect(result.content.split('\n')[2]).toBe('const m = 2;')
      expect(result.content).toContain('include_source_maps=true')
      expect(result.content).not.toContain(payload)
      expect(result.content.length).toBeLessThan(200)
    })
  }

  for (const [name, comment, ext] of [
    ['legacy JS', directive.replace('//#', '//@'), 'js'],
    ['CSS', `/*# sourceMappingURL=data:application/json;base64,${payload} */`, 'css'],
    ['JS block', `/*# sourceMappingURL=data:application/json;base64,${payload}*/`, 'js'],
    ['URL-encoded map', `//# sourceMappingURL=data:application/json,${encodeURIComponent(JSON.stringify(map))}`, 'js'],
    ['indexed map', `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map }] })).toString('base64')}`, 'js'],
  ]) {
    test(name!, async () => {
      const result = await inlineSourceMapView(comment!, comment!, ext!, 0)
      expect(result.omitted).toBe(true)
    })
  }

  test('targeted read uses the complete lexical context, including Unicode', async () => {
    const source = `const emoji = '😀';\n${directive}\nconst tail = 1;`
    const result = await inlineSourceMapView(`${directive}\nconst tail = 1;`, source, 'js', 1)
    expect(result.omitted).toBe(true)
    expect(result.content.split('\n')[1]).toBe('const tail = 1;')
  })

  for (const [name, source, offset, selection, ext] of [
    ['template literal', `const text = \`\n${directive}\n\`;`, 1, directive, 'js'],
    ['string literal', `const text = ${JSON.stringify(directive)};`, 0, `const text = ${JSON.stringify(directive)};`, 'js'],
    ['documentation', `/* example\n${directive}\n*/`, 1, directive, 'js'],
    ['markdown', directive, 0, directive, 'md'],
    ['external map', '//# sourceMappingURL=app.js.map', 0, '//# sourceMappingURL=app.js.map', 'js'],
    ['ordinary long code', `const data = '${payload}';`, 0, `const data = '${payload}';`, 'js'],
    ['trailing source code', `const n = 1; ${directive}`, 0, `const n = 1; ${directive}`, 'js'],
    ['invalid JSON', '//# sourceMappingURL=data:application/json;base64,eHh4', 0, '//# sourceMappingURL=data:application/json;base64,eHh4', 'js'],
    ['non-map JSON', '//# sourceMappingURL=data:application/json;base64,e30=', 0, '//# sourceMappingURL=data:application/json;base64,e30=', 'js'],
    ['invalid syntax', `const = ;\n${directive}`, 1, directive, 'js'],
  ] as const) {
    test(`preserves ${name}`, async () => {
      expect(await inlineSourceMapView(selection, source, ext, offset)).toEqual({ content: selection, omitted: false })
    })
  }

  test('missing full context never guesses about comments', async () => {
    expect(await inlineSourceMapView(directive, undefined, 'js', 100)).toEqual({ content: directive, omitted: false })
  })

  test('the view is deterministic and leaves original strings intact', async () => {
    const first = await inlineSourceMapView(directive, directive, 'js', 0)
    expect(await inlineSourceMapView(directive, directive, 'js', 0)).toEqual(first)
    expect(directive).toContain(payload)
  })
})

describe('same-read source snapshots', () => {
  for (const newline of ['\n', '\r\n']) {
    test(`BOM and ${JSON.stringify(newline)} preserve exact range numbering and bytes on disk`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'tau-map-read-'))
      try {
        const file = join(root, 'arbitrary name.js')
        const original = `\uFEFFconst n = 1;${newline}${directive}${newline}const m = 2;${newline}`
        await writeFile(file, original)
        const result = await readFileInRange(file, 1, 2, undefined, undefined, { captureFullContent: true })
        expect(result.content).toBe(`${directive}\nconst m = 2;`)
        expect(result.lineCount).toBe(2)
        expect(result.totalLines).toBe(4)
        const view = await inlineSourceMapView(result.content, result.fullContent, 'js', 1)
        expect(view.omitted).toBe(true)
        expect(view.content.split('\n')[1]).toBe('const m = 2;')
        expect(await readFile(file, 'utf8')).toBe(original)
        expect((await readFileInRange(file, 1, 1)).fullContent).toBeUndefined()
      } finally {
        expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
        expect(root).toContain('tau-map-read-')
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test('large streamed files keep reads bounded and preserve uncertain source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-map-read-'))
    try {
      const file = join(root, 'large.js')
      const prefix = '// filler\n'.repeat(1_100_000)
      await writeFile(file, prefix + directive)
      const result = await readFileInRange(file, 1_100_000, 1, undefined, undefined, { captureFullContent: true })
      expect(result.content).toBe(directive)
      expect(result.fullContent).toBeUndefined()
      expect(result.totalLines).toBe(1_100_001)
    } finally {
      expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
      expect(root).toContain('tau-map-read-')
      await rm(root, { recursive: true, force: true })
    }
  })
})
