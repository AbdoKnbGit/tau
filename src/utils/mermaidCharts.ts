import type { Span } from 'grok-mermaid'
import { stringWidth } from '../ink/stringWidth.js'

// This is a deliberately small terminal grammar, not a second Mermaid engine.
// Unknown statements fail the whole chart rather than silently changing data.
export const MAX_CHART_POINTS = 32
export const MAX_CHART_SERIES = 4
export const MAX_GANTT_TASKS = 32
export const MAX_CHART_COLUMNS = 156
export const MAX_CHART_ROWS = 80
const MAX_CHART_SOURCE = 8000
const MAX_CHART_LINES = 80
const MAX_LABEL = 64
const MAX_VALUE = 1e12
const DAY = 86_400_000
const MAX_GANTT_SPAN = 3660 * DAY
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const RANGE = new RegExp(`^(${NUMBER})\\s*-->\\s*(${NUMBER})$`)

export type MermaidChartKind = 'xychart' | 'pie' | 'gantt'
export type MermaidChartResult =
  | { rows: Span[][] }
  | { error: 'too-large' | 'unreadable' | 'unsupported-syntax' }

type Series = { kind: 'bar' | 'line'; values: number[] }
type Row = Span[]
const span = (text: string, cls: Span['cls'] = 'text'): Span => ({ text, cls })
const row = (text: string, cls: Span['cls'] = 'text'): Row => [span(text, cls)]
const error = (kind: 'too-large' | 'unreadable' | 'unsupported-syntax'): MermaidChartResult => ({ error: kind })

export function mermaidChartKind(source: string): MermaidChartKind | null {
  const header = source.split('\n', MAX_CHART_LINES + 1).find(line => line.trim() && !line.trim().startsWith('%%'))?.trim() ?? ''
  if (/^xychart(?:-beta)?(?:\s|$)/i.test(header)) return 'xychart'
  if (/^pie(?:\s|$)/i.test(header)) return 'pie'
  if (/^gantt(?:\s|$)/i.test(header)) return 'gantt'
  return null
}

/** The only width used for chart layout and for its owner's cache identity. */
export function mermaidChartColumns(columns: number): number {
  return Math.max(12, Math.min(MAX_CHART_COLUMNS, Number.isFinite(columns) ? Math.floor(columns) : 76))
}

function label(text: string): string | null {
  const quoted = /^"([^"\\]*)"$/.exec(text.trim())
  const value = quoted ? quoted[1]! : text.trim()
  return value && value.length <= MAX_LABEL && !/[\x00-\x1f\x7f-\x9f<>"\\]/.test(value) ? value : null
}

function number(text: string): number | null {
  if (!new RegExp(`^${NUMBER}$`).test(text.trim())) return null
  const value = Number(text)
  return Number.isFinite(value) && Math.abs(value) <= MAX_VALUE ? value : null
}

function numbers(text: string): number[] | null {
  if (!/^\[[^\[\]]*\]$/.test(text)) return null
  const pieces = text.slice(1, -1).split(',')
  if (!pieces.length || pieces.length > MAX_CHART_POINTS) return null
  const values = pieces.map(number)
  return values.every((value): value is number => value !== null) ? values : null
}

function labels(text: string): string[] | null {
  if (!/^\[[^\[\]]*\]$/.test(text)) return null
  const values: string[] = []
  let start = 1
  let quoted = false
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted
    if ((text[i] === ',' && !quoted) || i === text.length - 1) {
      const value = label(text.slice(start, i))
      if (value === null) return null
      values.push(value)
      start = i + 1
    }
  }
  return !quoted && values.length > 0 && values.length <= MAX_CHART_POINTS ? values : null
}

function axis(text: string): { title?: string; body: string } | null {
  const quoted = /^"([^"\\]*)"(?:\s+(.*))?$/.exec(text)
  if (!quoted) return { body: text }
  const title = label(`"${quoted[1]}"`)
  return title === null ? null : { title, body: quoted[2] ?? '' }
}

