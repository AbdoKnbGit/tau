import { describe, expect, test } from 'bun:test'
import { stringWidth } from '../ink/stringWidth.js'
import {
  MAX_CHART_COLUMNS,
  MAX_CHART_POINTS,
  MAX_CHART_ROWS,
  MAX_GANTT_TASKS,
  renderMermaidChart,
} from './mermaidCharts.js'
import { fitMermaidArt, getMermaidArt, normalizeMermaidFences } from './mermaidDiagram.js'
import { getUndrawnMermaidReasons } from './mermaidDiagramFeedback.js'

const bar = 'xychart-beta\n title "Requests"\n x-axis "Month" [Jan, Feb, Mar]\n y-axis "Count" 0 --> 100\n bar [10, 50, 100]'
const line = 'xychart\n x-axis 0 --> 2\n y-axis -10 --> 10\n line [-10, 0, 10]'
const pie = 'pie showData title Work\n "Read" : 3\n "Edit" : 1\n "Skipped" : 0'
const gantt = 'gantt\n dateFormat YYYY-MM-DD\n title Release\n section Build\n Compile :done, build, 2026-03-28, 1d\n Test :crit, tests, after build, 12h\n Ship :milestone, after tests, 0d'

function drawn(source: string, columns = 80): string {
  const fit = fitMermaidArt(source, columns)
  expect(fit.art).not.toBeNull()
  return fit.art!.rows.map(row => row.map(span => span.text).join('')).join('\n')
}

function failure(source: string, columns = 120): string {
  const fit = fitMermaidArt(source, columns)
  expect(fit.art).toBeNull()
  return fit.art === null ? fit.fallback.kind : 'drawn'
}

