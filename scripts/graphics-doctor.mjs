#!/usr/bin/env node
/**
 * Inline-image diagnostics.
 *
 *   node scripts/graphics-doctor.mjs
 *
 * Answers, for the terminal it is run in, the one question the transcript
 * cannot: when an image renders as block glyphs instead of pixels, *which* of
 * the several gates between "read a PNG" and "write a sixel" closed.
 *
 * Every check prints its own verdict, and the last section draws real output —
 * a sixel, a row of quadrant glyphs, a row of half blocks — so a terminal that
 * answers a capability query but cannot actually render the result is caught
 * too. That is not hypothetical: the Windows console host reports Unicode
 * support and then draws `?` for every quadrant, because the fonts it ships do
 * not contain U+2596..U+259F.
 *
 * Run it in a plain terminal tab, not inside Tau — it puts stdin in raw mode.
 */

import fs from 'node:fs'
import process from 'node:process'
import tty from 'node:tty'

/**
 * A handle on the controlling terminal, even when stdio is redirected.
 *
 * Without this the queries below are skipped whenever the script is piped —
 * through `| head`, or through a coding agent's shell tool — and a skipped
 * query is indistinguishable from a terminal that refused to answer.
 * `/dev/tty` on POSIX and `CONIN$`/`CONOUT$` on Windows reach the console
 * directly, so the answers come back either way.
 */
function openControllingTerminal() {
  const [inPath, outPath] =
    process.platform === 'win32'
      ? ['CONIN$', 'CONOUT$']
      : ['/dev/tty', '/dev/tty']
  let inFd = null
  let outFd = null
  try {
    inFd = fs.openSync(inPath, 'r+')
    outFd = inPath === outPath ? inFd : fs.openSync(outPath, 'r+')
    const input = new tty.ReadStream(inFd)
    const output = new tty.WriteStream(outFd)
    if (!input.isTTY || !output.isTTY) throw new Error('not a console')
    return {
      input,
      output,
      close() {
        try { input.destroy() } catch {}
        if (outFd !== inFd) { try { output.destroy() } catch {} }
      },
    }
  } catch {
    for (const fd of new Set([inFd, outFd])) {
      if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    }
    return null
  }
}

/** Grid as the controlling terminal reports it, which stdout may not know. */
let probeGrid = null

const OUT = process.stdout
const ESC = '\x1b'
const bold = s => `${ESC}[1m${s}${ESC}[0m`
const dim = s => `${ESC}[2m${s}${ESC}[0m`
const ok = s => `${ESC}[32m${s}${ESC}[0m`
const bad = s => `${ESC}[31m${s}${ESC}[0m`
const warn = s => `${ESC}[33m${s}${ESC}[0m`

function line(label, value, verdict) {
  const mark = verdict === true ? ok('  ok  ') : verdict === false ? bad(' fail ') : dim('  --  ')
  OUT.write(`${mark} ${label.padEnd(28)} ${value}\n`)
}

// ── 1. Environment ──────────────────────────────────────────────────────────

OUT.write(`\n${bold('1. Environment')}\n`)
const env = process.env
line('platform', process.platform)
line('TERM', env.TERM ?? dim('(unset)'))
line('TERM_PROGRAM', env.TERM_PROGRAM ?? dim('(unset)'))
line('WT_SESSION', env.WT_SESSION ? 'set (Windows Terminal)' : dim('(unset)'))
line('MSYSTEM', env.MSYSTEM ?? dim('(unset)'))
line('multiplexer', env.TMUX || env.STY ? warn('tmux/screen — unsupported') : 'none', !(env.TMUX || env.STY))
line(
  'stdout.isTTY',
  OUT.isTTY === true ? 'true' : dim('false — output is redirected'),
  OUT.isTTY === true,
)
for (const name of ['TAU_IMAGE_PROTOCOL', 'TAU_INLINE_IMAGE_GLYPHS', 'TAU_INLINE_IMAGE_ROWS', 'NO_COLOR']) {
  if (env[name]) line(`${name} (override)`, warn(env[name]))
}

// ── 2. Terminal queries ─────────────────────────────────────────────────────

/**
 * Write the queries, then read replies until DA1 comes back or the deadline
 * passes. DA1 is the sentinel every terminal since the VT100 answers, so a
 * reply that has not arrived by then is one the terminal does not implement.
 */