function range(text: string): [number, number] | null {
  const match = RANGE.exec(text)
  if (!match) return null
  const low = number(match[1]!)
  const high = number(match[2]!)
  return low !== null && high !== null && high > low ? [low, high] : null
}

function format(value: number): string {
  if (Object.is(value, -0) || value === 0) return '0'
  return String(Number(value.toPrecision(4)))
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)))
}

function output(rows: Row[]): MermaidChartResult {
  if (rows.length > MAX_CHART_ROWS || rows.some(line => stringWidth(line.map(piece => piece.text).join('')) > MAX_CHART_COLUMNS)) return error('too-large')
  return { rows }
}

export function renderMermaidChart(source: string, columns: number): MermaidChartResult {
  if (source.length > MAX_CHART_SOURCE) return error('too-large')
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > MAX_CHART_LINES || lines.some(line => line.length > 400)) return error('too-large')
  const statements = lines.map(line => line.trim()).filter(line => line && !line.startsWith('%%'))
  const kind = mermaidChartKind(source)
  if (!kind) return error('unsupported-syntax')
  const width = mermaidChartColumns(columns)
  // Input is normally already cleaned by the diagram owner. Direct callers
  // still cannot inject terminal escapes or unbounded hidden characters.
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(normalized)) return error('unreadable')
  try {
    if (kind === 'xychart') return xyChart(statements, width)
    if (kind === 'pie') return pieChart(statements, width)
    return ganttChart(statements, width)
  } catch {
    return error('unreadable')
  }
}