describe('terminal Mermaid charts', () => {
  test('renders category bars with scale, labels and exact data', () => {
    const text = drawn(bar)
    for (const phrase of ['Requests', 'Y: Count', 'X: Month', '1=bar█', 'Jan', 'Feb', 'Mar', '1:100', '█']) expect(text).toContain(phrase)
    expect(getMermaidArt(bar)).not.toBeNull()
  })

  test('renders numeric lines with a negative scale and connects points', () => {
    const text = drawn(line)
    expect(text).toContain('1=line●')
    expect(text).toContain('1:-10')
    expect(text).toContain('1:10')
    expect(text).toContain('╱')
    expect(text.match(/●/g)!.length).toBe(4)
  })

  test('keeps mixed series identified without depending on color', () => {
    const text = drawn('xychart-beta\n x-axis [a, b]\n bar [2, 4]\n line [1, 3]')
    expect(text).toContain('1=bar█  2=line◆')
    expect(text).toContain('1:2  2:1')
    expect(text).toContain('1:4  2:3')
  })

  test('pie uses proportional shares, exact amounts and percentages including zero', () => {
    const text = drawn(pie)
    expect(text).toContain('Work')
    expect(text).toContain('Share of total 4')
    expect(text).toContain('3 (75.0%)')
    expect(text).toContain('1 (25.0%)')
    expect(text).toContain('0 (0.0%)')
    const read = text.split('\n').find(row => row.startsWith('Read'))!
    const edit = text.split('\n').find(row => row.startsWith('Edit'))!
    expect(Math.abs(read.match(/█/g)!.length - edit.match(/█/g)!.length * 3)).toBeLessThanOrEqual(2)
    const precise = drawn('pie\n "a" : 1.23456789\n "b" : 2')
    expect(precise).toContain('1.23456789')
  })

  test('gantt preserves UTC dates, dependencies, sections, tags and milestones', () => {
    const text = drawn(gantt)
    for (const phrase of ['Release', 'Build', '[done] Compile', '[crit] Test', 'Ship', '2026-03-28', '2026-03-29', '2026-03-29 12:00:00Z', '(UTC)', '◆']) expect(text).toContain(phrase)
    expect(drawn('gantt\n Leap :2024-02-28, 2d')).toContain('2024-03-01')
    expect(drawn('gantt\n First :a, 2026-01-01, 1h\n Second :after a, 1s')).toContain('2026-01-01 01:00:01Z')
  })

  test('width-sensitive art is isolated, reusable and bounded across resizing', () => {
    for (const source of [bar, line, pie, gantt]) {
      const narrow = fitMermaidArt(source, 64)
      const wide = fitMermaidArt(source, 120)
      expect(narrow.art).not.toBeNull()
      expect(wide.art).not.toBeNull()
      expect(wide.art).not.toBe(narrow.art)
      expect(fitMermaidArt(source, 64).art).toBe(narrow.art)
      for (const [fit, columns] of [[narrow, 64], [wide, 120]] as const) {
        expect(fit.art!.width).toBeLessThanOrEqual(columns - 4)
        expect(fit.art!.rows.length).toBeLessThanOrEqual(MAX_CHART_ROWS)
        expect(fit.art!.width).toBe(Math.max(...fit.art!.rows.map(row => stringWidth(row.map(piece => piece.text).join('')))))
      }
      expect(failure(source, 10)).toBe('too-wide')
      const huge = fitMermaidArt(source, 100000)
      expect(huge.art!.width).toBeLessThanOrEqual(MAX_CHART_COLUMNS)
    }
    const source = 'flowchart TD\n WidthA --> WidthB'
    expect(fitMermaidArt(source, 80).art).toBe(fitMermaidArt(source, 120).art)
  })

  test('does not silently ignore unsupported semantics', () => {
    for (const source of [
      'xychart-beta horizontal\n bar [1, 2]',
      'xychart-beta\n y-axis 10 --> 20\n bar [12, 15]',
      'pie\n click a callback\n "a":1',
      'gantt\n excludes weekends\n Work :2026-01-01, 1d',
      'gantt\n dateFormat DD/MM/YYYY\n Work :01/01/2026, 1d',
      'gantt\n axisFormat %b %d\n Work :2026-01-01, 1d',
    ]) expect(failure(source)).toBe('unsupported-syntax')
  })

  test('malformed, non-finite, inconsistent and invalid calendar inputs stay source', () => {
    for (const source of [
      'xychart-beta\n bar [NaN]', 'xychart-beta\n line [Infinity]',
      'xychart-beta\n bar [1e999]', 'xychart-beta\n bar [1000000000001]',
      'xychart-beta\n x-axis [a, b]\n bar [1]',
      'xychart-beta\n bar [1, 2]\n line [1]',
      'xychart-beta\n y-axis 0 --> 1\n line [2]',
      'xychart-beta\n bar [1,\u001b2]',
      'pie\n "a":0', 'pie\n "a":-1', 'pie\n "a":1\n "a":2',
      'gantt\n Work :2026-02-30, 1d', 'gantt\n Work :2025-02-29, 1d',
      'gantt\n Work :2026-01-01, 2025-12-31',
      'gantt\n Work :after missing, 1d',
      'gantt\n Work :2026-01-01, 0d',
      'gantt\n Work :2026-01-01, 0.1ms',
      'gantt\n Work :9999-12-31, 1d',
    ]) expect(failure(source)).toBe('unreadable')
  })

  test('bounds input, series, task counts and output, and never throws for hostile fragments', () => {
    expect(failure('xychart-beta\n bar [' + Array.from({ length: MAX_CHART_POINTS + 1 }, () => '1').join(',') + ']')).toBe('too-large')
    expect(failure('xychart-beta\n' + Array.from({ length: 5 }, () => 'bar [1]').join('\n'))).toBe('too-large')
    expect(failure('gantt\n' + Array.from({ length: MAX_GANTT_TASKS + 1 }, (_, i) => `Task ${i} :2026-01-01, 1d`).join('\n'))).toBe('too-large')
    expect(failure('pie\n' + '%% comment\n'.repeat(81) + '"a":1')).toBe('too-large')
    for (const width of [NaN, Infinity, -10, 1e9]) {
      for (const source of ['', 'xychart-beta\n line []', 'pie\n "x":1', 'gantt\n work :after a,1d']) expect(() => renderMermaidChart(source, width)).not.toThrow()
    }
  })

  test('zero and negative data keep honest scales; CRLF/comments/front matter do not change values', () => {
    expect(drawn('xychart-beta\n bar [0, 0]')).toContain('1:0')
    expect(drawn('xychart-beta\n bar [-1, -2]')).toContain('1:-2')
    expect(drawn('---\ntitle: metadata\n---\n%% comment\n' + pie.replace(/\n/g, '\r\n'))).toContain('3 (75.0%)')
  })

  test('source repair and feedback share the same chart owner', () => {
    const fence = '```'
    const fixed = normalizeMermaidFences(`Chart:${fence}mermaid\n${pie}\n${fence}\n`)
    expect(fixed).toContain(`Chart:\n\n${fence}mermaid`)
    const reply = (source: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `${fence}mermaid\n${source}\n${fence}` }] } })
    expect(getUndrawnMermaidReasons([{ type: 'user' }, reply(pie), reply(bar), reply(gantt)], 120)).toEqual([])
    expect(getUndrawnMermaidReasons([{ type: 'user' }, reply('gantt\n excludes weekends')], 120)).toEqual(['its chart uses syntax the terminal does not support'])
  })
})
