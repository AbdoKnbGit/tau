import { describe, expect, test } from 'bun:test'
import { marked } from 'marked'
import { stringWidth } from '../ink/stringWidth.js'
import {
  describeMermaidFallback,
  describeMermaidOmissions,
  fitMermaidArt,
  getMermaidArt,
  isMermaidFence,
  MAX_MERMAID_LINE_CHARS,
  MAX_MERMAID_SOURCE_CHARS,
  MAX_SEQUENCE_SOURCE_CHARS,
  type MermaidArt,
  mermaidArtFits,
  MERMAID_WIDTH_MARGIN,
  normalizeMermaidFences,
  prepareMermaidSource,
} from './mermaidDiagram.js'

// Non-ASCII test input is spelled as code points so no invisible character
// ends up in this file.
const text = (...codePoints: number[]): string =>
  String.fromCodePoint(...codePoints)

const lines = (art: MermaidArt): string[] =>
  art.rows.map(row => row.map(span => span.text).join(''))

const flow = (label: string): string => `flowchart LR\n  A["${label}"] --> B`

const FENCE = '```'

const isInvisible = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0xad ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)

describe('isMermaidFence', () => {
  test('matches the first word of the info string in any case', () => {
    expect(isMermaidFence('mermaid')).toBe(true)
    expect(isMermaidFence(' Mermaid ')).toBe(true)
    expect(isMermaidFence('MERMAID title="x"')).toBe(true)
  })

  test('rejects other languages and missing info strings', () => {
    expect(isMermaidFence('mermaidjs')).toBe(false)
    expect(isMermaidFence('text mermaid')).toBe(false)
    expect(isMermaidFence('')).toBe(false)
    expect(isMermaidFence(undefined)).toBe(false)
  })
})