async function probe(timeoutMs = 1500) {
  const direct =
    OUT.isTTY && process.stdin.isTTY
      ? { input: process.stdin, output: OUT, close() {} }
      : openControllingTerminal()
  if (direct === null) return null

  const { input, output, close } = direct
  const wasRaw = input.isRaw
  let buf = ''
  const onData = chunk => {
    buf += chunk.toString('latin1')
  }
  try {
    input.setRawMode?.(true)
    input.resume()
    input.on('data', onData)

    // Cell size, window size, then the sentinel — terminals answer in order,
    // and DA1 is the one every terminal since the VT100 answers, so anything
    // still missing when it lands is genuinely unsupported.
    output.write(`${ESC}[16t${ESC}[14t${ESC}[c`)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !/\x1b\[\??[0-9;]*c/.test(buf)) {
      await new Promise(r => setTimeout(r, 20))
    }
  } finally {
    input.off('data', onData)
    try { input.setRawMode?.(wasRaw === true) } catch {}
    try { input.pause() } catch {}
    if (input !== process.stdin) close()
  }
  probeGrid = { columns: output.columns, rows: output.rows }
  return buf
}

OUT.write(`\n${bold('2. Terminal capability queries')}\n`)
const replies = await probe()
const grid = probeGrid ?? { columns: OUT.columns, rows: OUT.rows }
line('grid', grid.columns ? `${grid.columns} x ${grid.rows}` : dim('unknown'))
let da1Params = null
let cell = null
let windowPx = null

