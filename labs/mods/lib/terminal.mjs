// The CLI in a real pseudo-terminal (ConPTY on Windows), read back through a
// headless terminal emulator: the screen the lab checks is the one you see.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))

export function startTerminal({ cli, args, cwd, env, columns = 150, rows = 45 }) {
  const pty = require('node-pty')
  const { Terminal } = require('@xterm/headless')
  const term = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 4000 })
  const child = pty.spawn(process.execPath, [cli, ...args], { name: 'xterm-256color', cols: columns, rows, cwd, env })
  let exited = false
  child.onData(data => term.write(data))
  term.onData(data => child.write(data))
  child.onExit(() => { exited = true })
  const screen = () => {
    const buffer = term.buffer.active, lines = []
    for (let y = buffer.baseY; y < buffer.baseY + rows; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
    return lines.join('\n')
  }
  return {
    screen,
    get exited() { return exited },
    /** Whether `pattern` shows on screen within `ms`. */
    async waitFor(pattern, ms = 15_000) {
      const end = Date.now() + ms
      while (Date.now() < end && !exited) {
        if (pattern.test(screen())) return true
        await delay(100)
      }
      return pattern.test(screen())
    },
    async press(data, pause = 300) { child.write(data); await delay(pause) },
    async type(text, pause = 40) { for (const char of text) { child.write(char); await delay(pause) } },
    /** A line typed at the prompt, then Enter. */
    async submit(text) { await this.type(text); await delay(250); await this.press('\r', 600) },
    async waitExit(ms = 20_000) {
      const end = Date.now() + ms
      while (!exited && Date.now() < end) await delay(100)
      return exited
    },
    kill() { try { child.kill() } catch {} },
  }
}
