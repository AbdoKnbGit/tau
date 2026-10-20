import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

// Pure production modules: no CLI startup, credentials, config or subprocesses.
const bundle = await build({
  stdin: { contents: `
    export * from './src/utils/terminalMath.ts';
    export * from './src/utils/terminalMarkdown.ts';
    export { marked, Marked } from 'marked';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const { renderTerminalMath: math, lexTerminalMarkdown: lex, stableMarkdownPrefix: stable } = runtime
const { marked, Marked } = runtime
function flatten(tokens) {
  return tokens.flatMap(t => [t, ...flatten(t.tokens ?? []),
    ...flatten(t.items ?? []), ...flatten(t.header?.flatMap(c => c.tokens) ?? []),
    ...flatten(t.rows?.flatMap(r => r.flatMap(c => c.tokens)) ?? [])])
}
const mathTokens = text => flatten(lex(text)).filter(t => t.type.startsWith('terminalMath'))
const values = text => mathTokens(text).filter(t => t.complete).map(t => math(t.text))

test('common notation, grouping, nested arguments, scripts and matrices', () => {
  for (const [source, expected] of [
    ['E = mc^2', 'E = mc²'],
    [String.raw`\alpha + \beta \leq \pi`, 'α + β ≤ π'],
    [String.raw`\alpha ^2 + x_{10}`, 'α² + x₁₀'],
    [String.raw`\frac{a+b}{c}`, '(a+b)⁄c'],
    [String.raw`\frac{1}{\frac{2}{3}}`, '1⁄(2⁄3)'],
    [String.raw`\frac{a}{b}^2`, '(a⁄b)²'],
    [String.raw`\frac{a}{bc}`, 'a⁄(bc)'],
    [String.raw`{a+b}^2`, '(a+b)²'],
    [String.raw`\sqrt{x}^2`, '(√x)²'],
    [String.raw`x_i^2`, 'xᵢ²'],
    [String.raw`\sqrt[3]{x} + \sqrt{a+b}`, '³√x + √(a+b)'],
    [String.raw`e^{i\pi}+1=0`, 'e^(iπ)+1=0'],
    [String.raw`\int_0^\infty f(x)\,dx`, '∫₀^(∞) f(x) dx'],
    [String.raw`\mathbb{R} \times \mathbb{N}`, 'ℝ × ℕ'],
    [String.raw`\text{speed of light} = c`, 'speed of light = c'],
    [String.raw`\left(\frac{x}{y}\right)`, '(x⁄y)'],
    [String.raw`\begin{bmatrix}a & b \\ c & d\end{bmatrix}`, '[a, b; c, d]'],
    [String.raw`\begin{pmatrix}\begin{bmatrix}a&b\end{bmatrix}&c\\d&e\end{pmatrix}`, '([a, b], c; d, e)'],
    [String.raw`\begin{aligned}a &= b \\ c &= d\end{aligned}`, 'a = b; c = d'],
    [String.raw`\boxed{\hat{x}}`, '[x̂]'],
    [String.raw`\operatorname{rank}(A)`, 'rank(A)'],
  ]) assert.equal(math(source), expected, source)
})

test('unknown, malformed, executable TeX and excessive input fall back intact', () => {
  for (const source of [
    String.raw`\unknown{x}`, String.raw`\frac{a}`, String.raw`\sqrt`,
    '{x', 'x}', String.raw`\begin{bmatrix}a&b`, String.raw`\newcommand{\a}{\a}\a`,
    String.raw`\input{/etc/passwd}`, String.raw`\write18{touch BAD}`,
    String.raw`\href{javascript:alert(1)}{x}`, 'x\x1b[31m',
    '{'.repeat(1000) + 'x' + '}'.repeat(1000),
    String.raw`\sqrt{`.repeat(100) + 'x' + '}'.repeat(100),
    'x'.repeat(runtime.MAX_MATH_SOURCE + 1),
    String.raw`\hat{abc}`, String.raw`\begin{unknown}x\end{unknown}`,
    String.raw`\begin{matrix}` + 'a&'.repeat(300) + String.raw`b\end{matrix}`,
    String.raw`\toString{x}`, String.raw`\constructor{a}`, 'x^2^3', '^2',
  ]) assert.equal(math(source), null, source.slice(0, 80))
})

test('four delimiters work in paragraphs, lists, headings, quotes, labels and tables', () => {
  for (const source of [
    '$x^2$', String.raw`\(x^2\)`, '$$x^2$$', String.raw`\[x^2\]`,
    '**$x^2$**', '*$x^2$*', '# $x^2$', '- $x^2$', '> $x^2$',
    '[value $x^2$](https://example.com)', '| value |\n| --- |\n| $x^2$ |',
    '$$\nx^2\n$$', '\\[\nx^2\n\\]', '- $$\n  x^2\n  $$',
    '> \\[\n> x^2\n> \\]',
  ]) assert.deepEqual(values(source), ['x²'], source)
})

test('prices, shell variables, code, URLs and escaped math stay literal', () => {
  for (const source of [
    'Costs $5 and $10 today.', 'Pay $20.00, then $30.00.',
    'USD $1,000 to $2,000', '$HOME and $PATH', '${HOME}', '$()', '$$',
    'foo$bar$baz', String.raw`\$x^2\$`, '`$x^2$`',
    '```latex\n$x^2$\n```', '```mermaid\nA["$x^2$"] --> B\n```',
    '    $x^2$', '[link](https://example.com/$x$)',
    '<https://example.com/$x$>', 'https://example.com/$x$',
    '<code>$x^2$</code>',
  ]) assert.equal(values(source).length, 0, source)
  assert.deepEqual(values('Price $5; value $x^2$; price $10.'), ['x²'])
  assert.deepEqual(values(String.raw`A number: \(5\).`), ['5'])
  assert.deepEqual(values('$5$ and $10^{-3}$'), ['5', '10⁻³'])
})

test('unrelated Markdown tokenization matches the former renderer', () => {
  const previous = new Marked({ tokenizer: { del() { return undefined } } })
  for (const source of [
    '# Heading\n\n**bold** and *italic* and `code`',
    '- a\n  - b\n\n  more\n- c',
    '1. Run\n   ```ts\n   const a = 1\n   ```\n   Done.\n2. Next',
    '> note\n>\n> **important**',
    '|a|b|\n|-|-|\n|x|y|',
    '[label](https://example.com "title") and ![alt](image.png)',
    '```mermaid\nflowchart TD\n A --> B\n```',
    '~~~latex\n\\frac{a}{b}\n~~~',
    '## Approximate\n~100 items and ~~text~~.',
    String.raw`Literal \(hello world\) and \[old, new\] or \(unclosed.`,
    'Before\n\\[old, new\\]\nAfter',
    String.raw`Path C:\work\(folder\) and ordinary \[label\].`,
  ]) assert.deepEqual(lex(source), previous.lexer(source), source)
})

test('the terminal instance does not register tokens in global Marked', () => {
  lex('$x^2$\n\n$$\ny_1\n$$')
  assert.equal(marked.lexer('$x^2$')[0].tokens[0].type, 'text')
  assert.equal(marked.parse('$x^2$', { async: false }), '<p>$x^2$</p>\n')
})

test('the plain-text optimization recognizes every math opener anywhere', () => {
  for (const formula of ['$x$', '$$x$$', String.raw`\(x\)`, String.raw`\[x\]`]) {
    assert.equal(runtime.hasTerminalMarkdownSyntax('a'.repeat(2000) + ' ' + formula), true)
  }
  assert.equal(runtime.hasTerminalMarkdownSyntax('plain words'), false)
})

test('every streaming prefix reaches the same math as a completed message', () => {
  for (const source of [
    'Intro.\n\n$$\n\\frac{a+b}{c}\n\n+ x^2\n$$\n\n## Done\n\nEnd.',
    'Intro.\n\n\\[\n\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}\n\\]\n\nDone.',
    'Intro.\n\n- $$\n  x^2\n  $$\n\nDone.',
    '> \\[\n> x^2\n> \\]\n\nDone.',
    'Code:\n\n```latex\n$x^2$\n```\n\nMath: $x^2$.\n\nDone.',
    'Before\n\n$$x^2$$\n\nAfter',
    'Before\n$$\nx^2\n$$\nAfter\n\nDone.',
    'Before\n\\[old, new\\]\nAfter\n\nDone.',
  ]) {
    let prefix = ''
    for (let i = 1; i <= source.length; i++) {
      const chunk = source.slice(0, i)
      prefix = stable(chunk, prefix)
      assert.ok(chunk.startsWith(prefix))
      assert.equal(flatten(lex(prefix)).filter(t => t.type.startsWith('terminalMath') && !t.complete).length, 0,
        `incomplete formula frozen at ${i}: ${JSON.stringify(prefix)}`)
    }
    assert.deepEqual([...values(prefix), ...values(source.slice(prefix.length))], values(source), source)
  }
  assert.equal(stable('replacement', 'old content'), '')
})

test('unclosed displays recover before subsequent Markdown', () => {
  for (const suffix of ['## Heading', '- item', '```js\nx\n```', '| a |\n|---|']) {
    const tokens = lex('$$\nx^2\n\n' + suffix)
    assert.ok(tokens.length > 1, suffix)
    assert.equal(tokens[0].complete, false)
    assert.ok(tokens[0].raw.includes('x^2'))
  }
  const tokens = lex('$$\nx^2\n\n```sh\n$$\n```\n\n## After')
  assert.ok(tokens.some(t => t.type === 'code'), 'a closer in code cannot absorb a fence')
})

test('long delimiter-heavy input stays within a bounded rendering budget', { timeout: 10000 }, () => {
  for (const input of [
    '$ '.repeat(10000), '\\('.repeat(10000), '\\['.repeat(10000),
    '$' + '{'.repeat(20000) + '$', '$$\n' + 'x\n'.repeat(10000),
  ]) assert.ok(lex(input).length)
  const oversized = '$' + '**x** '.repeat(2000) + 'y$'
  const token = mathTokens(oversized)[0]
  assert.equal(token.raw, oversized)
  assert.equal(math(token.text), null)
})

test('bounded malformed-input fuzz remains deterministic and never throws', { timeout: 10000 }, () => {
  let seed = 20102026
  const chars = '\\{}[]()$^_&% abc0123'
  for (let n = 0; n < 1500; n++) {
    let input = ''
    for (let j = 0; j < 80; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      input += chars[seed % chars.length]
    }
    const first = math(input)
    assert.equal(math(input), first)
    const tokens = lex(`before $${input}$ after`)
    assert.ok(tokens.length)
  }
})