if (replies === null) {
  line('queries', bad('could not reach a terminal'), false)
  OUT.write(
    `       ${warn('Nothing was asked, so nothing below is evidence about your')}` + '\n' +
      `       ${warn('terminal. Run this directly in the window you actually use:')}` + '\n' +
      `       ${bold('npm run graphics-doctor')}   ${dim('(no pipe, not inside Tau)')}` + '\n',
  )
} else {
  const da1 = /\x1b\[\?([0-9;]*)c/.exec(replies)
  if (da1) da1Params = da1[1].split(';').filter(Boolean).map(Number)
  const t16 = /\x1b\[6;(\d+);(\d+)t/.exec(replies)
  if (t16) cell = { height: Number(t16[1]), width: Number(t16[2]) }
  const t14 = /\x1b\[4;(\d+);(\d+)t/.exec(replies)
  if (t14) windowPx = { height: Number(t14[1]), width: Number(t14[2]) }

  line('DA1 (CSI c)', da1Params ? `[${da1Params.join(',')}]` : bad('no reply'), da1Params !== null)
  line(
    'sixel advertised (DA1 = 4)',
    da1Params?.includes(4) ? 'yes' : bad('no — this terminal has no sixel'),
    da1Params?.includes(4) === true,
  )
  line('cell size (CSI 16 t)', cell ? `${cell.width} x ${cell.height} px` : bad('no reply'), cell !== null)
  line(
    'window size (CSI 14 t)',
    windowPx ? `${windowPx.width} x ${windowPx.height} px` : warn('no reply'),
    windowPx !== null,
  )
  if (!cell && windowPx && grid.columns > 0 && grid.rows > 0) {
    const derived = {
      width: windowPx.width / grid.columns,
      height: windowPx.height / grid.rows,
    }
    line('cell size (derived)', `${derived.width.toFixed(1)} x ${derived.height.toFixed(1)} px`, true)
    cell = derived
  }
  if (!cell) {
    OUT.write(
      `       ${warn('Without a cell size nothing can be sized in pixels, so images')}\n` +
        `       ${warn('fall back to block glyphs. This is the usual cause.')}\n`,
    )
  }
}

// ── 3. Encoders ─────────────────────────────────────────────────────────────

OUT.write(`\n${bold('3. Encoders')}\n`)

let sharp = null
try {
  const mod = await import('sharp')
  sharp = typeof mod === 'function' ? mod : mod.default
  line('sharp', `${sharp.versions?.sharp ?? '?'} (libvips ${sharp.versions?.vips ?? '?'})`, true)
} catch (e) {
  line('sharp', bad(`not loadable — ${e.message.split('\n')[0]}`), false)
}

let image2sixel = null
try {
  ;({ image2sixel } = await import('sixel'))
  line('sixel encoder', 'loaded', true)
} catch (e) {
  line('sixel encoder', bad(`not loadable — ${e.message.split('\n')[0]}`), false)
  OUT.write(`       ${warn('Reinstall dependencies: npm install')}\n`)
}

let sixelSequence = null
if (sharp && image2sixel) {
  try {
    const w = 160
    const h = 80
    const raw = Buffer.alloc(w * h * 3)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3
        raw[i] = Math.round((x / w) * 255)
        raw[i + 1] = Math.round((y / h) * 255)
        raw[i + 2] = 140
      }
    }
    const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
    // Deliberately the same call chain the renderer uses: resize, raw, widen in
    // JS. `ensureAlpha()` is not used, so a pipeline that can produce raw
    // pixels at all can produce a sixel.
    const res = await sharp(png).resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
    const px = res.info.width * res.info.height
    const rgba = new Uint8Array(px * 4)
    for (let i = 0; i < px; i++) {
      const s = i * res.info.channels
      const d = i * 4
      rgba[d] = res.data[s]
      rgba[d + 1] = res.info.channels === 1 ? res.data[s] : res.data[s + 1]
      rgba[d + 2] = res.info.channels === 1 ? res.data[s] : res.data[s + 2]
      rgba[d + 3] = 255
    }
    sixelSequence = image2sixel(rgba, res.info.width, res.info.height, 256)
    line('encode a test image', `${sixelSequence.length} bytes of sixel`, true)
  } catch (e) {
    line('encode a test image', bad(e.message.split('\n')[0]), false)
  }
}

// ── 4. Verdict ──────────────────────────────────────────────────────────────

OUT.write(`\n${bold('4. Verdict')}\n`)
const forced = env.TAU_IMAGE_PROTOCOL?.trim().toLowerCase()
let protocol = 'none'
if (forced && forced !== 'off' && forced !== 'none' && forced !== '0') protocol = forced
else if (env.TMUX || env.STY) protocol = 'none'
else if (env.TERM_PROGRAM?.toLowerCase() === 'vscode') protocol = 'none'
else if (env.KITTY_WINDOW_ID || /kitty|ghostty/i.test(env.TERM ?? '')) protocol = 'kitty'
else if (env.TERM_PROGRAM === 'iTerm.app') protocol = 'iterm2'
else if (da1Params?.includes(4)) protocol = 'sixel'

if (replies === null) {
  OUT.write(`  ${warn('Inconclusive — the terminal was never asked.')} The encoder checks\n`)
  OUT.write(`  above still hold; nothing about protocol support does.\n`)
} else if (protocol === 'none') {
  OUT.write(`  ${bad('No graphics protocol.')} Images render as block glyphs, which is correct\n`)
  OUT.write(`  for this terminal. Try Windows Terminal 1.22+, kitty, Ghostty, WezTerm,\n`)
  OUT.write(`  foot, or iTerm2.\n`)
} else if (!cell) {
  OUT.write(`  ${bad(`${protocol} is available but the terminal will not report its cell size.`)}\n`)
  OUT.write(`  Pixels cannot be mapped to cells, so block glyphs stand in.\n`)
} else {
  OUT.write(`  ${ok(`${protocol} available, cell ${Math.floor(cell.width)}x${Math.floor(cell.height)} px.`)}\n`)
  OUT.write(`  Inline images should render as real pixels. If they do not, run\n`)
  OUT.write(`  ${bold('tau --debug')}, read an image, and look for the ${bold('graphics:')} lines —\n`)
  OUT.write(`  each names the gate that closed.\n`)
}

// ── 5. What this terminal actually draws ────────────────────────────────────

OUT.write(`\n${bold('5. Rendering — believe your eyes, not the table above')}\n\n`)

if (sixelSequence && protocol === 'sixel') {
  OUT.write(`  ${dim('sixel (should be a smooth colour gradient):')}\n`)
  OUT.write(sixelSequence)
  OUT.write('\n\n')
}

OUT.write(`  ${dim('quadrant glyphs — any `?` here means the font lacks U+2596..U+259F:')}\n`)
OUT.write('  ▘▝▖▗▀▄▌▐▚▞▙▛▜▟█\n\n')
OUT.write(`  ${dim('half blocks — these are in every monospace font:')}\n`)
OUT.write('  ▀▄█▀▄█▀▄█▀▄█▀▄█\n\n')
OUT.write(
  `  ${dim('If the first row shows `?` and the second does not, Tau is right to use')}\n` +
    `  ${dim('half blocks here. Set TAU_INLINE_IMAGE_GLYPHS=quadrant to override.')}\n\n`,
)

process.exit(0)