function xyChart(lines: string[], columns: number): MermaidChartResult {
  if (!/^xychart(?:-beta)?$/i.test(lines[0]!)) return error('unsupported-syntax')
  let title: string | undefined
  let xTitle: string | undefined
  let yTitle: string | undefined
  let categories: string[] | undefined
  let xRange: [number, number] | undefined
  let yRange: [number, number] | undefined
  let sawX = false
  let sawY = false
  const series: Series[] = []
  for (const line of lines.slice(1)) {
    const match = /^(title|x-axis|y-axis|bar|line)\s+(.+)$/i.exec(line)
    if (!match) return error('unsupported-syntax')
    const [, command, body] = match
    switch (command!.toLowerCase()) {
      case 'title': {
        if (title !== undefined) return error('unreadable')
        title = label(body!) ?? undefined
        if (!title) return error('unreadable')
        break
      }
      case 'x-axis': {
        if (sawX) return error('unreadable')
        sawX = true
        const parsed = axis(body!)
        if (!parsed) return error('unreadable')
        xTitle = parsed.title
        if (!parsed.body) break
        if (parsed.body.startsWith('[')) {
          categories = labels(parsed.body) ?? undefined
          if (!categories) return error('unreadable')
        } else {
          xRange = range(parsed.body) ?? undefined
          if (!xRange) return error('unreadable')
        }
        break
      }
      case 'y-axis': {
        if (sawY) return error('unreadable')
        sawY = true
        const parsed = axis(body!)
        if (!parsed) return error('unreadable')
        yTitle = parsed.title
        if (parsed.body) {
          yRange = range(parsed.body) ?? undefined
          if (!yRange) return error('unreadable')
        }
        break
      }
      default: {
        if (body!.split(',').length > MAX_CHART_POINTS) return error('too-large')
        const values = numbers(body!)
        if (!values) return error('unreadable')
        series.push({ kind: command!.toLowerCase() as 'bar' | 'line', values })
        if (series.length > MAX_CHART_SERIES) return error('too-large')
      }
    }
  }
  if (!series.length) return error('unreadable')
  const points = series[0]!.values.length
  if (series.some(item => item.values.length !== points) || (categories && categories.length !== points)) return error('unreadable')
  const data = series.flatMap(item => item.values)
  const low = yRange?.[0] ?? Math.min(0, ...data)
  const high = yRange?.[1] ?? Math.max(0, ...data)
  if (data.some(value => value < low || value > high)) return error('unreadable')
  if (series.some(item => item.kind === 'bar') && (low > 0 || high < 0)) return error('unsupported-syntax')
  const spanY = high - low || 1
  const height = 8
  const ticks = Array.from({ length: height + 1 }, (_, i) => format(high - (i / height) * spanY))
  // For an all-zero series use a harmless 0..1 scale, not invented negatives.
  if (high === low) for (let i = 0; i <= height; i++) ticks[i] = format(low + 1 - i / height)
  const top = high === low ? high + 1 : high
  const gutter = Math.max(...ticks.map(stringWidth)) + 1
  const bars = series.filter(item => item.kind === 'bar').length
  const minimum = Math.max(16, points * Math.max(2, bars + 1))
  const plotWidth = Math.max(minimum, Math.min(columns - gutter - 1, 100))
  const grid: { char: string; cls: Span['cls'] }[][] = Array.from({ length: height + 1 }, () => Array.from({ length: plotWidth }, () => ({ char: ' ', cls: 'text' })))
  const yOf = (value: number) => Math.max(0, Math.min(height, Math.round(((top - value) / spanY) * height)))
  const xOf = (i: number) => Math.min(plotWidth - 1, Math.floor(((i + 0.5) / points) * plotWidth))
  const baseline = yOf(0)
  for (let x = 0; x < plotWidth; x++) grid[baseline]![x] = { char: '─', cls: 'border' }
  const put = (x: number, y: number, char: string, cls: Span['cls']) => {
    if (grid[y]?.[x]) grid[y]![x] = { char, cls }
  }
  let bar = 0
  series.forEach((item, index) => {
    const cls: Span['cls'] = index % 2 ? 'title' : 'edge'
    if (item.kind === 'bar') {
      const offset = bar++ - Math.floor((bars - 1) / 2)
      item.values.forEach((value, i) => {
        const y = yOf(value)
        for (let r = Math.min(y, baseline); r <= Math.max(y, baseline); r++) if (value !== 0) put(xOf(i) + offset, r, '█', cls)
      })
    } else {
      item.values.forEach((value, i) => {
        const x = xOf(i)
        const y = yOf(value)
        if (i > 0) {
          const beforeX = xOf(i - 1)
          const beforeY = yOf(item.values[i - 1]!)
          for (let step = beforeX + 1; step < x; step++) {
            const r = Math.round(beforeY + ((y - beforeY) * (step - beforeX)) / (x - beforeX))
            put(step, r, y === beforeY ? '─' : y < beforeY ? '╱' : '╲', cls)
          }
        }
        put(x, y, index % 2 ? '◆' : '●', cls)
      })
    }
  })
  const rows: Row[] = title ? [row(title, 'title')] : []
  rows.push(row(`Y: ${yTitle ? yTitle + ' ' : ''}(${String(low)} → ${String(top)})`, 'edgeLabel'))
  for (let y = 0; y <= height; y++) {
    const pieces = [span(pad(ticks[y]!, gutter) + '│', 'edgeLabel')]
    for (const cell of grid[y]!) {
      const last = pieces.at(-1)!
      if (last.cls === cell.cls) last.text += cell.char
      else pieces.push(span(cell.char, cell.cls))
    }
    rows.push(pieces)
  }
  rows.push(row(' '.repeat(gutter) + '└' + '─'.repeat(plotWidth), 'border'))
  const indexes = Array.from({ length: plotWidth }, () => ' ')
  for (let i = 0; i < points; i++) {
    const value = String(i + 1)
    const at = Math.min(plotWidth - value.length, xOf(i))
    for (let j = 0; j < value.length; j++) indexes[at + j] = value[j]!
  }
  rows.push(row(' '.repeat(gutter + 1) + indexes.join(''), 'edgeLabel'))
  if (xTitle || xRange) rows.push(row(`X: ${xTitle ?? ''}${xRange ? ` (${String(xRange[0])} → ${String(xRange[1])})` : ''}`.trimEnd(), 'edgeLabel'))
  const names = categories ?? Array.from({ length: points }, (_, i) => xRange ? format(xRange[0] + (points === 1 ? 0 : (i / (points - 1)) * (xRange[1] - xRange[0]))) : String(i + 1))
  // The data key is exact, also when category names cannot share a plot row.
  // A table avoids truncating labels or relying on color to identify series.
  rows.push(row(series.map((item, i) => `${i + 1}=${item.kind}${item.kind === 'line' ? (i % 2 ? '◆' : '●') : '█'}`).join('  '), 'edgeLabel'))
  const indexed = names.map((name, i) => `${i + 1}. ${name}`)
  const nameWidth = Math.max(...indexed.map(stringWidth))
  indexed.forEach((name, i) => rows.push(row(`${pad(name, nameWidth)}  ${series.map((item, j) => `${j + 1}:${String(item.values[i]!)}`).join('  ')}`)))
  return output(rows)
}