describe('getMermaidArt', () => {
  test('draws a flowchart and measures it the way tau does', () => {
    const art = getMermaidArt('flowchart LR\n  A[Start] --> B[Done]')
    expect(art).not.toBeNull()
    expect(lines(art!).join('\n')).toContain('│ Start ├───▶│ Done │')
    expect(art!.width).toBe(Math.max(...lines(art!).map(stringWidth)))
    expect(art!.omitted).toBe(0)
  })

  test('draws every supported diagram type with every link style', () => {
    const sources = [
      'flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C((Done))\n  B -.->|no| D[[Retry]]\n  D ==> A\n  C --o E\n  C --x F',
      'flowchart RL\n  A --> B --> C',
      'flowchart BT\n  A --> B\n  A --> C',
      'flowchart TB\n  subgraph one\n    a1 --> a2\n  end\n  one --> b1',
      'sequenceDiagram\n  autonumber\n  Alice->>Bob: Hi\n  loop Retry\n    Bob-->>Alice: Busy\n  end\n  Note right of Bob: thinks',
      'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : go\n  Busy --> [*]',
      'classDiagram\n  Animal <|-- Duck\n  class Duck{\n    +swim()\n  }\n  <<interface>> Animal',
      'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : contains',
    ]
    for (const source of sources) {
      const art = getMermaidArt(source)
      expect(art).not.toBeNull()
      expect(art!.width).toBe(Math.max(...lines(art!).map(stringWidth)))
    }
  })

  test('keeps the idioms models write, which grok-mermaid ignores', () => {
    const source =
      '%%{init: {"theme":"dark"}}%%\ngraph TD;\n  %% note\n  A-->B;\n  style A fill:#f9f\n  classDef hot fill:#f00\n  class A hot\n  linkStyle 0 stroke:#ff3\n  click A "https://example.com"'
    expect(getMermaidArt(source)).not.toBeNull()
  })

  test('draws past front matter', () => {
    expect(getMermaidArt('---\ntitle: x\n---\nflowchart LR\n  A --> B')).not.toBeNull()
  })

  test('leaves unsupported types and blank input undrawn', () => {
    for (const source of [
      'pie\n  "Dogs" : 4',
      'gantt\n  title A',
      'mindmap\n  root((x))',
      '',
      '   \n  ',
    ]) {
      expect(getMermaidArt(source)).toBeNull()
    }
  })

  test('draws what it could read and counts what it left out', () => {
    const art = getMermaidArt('flowchart LR\n  A[Foo] invalid\n  B --> C')
    expect(art).not.toBeNull()
    expect(art!.omitted).toBe(1)
    expect(lines(art!).join('\n')).toContain('Foo')
  })

  test('does not count stray punctuation as left out', () => {
    const source = `flowchart TD\n  MOUSE[<b>Mouse Actions</b><br/>${text(0x2022)} Click<br/>${text(0x2022)} Drag"];;;\n  MOUSE --> HARNESS[Harness]`
    const art = getMermaidArt(source)
    expect(art).not.toBeNull()
    expect(art!.omitted).toBe(0)
  })

  test('refuses oversized input without laying it out', () => {
    const note = 'sequenceDiagram\n  Note over A,B: ' + 'n'.repeat(50_000)
    const started = performance.now()
    expect(getMermaidArt(note)).toBeNull()
    expect(performance.now() - started).toBeLessThan(50)
  })

  test('draws up to the line cap and not past it', () => {
    const head = '  A["'
    const tail = '"] --> B'
    const line = (length: number): string =>
      head + 'x'.repeat(length - head.length - tail.length) + tail
    expect(line(MAX_MERMAID_LINE_CHARS)).toHaveLength(MAX_MERMAID_LINE_CHARS)
    expect(
      getMermaidArt(`flowchart TD\n${line(MAX_MERMAID_LINE_CHARS)}`),
    ).not.toBeNull()
    expect(
      getMermaidArt(`flowchart TD\n${line(MAX_MERMAID_LINE_CHARS + 1)}`),
    ).toBeNull()
  })

  test('draws sequence diagrams up to their own cap and not past it', () => {
    let source = 'sequenceDiagram\n'
    for (let i = 0; ; i++) {
      const next = `  A->>B: message number ${i} with some padding text\n`
      if (source.length + next.length > MAX_SEQUENCE_SOURCE_CHARS) break
      source += next
    }
    expect(source.length).toBeGreaterThan(MAX_SEQUENCE_SOURCE_CHARS - 60)
    expect(getMermaidArt(source)).not.toBeNull()
    expect(getMermaidArt(source + 'x'.repeat(61) + '\n')).toBeNull()
  })

  test('draws other diagrams up to the general cap and not past it', () => {
    const pad = '  %% a comment line that pads the source out\n'
    let source = 'flowchart TD\n  A[Start] --> B[Done]\n'
    while (source.length + pad.length <= MAX_MERMAID_SOURCE_CHARS) source += pad
    expect(source.length).toBeGreaterThan(MAX_MERMAID_SOURCE_CHARS - pad.length)
    expect(getMermaidArt(source)).not.toBeNull()
    expect(getMermaidArt(source + pad)).toBeNull()
  })

  test('draws labels without the characters whose width is uncertain', () => {
    for (const [label, kept] of [
      ['done ' + text(0x2705), 'done'],
      [text(0x1f680) + ' Launch', 'Launch'],
      ['family ' + text(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), 'family'],
      ['flag ' + text(0x1f1f2, 0x1f1e6), 'flag'],
      [text(0x1f441, 0xfe0f) + ' Visualizer', 'Visualizer'],
    ] as const) {
      const art = getMermaidArt(flow(label))
      expect(art).not.toBeNull()
      const drawn = lines(art!).join('\n')
      expect(drawn).toContain(kept)
      for (const ch of drawn) expect(ch.codePointAt(0)!).toBeLessThan(0x2600)
    }
  })

  test('composes accents written as combining marks', () => {
    const art = getMermaidArt(flow('cafe' + text(0x301)))
    expect(art).not.toBeNull()
    expect(lines(art!).join('\n')).toContain('caf' + text(0xe9))
  })

  test('never draws invisible or control characters', () => {
    for (const label of [
      'tab' + text(0x9) + 'here',
      'soft' + text(0xad) + 'hyphen',
      'zero' + text(0x200b) + 'width',
      'rtl ' + text(0x202e) + ' override',
      'isolate ' + text(0x2066) + 'x' + text(0x2069),
      'esc ' + text(0x1b) + '[31m',
    ]) {
      const art = getMermaidArt(flow(label))
      if (art === null) continue
      const drawn = lines(art).join('')
      for (let i = 0; i < drawn.length; i++) {
        expect(isInvisible(drawn.charCodeAt(i))).toBe(false)
      }
    }
  })

  test('draws CJK, accented and Cyrillic labels at the widths tau uses', () => {
    for (const label of [
      text(0x958b, 0x59cb),
      text(0x30c7, 0x30fc, 0x30bf),
      text(0xd55c, 0xae00),
      'caf' + text(0xe9),
      text(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442),
      'na' + text(0xef) + 've ' + text(0xab) + 'x' + text(0xbb),
    ]) {
      const art = getMermaidArt(flow(label))
      expect(art).not.toBeNull()
      expect(lines(art!).join('\n')).toContain(label)
      expect(art!.width).toBe(Math.max(...lines(art!).map(stringWidth)))
    }
  })

  test('caches results, including sources it cannot draw', () => {
    const drawable = 'flowchart TD\n  Cache1 --> Cache2'
    expect(getMermaidArt(drawable)).toBe(getMermaidArt(drawable))
    expect(getMermaidArt('pie\n  "cache" : 1')).toBeNull()
    expect(getMermaidArt('pie\n  "cache" : 1')).toBeNull()
  })

  test('never throws on malformed input', () => {
    const alphabet = [
      ...'[](){}<>|-.=ox:;"\'`&#*%\n \t-->ABab09\\/~',
      ...[0x6f22, 0x1f44d, 0x301, 0x200d, 0x202e, 0xfe0f].map(code => text(code)),
    ]
    let seed = 1337
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    const headers = [
      'flowchart TD',
      'sequenceDiagram',
      'classDiagram',
      'stateDiagram-v2',
      'erDiagram',
      '---\ntitle: x\n---\nflowchart LR',
    ]
    for (let i = 0; i < 2000; i++) {
      let source = headers[i % headers.length]! + '\n'
      const length = Math.floor(next() * 120)
      for (let k = 0; k < length; k++) {
        source += alphabet[Math.floor(next() * alphabet.length)]
      }
      expect(() => getMermaidArt(source)).not.toThrow()
      expect(() => fitMermaidArt(source, 40)).not.toThrow()
      expect(() => normalizeMermaidFences(`x${FENCE}mermaid\n${source}\n`)).not.toThrow()
    }
  })
})

