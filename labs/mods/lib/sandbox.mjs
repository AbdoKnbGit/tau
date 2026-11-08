// The lab's folder: a workspace the session runs in, its own config (so the
// tier lists, prependPlugins and appendPlugins, are the lab's), and the lab
// mods copied in. Offline runs also get their own home and a fake sign-in, so
// they can never read or change your real account.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MODS = join(here, '..', 'mods')
const FIXTURE_KEY = 'sk-ant-lab-fixture-key-mods-0000000001'
export const LAB_MODEL = 'claude-sonnet-4-6'

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

/** A short chime: 0.3 s at 660 Hz, then 990 Hz, as a 16-bit mono WAV. */
function chime() {
  const rate = 16000, samples = Math.floor(rate * 0.3)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const frequency = i < samples / 2 ? 660 : 990
    const fade = 1 - i / samples
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * frequency) * 9000 * fade), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * The lab's folder. `root` is where (a throwaway folder when left out);
 * `offline` plays the model and the sign-in; `fakeAudio` stands a recorder in
 * for every player and synthesizer, so a run makes no sound.
 */
export function createLab({ root, offline = true, provider, model, fakeAudio = false } = {}) {
  if (root) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    mkdirSync(root, { recursive: true })
  }
  // The long form: on Windows TEMP can be an 8.3 path.
  const base = realpathSync.native(root ?? mkdtempSync(join(tmpdir(), 'tau-mod-lab-')))
  const workspace = join(base, 'workspace'), config = join(base, 'config'), home = join(base, 'home')
  const plugins = join(base, 'plugins')
  for (const name of readdirSync(MODS)) cpSync(join(MODS, name), join(plugins, name), { recursive: true })
  write(join(plugins, 'lab-app', 'sounds', 'chime.wav'), chime())
  write(join(workspace, 'notes.txt'), 'The lab notes: pineapple is the first word here.\n')
  write(join(workspace, 'LAB.md'), '# Mod lab\n\nfs.ancestors reads this file.\n')
  write(join(workspace, 'secret', 'README.txt'), 'lab-org keeps this folder closed to the other mods\' writes.\n')
  mkdirSync(join(workspace, '.lab'), { recursive: true })

  const projects = { [workspace.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }
  write(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', theme: 'dark',
    activeProvider: offline ? 'firstParty' : (provider ?? 'firstParty'),
    ...(offline ? { customApiKeyResponses: { approved: [FIXTURE_KEY.slice(-20)], rejected: [] } } : {}),
    projects,
  }, null, 2))
  // The organization's tier and the append tier: a person's own settings may
  // set them when no managed settings exist.
  write(join(config, 'settings.json'), JSON.stringify({
    prependPlugins: ['lab-org@inline'],
    appendPlugins: ['lab-tail@inline'],
    ...(model ? { model } : {}),
  }, null, 2))

  const record = join(base, 'model-requests.jsonl')
  const played = join(base, 'played.jsonl')
  let env
  if (offline) {
    env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|CI$|ENABLE_TOOL_SEARCH|NODE_PATH$|NODE_OPTIONS$|NODE_ENV$|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(name)))
    // Answers the CLI's background update check at once.
    const stubBin = join(base, 'bin')
    write(join(stubBin, 'npm.cmd'), '@echo off\r\necho 0.0.0\r\n')
    write(join(stubBin, 'npm'), '#!/bin/sh\necho 0.0.0\n')
    chmodSync(join(stubBin, 'npm'), 0o755)
    const pathName = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathName] = `${stubBin}${delimiter}${env[pathName] ?? ''}`
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: join(base, 'appdata'), LOCALAPPDATA: join(base, 'localappdata'), XDG_CONFIG_HOME: join(home, '.config'),
      ANTHROPIC_API_KEY: FIXTURE_KEY,
      NODE_OPTIONS: `--import=${pathToFileURL(join(here, 'fake-model.mjs')).href}`,
      TAU_LAB_RECORD: record, TAU_LAB_OFFLINE: '1',
    })
  } else {
    // Your normal sign-in for the provider (it lives in your home folder),
    // with the lab's own settings: your active provider is neither read nor changed.
    env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(CLAUDECODE$|CLAUDE_CODE_(?!OAUTH_TOKEN)|TAU_|NODE_OPTIONS$|NODE_PATH$|CI$|ANTHROPIC_API_KEY$)/i.test(name)))
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(base, 'cache'),
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', TAU_SKIP_PREFLIGHT: '1',
    ENABLE_TOOL_SEARCH: 'false', FORCE_COLOR: '1',
  })
  if (offline) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  if (fakeAudio) {
    const player = join(base, 'player.cjs')
    write(player, `const fs = require('fs')
const [kind, a, b] = process.argv.slice(2)
let input = ''
const done = () => {
  fs.appendFileSync(${JSON.stringify(played)}, JSON.stringify(kind === 'play' ? { kind, file: a, gain: Number(b) } : { kind, voice: a, text: input }) + '\\n')
  setTimeout(() => process.exit(0), 40)
}
if (kind === 'speak') { process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { input += c }); process.stdin.on('end', done) } else done()
`)
    env.TAU_TEST_AUDIO_COMMAND = JSON.stringify([process.execPath, player])
  }

  const order = ['lab-org', 'lab-app', 'lab-ui', 'lab-stream', 'lab-tail', 'lab-refused']
  // A real provider answers with its own default model unless one is named.
  const args = [...order.flatMap(name => ['--plugin-dir', join(plugins, name)]), ...(offline || model ? ['--model', model ?? LAB_MODEL] : [])]
  return {
    root: base, workspace, config, plugins, record, played, env, args,
    remove() { try { rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {} },
  }
}