function pieChart(lines: string[], columns: number): MermaidChartResult {
  const header = /^pie(?:\s+showData)?(?:\s+title\s+(.+))?$/i.exec(lines[0]!)
  if (!header) return error('unsupported-syntax')
  let title = header[1] ? label(header[1]) : undefined
  if (title === null) return error('unreadable')
  const slices: { label: string; value: number }[] = []
  for (const line of lines.slice(1)) {
    const heading = /^title\s+(.+)$/i.exec(line)
    if (heading) {
      if (title !== undefined) return error('unreadable')
      title = label(heading[1]!)
      if (title === null) return error('unreadable')
      continue
    }
    const slice = /^"([^"\\]+)"\s*:\s*(.+)$/.exec(line)
    if (!slice) return error('unsupported-syntax')
    const name = label(`"${slice[1]}"`)
    const value = number(slice[2]!)
    if (name === null || value === null || value < 0 || slices.some(item => item.label === name)) return error('unreadable')
    slices.push({ label: name, value })
    if (slices.length > MAX_CHART_POINTS) return error('too-large')
  }
  const total = slices.reduce((sum, item) => sum + item.value, 0)
  if (!slices.length || !Number.isFinite(total) || total <= 0) return error('unreadable')
  const labelWidth = Math.max(...slices.map(item => stringWidth(item.label)))
  const suffixes = slices.map(item => ` ${String(item.value)} (${(item.value / total * 100).toFixed(1)}%)`)
  const suffixWidth = Math.max(...suffixes.map(stringWidth))
  const barWidth = Math.max(8, Math.min(60, columns - labelWidth - suffixWidth - 2))
  const rows: Row[] = title ? [row(title, 'title')] : []
  rows.push(row(`Share of total ${String(total)}`, 'edgeLabel'))
  slices.forEach((item, i) => {
    const fill = Math.round(item.value / total * barWidth)
    rows.push([span(pad(item.label, labelWidth) + ' '), span(pad('█'.repeat(fill), barWidth), i % 2 ? 'title' : 'edge'), span(suffixes[i]!)])
  })
  return output(rows)
}

type Task = { label: string; start: number; end: number; section?: string; tags: string[]; milestone: boolean }

// Parse calendar dates with explicit UTC arithmetic and reject rollover dates.
function date(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number]
  if (year < 1970 || year > 9999) return null
  const time = Date.UTC(year, month - 1, day)
  const value = new Date(time)
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day ? time : null
}

function duration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(text)
  if (!match) return null
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY }
  const value = Number(match[1]) * scale[match[2]!]!
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_GANTT_SPAN ? value : null
}

function dateLabel(time: number): string {
  const value = new Date(time).toISOString()
  return time % DAY === 0 ? value.slice(0, 10) : value.replace('T', ' ').replace('.000Z', 'Z')
}