describe('prepareMermaidSource', () => {
  test('removes emoji with the space after them and keeps the rest', () => {
    expect(prepareMermaidSource(`subgraph "${text(0x1f3ae)} INPUT"`)).toBe('subgraph "INPUT"')
    expect(prepareMermaidSource(`A[Done ${text(0x2705)}]`)).toBe('A[Done ]')
    expect(prepareMermaidSource(`A[${text(0x1f441, 0xfe0f)} Eye] --> B`)).toBe('A[Eye] --> B')
  })

  test('turns tabs into spaces and drops controls', () => {
    expect(prepareMermaidSource('flowchart TD\n\tA --> B\r\n')).toBe('flowchart TD\n A --> B\n')
  })

  test('drops front matter', () => {
    expect(prepareMermaidSource('---\ntitle: Flow\n---\nflowchart LR\n  A --> B')).toBe(
      'flowchart LR\n  A --> B',
    )
  })

  test('leaves a plain source as it is', () => {
    const source = `flowchart LR\n  A["caf${text(0xe9)} ${text(0x2192)} ${text(0x958b)}"] --> B`
    expect(prepareMermaidSource(source)).toBe(source)
  })
})

describe('normalizeMermaidFences', () => {
  const diagram = 'flowchart TD\n  A --> B'
  const inputs = {
    glued: `Here it is:${FENCE}mermaid\n${diagram}\n${FENCE}\n`,
    unclosed: `${FENCE}mermaid\n${diagram}\n\n${FENCE}mermaid\nflowchart LR\n  C --> D\n${FENCE}\n`,
    gluedCloser: `${FENCE}mermaid\n${diagram}${FENCE}\nAfter.\n`,
    closerThenText: `${FENCE}mermaid\n${diagram}\n${FENCE}That is all.\n`,
    nextLanguage: `${FENCE}mermaid\n${diagram}\n${FENCE}python\nprint(1)\n${FENCE}\n`,
  }

  test('moves an opening fence glued to a sentence onto its own line', () => {
    expect(normalizeMermaidFences(inputs.glued)).toBe(
      `Here it is:\n\n${FENCE}mermaid\n${diagram}\n${FENCE}\n`,
    )
  })

  test('does so only when a diagram follows', () => {
    const prose = `Wrap it in ${FENCE}mermaid\nand close it with ${FENCE}.\n`
    expect(normalizeMermaidFences(prose)).toBe(prose)
  })

  test('closes a block before the next one opens', () => {
    expect(normalizeMermaidFences(inputs.unclosed)).toBe(
      `${FENCE}mermaid\n${diagram}\n\n${FENCE}\n${FENCE}mermaid\nflowchart LR\n  C --> D\n${FENCE}\n`,
    )
    expect(normalizeMermaidFences(inputs.nextLanguage)).toBe(
      `${FENCE}mermaid\n${diagram}\n${FENCE}\n${FENCE}python\nprint(1)\n${FENCE}\n`,
    )
  })

  test('splits a closing fence glued to the last diagram line', () => {
    expect(normalizeMermaidFences(inputs.gluedCloser)).toBe(
      `${FENCE}mermaid\n${diagram}\n${FENCE}\nAfter.\n`,
    )
  })

  test('closes the block before a sentence glued to its closing fence', () => {
    expect(normalizeMermaidFences(inputs.closerThenText)).toBe(
      `${FENCE}mermaid\n${diagram}\n${FENCE}\n\nThat is all.\n`,
    )
  })

  test("repairs the user's reply into two drawable blocks", () => {
    const reply = `I'll create a schema.${FENCE}mermaid\nflowchart TD\n    A[One] --> B[Two]\n\n    B --> C[Three]\n${FENCE}\n\n${FENCE}mermaid\nflowchart LR\n    A -- sends --> B\n${FENCE}\n`
    const fixed = normalizeMermaidFences(reply)
    expect(fixed.startsWith(`I'll create a schema.\n\n${FENCE}mermaid\nflowchart TD`)).toBe(true)
    const blocks = marked.lexer(fixed).filter(token => token.type === 'code')
    expect(blocks.map(token => (token as { lang?: string }).lang)).toEqual(['mermaid', 'mermaid'])
    for (const block of blocks) {
      expect(getMermaidArt((block as { text: string }).text)).not.toBeNull()
    }
  })

  test('leaves other code blocks and quotes alone', () => {
    const input = `${FENCE}markdown\nText${FENCE}mermaid\nflowchart TD\n${FENCE}\n> Quote ${FENCE}mermaid\n> flowchart TD\n`
    expect(normalizeMermaidFences(input)).toBe(input)
  })

  test('does not touch lines still streaming in', () => {
    for (const partial of [
      `Here it is:${FENCE}mermaid\nflowchart TD`,
      `Here it is:${FENCE}mermaid\n`,
      `${FENCE}mermaid\n${diagram}${FENCE}`,
      `${FENCE}mermaid\n${diagram}\n${FENCE}That`,
    ]) {
      expect(normalizeMermaidFences(partial)).toBe(partial)
    }
  })

  test("never moves StreamingMarkdown's stable prefix while a reply streams", () => {
    // StreamingMarkdown's boundary algorithm: blocks before the last one are
    // final, and the text it renders next must still start with them.
    for (const reply of [
      `Intro.${FENCE}mermaid\n${diagram}\n${FENCE}\n\nAfter the diagram.\n`,
      `Text\nmore.${FENCE}mermaid\n${diagram}\n\n  B --> C\n${FENCE}\n\n${FENCE}mermaid\nflowchart LR\n  C --> D\n${FENCE}\nEnd.\n`,
      `${FENCE}mermaid\n${diagram}${FENCE}\nAfter.\n\nMore.\n`,
      `${FENCE}mermaid\n${diagram}\n${FENCE}That is all.\n\nBye.\n`,
    ]) {
      let stable = ''
      for (let end = 1; end <= reply.length; end++) {
        const text = normalizeMermaidFences(reply.slice(0, end))
        expect(text.startsWith(stable)).toBe(true)
        const tokens = marked.lexer(text.substring(stable.length))
        let last = tokens.length - 1
        while (last >= 0 && tokens[last]!.type === 'space') last--
        let advance = 0
        for (let i = 0; i < last; i++) advance += tokens[i]!.raw.length
        if (advance > 0) stable = text.substring(0, stable.length + advance)
      }
    }
  })

  test('changes nothing more the second time', () => {
    for (const input of Object.values(inputs)) {
      const once = normalizeMermaidFences(input)
      expect(normalizeMermaidFences(once)).toBe(once)
    }
  })

  test('returns text without mermaid unchanged', () => {
    const input = `plain ${FENCE}text\nnothing\n`
    expect(normalizeMermaidFences(input)).toBe(input)
  })
})