function ganttChart(lines: string[], columns: number): MermaidChartResult {
  if (!/^gantt$/i.test(lines[0]!)) return error('unsupported-syntax')
  let title: string | undefined
  let section: string | undefined
  let sawFormat = false
  const ids = new Map<string, Task>()
  const tasks: Task[] = []
  for (const line of lines.slice(1)) {
    const heading = /^(title|section)\s+(.+)$/i.exec(line)
    if (heading) {
      const value = label(heading[2]!)
      if (value === null) return error('unreadable')
      if (heading[1]!.toLowerCase() === 'title') {
        if (title !== undefined) return error('unreadable')
        title = value
      } else section = value
      continue
    }
    if (/^dateFormat\b/i.test(line)) {
      if (sawFormat || tasks.length || !/^dateFormat\s+YYYY-MM-DD$/.test(line)) return error('unsupported-syntax')
      sawFormat = true
      continue
    }
    // These directives alter calendar semantics or interactions; do not ignore.
    if (/^(?:axisFormat|excludes|includes|todayMarker|tickInterval|weekday|weekend|inclusiveEndDates|topAxis|displayMode|click|accTitle|accDescr)\b/i.test(line)) return error('unsupported-syntax')
    const colon = line.indexOf(':')
    if (colon <= 0) return error('unsupported-syntax')
    const name = label(line.slice(0, colon))
    if (name === null) return error('unreadable')
    const fields = line.slice(colon + 1).split(',').map(part => part.trim())
    const tags: string[] = []
    while (/^(done|active|crit|milestone)$/.test(fields[0] ?? '')) {
      const tag = fields.shift()!
      if (tags.includes(tag)) return error('unreadable')
      tags.push(tag)
    }
    if (fields.length < 2 || fields.length > 3 || fields.some(part => !part)) return error('unreadable')
    const id = fields.length === 3 ? fields.shift()! : undefined
    if (id && (!/^[A-Za-z_][\w-]{0,63}$/.test(id) || ids.has(id))) return error('unreadable')
    const after = /^after\s+([A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)*)$/.exec(fields[0]!)
    const dependencies = after?.[1]!.split(/\s+/).map(key => ids.get(key))
    if (dependencies?.some(item => item === undefined)) return error('unreadable')
    const start = dependencies ? Math.max(...dependencies.map(item => item!.end)) : date(fields[0]!)
    const elapsed = duration(fields[1]!)
    const end = elapsed !== null && start !== null ? start + elapsed : date(fields[1]!)
    const milestone = tags.includes('milestone')
    if (start === null || end === null || !Number.isFinite(end) || end > Date.UTC(9999, 11, 31) || end < start || end - start > MAX_GANTT_SPAN || (milestone ? end !== start : end === start)) return error('unreadable')
    const task: Task = { label: name, start, end, section, tags, milestone }
    tasks.push(task)
    if (id) ids.set(id, task)
    if (tasks.length > MAX_GANTT_TASKS) return error('too-large')
  }
  if (!tasks.length) return error('unreadable')
  const first = Math.min(...tasks.map(task => task.start))
  const last = Math.max(...tasks.map(task => task.end))
  if (last - first > MAX_GANTT_SPAN) return error('too-large')
  const names = tasks.map(task => (task.tags.filter(tag => tag !== 'milestone').length ? `[${task.tags.filter(tag => tag !== 'milestone').join(',')}] ` : '') + task.label)
  const nameWidth = Math.max(...names.map(stringWidth))
  const plotWidth = Math.max(16, Math.min(80, columns - nameWidth - 2))
  const extent = last - first || DAY
  const position = (time: number) => Math.max(0, Math.min(plotWidth - 1, Math.round(((time - first) / extent) * (plotWidth - 1))))
  const rows: Row[] = title ? [row(title, 'title')] : []
  rows.push(row(`${dateLabel(first)} → ${dateLabel(last)} (UTC)`, 'edgeLabel'))
  let previousSection: string | undefined
  tasks.forEach((task, i) => {
    if (task.section && task.section !== previousSection) rows.push(row(task.section, 'title'))
    previousSection = task.section
    const begin = position(task.start)
    const end = position(task.end)
    const graph = ' '.repeat(begin) + (task.milestone ? '◆' : '█'.repeat(Math.max(1, end - begin)))
    rows.push([span(pad(names[i]!, nameWidth) + ' │'), span(pad(graph, plotWidth), task.tags.includes('crit') ? 'title' : 'edge')])
    // Exact endpoints remain visible even when two durations round to a cell.
    rows.push(row(`  ${dateLabel(task.start)} → ${dateLabel(task.end)}`, 'edgeLabel'))
  })
  return output(rows)
}