describe('mermaidArtFits', () => {
  test('keeps the margin free', () => {
    const art = getMermaidArt('flowchart LR\n  Fit1[Start] --> Fit2[Done]')!
    expect(mermaidArtFits(art, art.width + MERMAID_WIDTH_MARGIN)).toBe(true)
    expect(mermaidArtFits(art, art.width + MERMAID_WIDTH_MARGIN - 1)).toBe(false)
  })
})

describe('fitMermaidArt', () => {
  const edges = Array.from(
    { length: 8 },
    (_, i) => `  N${i}[Step number ${i} of it] --> N${i + 1}[Step number ${i + 1} of it]`,
  ).join('\n')
  const chain = `flowchart LR\n${edges}`

  test('draws as written when it fits', () => {
    const source = 'flowchart LR\n  Fit3[Start] --> Fit4[Done]'
    expect(fitMermaidArt(source, 80).art).toBe(getMermaidArt(source))
  })

  test('turns a too-wide left-to-right flowchart top-down', () => {
    expect(getMermaidArt(chain)!.width).toBeGreaterThan(120)
    const fit = fitMermaidArt(chain, 120)
    expect(fit.art).not.toBeNull()
    expect(fit.art).toBe(getMermaidArt(chain.replace('flowchart LR', 'flowchart TD')))
    expect(fit.art!.width).toBeLessThanOrEqual(120 - MERMAID_WIDTH_MARGIN)
  })

  test('turns a too-wide top-down fan-out left-to-right', () => {
    const fan =
      'flowchart TD\n' +
      Array.from({ length: 9 }, (_, i) => `  Root --> Leaf${i}[Leaf number ${i}]`).join('\n')
    expect(getMermaidArt(fan)!.width).toBeGreaterThan(100)
    const fit = fitMermaidArt(fan, 100)
    expect(fit.art).not.toBeNull()
    expect(fit.art).toBe(getMermaidArt(fan.replace('flowchart TD', 'flowchart LR')))
  })

  test('keeps directives, comments and semicolons when turning', () => {
    const source = `%%{init: {"theme":"dark"}}%%\n%% note\ngraph LR;\n${edges}`
    const fit = fitMermaidArt(source, 120)
    expect(fit.art).not.toBeNull()
    expect(fit.art).toBe(getMermaidArt(source.replace('graph LR;', 'graph TD;')))
  })

  test('says how many columns it needs when neither direction fits', () => {
    const narrowest = Math.min(
      getMermaidArt(chain)!.width,
      getMermaidArt(chain.replace('flowchart LR', 'flowchart TD'))!.width,
    )
    expect(fitMermaidArt(chain, 20)).toEqual({
      art: null,
      fallback: { kind: 'too-wide', columnsNeeded: narrowest + MERMAID_WIDTH_MARGIN, columns: 20 },
    })
  })

  test('never turns other kinds of diagram', () => {
    const sequence =
      'sequenceDiagram\n' +
      Array.from({ length: 8 }, (_, i) => `  participant P${i} as Participant ${i}`).join('\n') +
      '\n  P0->>P7: hi'
    const fit = fitMermaidArt(sequence, 60)
    expect(fit.art).toBeNull()
    expect(fit.art === null ? fit.fallback.kind : 'drawn').toBe('too-wide')
  })

  test('names the reason a block is not drawn', () => {
    const reason = (source: string): string => {
      const fit = fitMermaidArt(source, 200)
      return fit.art === null ? fit.fallback.kind : 'drawn'
    }
    expect(reason('pie\n  "Dogs" : 4')).toBe('unsupported')
    expect(reason('flowchart TD\n  %% nothing yet')).toBe('unreadable')
    expect(reason(flow('done ' + text(0x2705)))).toBe('drawn')
    expect(reason('sequenceDiagram\n  Note over A,B: ' + 'n'.repeat(5000))).toBe('too-large')
  })

  test("draws the user's small diagram with emoji titles at 120 columns", () => {
    const source = [
      'flowchart TB',
      `    subgraph "${text(0x1f3ae)} INPUT"`,
      '        A["Tau CLI<br/>User task"]',
      '    end',
      `    subgraph "${text(0x1f9e0)} CORE"`,
      '        B["Agent<br/>agent/index.ts"]',
      '        B -->|"extends"| C["BrowserAgent<br/>browserAgent.ts"]',
      '    end',
      `    subgraph "${text(0x1f310)} BROWSER"`,
      '        G["Page"]',
      '        H["TabManager"]',
      '        C <--> G',
      '        C <--> H',
      '    end',
      '    A --> C',
    ].join('\n')
    const fit = fitMermaidArt(source, 120)
    expect(fit.art).not.toBeNull()
    const drawn = lines(fit.art!).join('\n')
    expect(drawn).toContain('INPUT')
    expect(drawn).toContain('Tau CLI User task')
  })
})

describe('describeMermaidFallback', () => {
  test('gives a one-line reason for every fallback', () => {
    expect(describeMermaidFallback({ kind: 'too-wide', columnsNeeded: 224, columns: 120 })).toBe(
      'mermaid · not drawn: it needs 224 columns and the terminal has 120',
    )
    expect(describeMermaidFallback({ kind: 'unsupported', name: 'pie' })).toContain(
      'pie diagrams',
    )
    for (const fallback of [
      { kind: 'too-large' },
      { kind: 'unsupported', name: null },
      { kind: 'unreadable' },
      { kind: 'characters' },
    ] as const) {
      const line = describeMermaidFallback(fallback)
      expect(line.startsWith('mermaid · not drawn:')).toBe(true)
      expect(line.length).toBeLessThan(90)
    }
  })

  test('says how many statements a drawing left out', () => {
    expect(describeMermaidOmissions(1)).toBe('mermaid · 1 statement could not be read and is not drawn')
    expect(describeMermaidOmissions(3)).toBe('mermaid · 3 statements could not be read and are not drawn')
  })
})
