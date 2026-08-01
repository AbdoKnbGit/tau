import { execa } from 'execa'
import memoize from 'lodash-es/memoize.js'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { which } from './which.js'

/**
 * Reads the raw bytes of an image sitting on the system clipboard.
 *
 * Three backends, picked by platform:
 *
 *   macOS         osascript writes the PNG pasteboard flavor to a temp file.
 *   Windows, WSL  powershell.exe returns the bytes as base64 on stdout.
 *   Linux         xclip / wl-paste write the image target to a temp file.
 *
 * WSL runs the Windows backend first. process.platform is 'linux' there, so
 * it used to land on xclip/wl-paste, which cannot see the Windows clipboard
 * the user actually copied into (and usually aren't installed at all) - that
 * is why Ctrl+V only ever worked on macOS. Handing the bytes back on stdout,
 * rather than through a temp file like the other two backends, keeps us out
 * of Windows/Linux path translation: PowerShell never has to name a file
 * that the Linux side can also open.
 */

const SCREENSHOT_FILENAME = 'claude_cli_latest_screenshot.png'

// powershell.exe costs ~300ms warm; give it room without ever letting a
// wedged interop call hang the paste.
const POWERSHELL_READ_TIMEOUT_MS = 15_000
const POWERSHELL_CHECK_TIMEOUT_MS = 8_000
const WSLPATH_TIMEOUT_MS = 5_000
// A 4K screenshot is ~10MB of PNG, so ~14MB of base64. 64MB leaves headroom
// for a copied file without letting a pathological one blow up the heap.
const POWERSHELL_MAX_BUFFER = 64 * 1024 * 1024
// Files larger than this are skipped rather than base64'd through a pipe.
const CLIPBOARD_FILE_MAX_BYTES = 40 * 1024 * 1024

const IMAGE_TARGETS = 'image/(png|jpeg|jpg|gif|webp|bmp)'

function getScreenshotPath(): string {
  // CLAUDE_CODE_TMPDIR wins; otherwise os.tmpdir(), which already resolves
  // TMPDIR/TEMP/TMP per platform rather than assuming /tmp exists and is
  // writable.
  return join(process.env.CLAUDE_CODE_TMPDIR || tmpdir(), SCREENSHOT_FILENAME)
}

type ShellClipboardCommands = {
  /** Exits zero only when the clipboard holds an image. */
  checkImage: string
  /** Writes the image to screenshotPath. Must exit non-zero when there is none. */
  saveImage: string
  deleteFile: string
}

/**
 * Commands for the two platforms that go through a temp file. Windows has no
 * entry: it reads the clipboard in-process via PowerShell.
 */
function getShellClipboardCommands(
  screenshotPath: string,
): ShellClipboardCommands {
  if (process.platform === 'darwin') {
    return {
      checkImage: `osascript -e 'the clipboard as «class PNGf»'`,
      saveImage: `osascript -e 'set png_data to (the clipboard as «class PNGf»)' -e 'set fp to open for access POSIX file "${screenshotPath}" with write permission' -e 'write png_data to fp' -e 'close access fp'`,
      deleteFile: `rm -f "${screenshotPath}"`,
    }
  }
  return {
    checkImage: `xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "${IMAGE_TARGETS}" || wl-paste -l 2>/dev/null | grep -E "${IMAGE_TARGETS}"`,
    saveImage: `xclip -selection clipboard -t image/png -o > "${screenshotPath}" 2>/dev/null || wl-paste --type image/png > "${screenshotPath}" 2>/dev/null || xclip -selection clipboard -t image/bmp -o > "${screenshotPath}" 2>/dev/null || wl-paste --type image/bmp > "${screenshotPath}"`,
    deleteFile: `rm -f "${screenshotPath}"`,
  }
}

const LINUX_CLIPBOARD_TEXT_COMMAND =
  'xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste 2>/dev/null'

const hasLinuxClipboardTool = memoize(async (): Promise<boolean> => {
  return Boolean((await which('xclip')) || (await which('wl-paste')))
})

/**
 * Command that prints the clipboard's text contents, used to resolve a
 * dragged-in filename against the file that was actually copied.
 */
export function getClipboardTextCommand(): string {
  switch (getPlatform()) {
    case 'macos':
      return `osascript -e 'get POSIX path of (the clipboard as «class furl»)'`
    case 'windows':
      return 'powershell -NoProfile -Command "Get-Clipboard"'
    case 'wsl':
      return `${LINUX_CLIPBOARD_TEXT_COMMAND} || powershell.exe -NoProfile -Command "Get-Clipboard"`
    default:
      return LINUX_CLIPBOARD_TEXT_COMMAND
  }
}

// ---------------------------------------------------------------------------
// PowerShell backend (Windows and WSL)
// ---------------------------------------------------------------------------

/**
 * -EncodedCommand takes UTF-16LE base64, which sidesteps every layer of
 * quoting between here and PowerShell's parser: no shell, no cmd, no argv
 * escaping to get wrong.
 */
function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Emits the clipboard image as base64 on stdout, or exits 1 when there is
 * none. Covers both shapes a Windows clipboard image comes in:
 *
 *  1. A bitmap (screenshot, Snipping Tool, "Copy image" in a browser).
 *  2. An image file copied in Explorer. Reading it here rather than handing
 *     back a path means WSL never has to translate a Windows path into
 *     wherever that distro happens to mount the drive.
 *
 * [Console]::Out.Write bypasses PowerShell's formatter, which would otherwise
 * hard-wrap the payload at the host's line width.
 */
export function buildClipboardImageScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Drawing',
    '$img = Get-Clipboard -Format Image',
    'if ($null -ne $img) {',
    '  $ms = New-Object System.IO.MemoryStream',
    '  try {',
    '    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '    [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))',
    '  } finally { $ms.Dispose(); $img.Dispose() }',
    '  exit 0',
    '}',
    // An empty clipboard makes Get-Clipboard emit a bare $null, so @() wraps
    // it into a one-element array. Skip the nulls instead of counting.
    'foreach ($f in @(Get-Clipboard -Format FileDropList)) {',
    '  if ($null -eq $f) { continue }',
    "  if ($f.Extension -notmatch '^\\.(png|jpe?g|gif|webp|bmp)$') { continue }",
    `  if ($f.Length -le 0 -or $f.Length -gt ${CLIPBOARD_FILE_MAX_BYTES}) { continue }`,
    '  [Console]::Out.Write([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($f.FullName)))',
    '  exit 0',
    '}',
    'exit 1',
  ].join('\n')
}

/** Same detection as buildClipboardImageScript, without moving the bytes. */
export function buildClipboardImageCheckScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'if ($null -ne (Get-Clipboard -Format Image)) { exit 0 }',
    'foreach ($f in @(Get-Clipboard -Format FileDropList)) {',
    '  if ($null -eq $f) { continue }',
    "  if ($f.Extension -match '^\\.(png|jpe?g|gif|webp|bmp)$') { exit 0 }",
    '}',
    'exit 1',
  ].join('\n')
}

/**
 * Windows PowerShell 5.1 specifically: pwsh 7 dropped `Get-Clipboard -Format`
 * and defaults to an MTA thread, which cannot touch the clipboard at all.
 */
const resolvePowerShellBinary = memoize(async (): Promise<string | null> => {
  const found = await which('powershell.exe')
  if (found) return found

  // PATH lookup covers all but one case: WSL configured with
  // `appendWindowsPath=false`, where interop still works and the Windows PATH
  // simply isn't listed. Nothing about the layout can be assumed there - the
  // drive mount root is configurable (/mnt is only the default) - so ask
  // wslpath, which is part of WSL itself, where the path actually lives.
  const fs = getFsImplementation()
  const WINDOWS_POWERSHELL =
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

  if (getPlatform() === 'wsl') {
    const translated = await execFileNoThrowWithCwd(
      'wslpath',
      ['-u', WINDOWS_POWERSHELL],
      { timeout: WSLPATH_TIMEOUT_MS, stdin: 'ignore' },
    )
    const path = translated.code === 0 ? translated.stdout.trim() : ''
    if (path && fs.existsSync(path)) return path
    return null
  }

  // Native Windows: SystemRoot is set by the OS itself, so this only falls
  // back to the literal on a badly broken environment.
  const fallback = process.env.SystemRoot
    ? join(
        process.env.SystemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
    : WINDOWS_POWERSHELL
  return fs.existsSync(fallback) ? fallback : null
})

/**
 * Windows cannot chdir into the WSL filesystem, so inheriting the session's
 * Linux cwd makes powershell.exe complain about UNC paths before it runs.
 * The directory the binary itself sits in is Windows-visible by definition,
 * whatever the distro mounts drives at, so it needs no hardcoded path.
 */
function getPowerShellCwd(binary: string): string | undefined {
  return getPlatform() === 'wsl' ? dirname(binary) : undefined
}

async function runPowerShell(
  script: string,
  timeout: number,
): Promise<{ code: number; stdout: string } | null> {
  const binary = await resolvePowerShellBinary()
  if (!binary) {
    logForDebugging('clipboard: powershell.exe not found', { level: 'warn' })
    return null
  }
  const result = await execFileNoThrowWithCwd(
    binary,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShellCommand(script),
    ],
    {
      timeout,
      cwd: getPowerShellCwd(binary),
      maxBuffer: POWERSHELL_MAX_BUFFER,
      // Never let a Windows child touch the TUI's stdin.
      stdin: 'ignore',
      preserveOutputOnError: false,
    },
  )
  return { code: result.code, stdout: result.stdout }
}

async function readClipboardImageViaPowerShell(): Promise<Buffer | null> {
  const result = await runPowerShell(
    buildClipboardImageScript(),
    POWERSHELL_READ_TIMEOUT_MS,
  )
  if (!result || result.code !== 0) return null
  // The payload arrives as one unwrapped line; strip whitespace anyway in
  // case a host inserts any.
  const base64 = result.stdout.replace(/\s+/g, '')
  if (!base64) return null
  return Buffer.from(base64, 'base64')
}

// ---------------------------------------------------------------------------
// Temp-file backend (macOS and Linux)
// ---------------------------------------------------------------------------

async function readClipboardImageViaTempFile(): Promise<Buffer | null> {
  if (process.platform === 'win32') return null

  const screenshotPath = getScreenshotPath()
  const commands = getShellClipboardCommands(screenshotPath)
  const fs = getFsImplementation()

  // Clear any leftover from a previous paste first. Both command sets create
  // the target file through shell redirection even when they go on to fail,
  // so without this a save that found nothing could hand back the last image
  // that was pasted.
  await execa(commands.deleteFile, { shell: true, reject: false })

  // No separate check pass: both saveImage commands already exit non-zero
  // when the clipboard holds no image, and the check costs a whole extra
  // osascript/xclip spawn (~700ms on macOS).
  const saveResult = await execa(commands.saveImage, {
    shell: true,
    reject: false,
  })
  if (saveResult.exitCode !== 0) return null

  try {
    const buffer = fs.readFileBytesSync(screenshotPath)
    return buffer.length > 0 ? buffer : null
  } catch {
    return null
  } finally {
    void execa(commands.deleteFile, { shell: true, reject: false })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Magic-byte check. A clipboard helper that fails halfway can leave an error
 * string or a truncated file behind, and every consumer downstream would
 * treat those bytes as a PNG and let the API reject them.
 */
export function looksLikeImageBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false
  // PNG
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.subarray(0, 8).equals(PNG_MAGIC)) return true
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true
  // GIF87a / GIF89a
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') return true
  // BMP (converted to PNG downstream)
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true
  // WEBP
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return true
  }
  return false
}

/**
 * Raw bytes of the clipboard image, or null when there is nothing to paste.
 * Format is whatever the platform produced (PNG for a bitmap, the file's own
 * format for a copied file); callers detect it from the magic bytes.
 */
export async function readClipboardImageBytes(): Promise<Buffer | null> {
  const platform = getPlatform()

  if (platform === 'windows' || platform === 'wsl') {
    const bytes = await readClipboardImageViaPowerShell()
    if (bytes) {
      return looksLikeImageBuffer(bytes) ? bytes : null
    }
    // Native Windows has nowhere else to look. WSL keeps going, but only if
    // a Linux clipboard tool is actually installed: an image copied inside a
    // Linux GUI app under WSLg lands on the X/Wayland clipboard, which the
    // Windows side cannot see. Most WSL setups have neither tool, and there
    // is no point spawning a shell to find that out on every paste.
    if (platform === 'windows') return null
    if (!(await hasLinuxClipboardTool())) return null
  }

  const bytes = await readClipboardImageViaTempFile()
  if (!bytes) return null
  if (!looksLikeImageBuffer(bytes)) {
    logForDebugging('clipboard: image payload had no recognizable header', {
      level: 'warn',
    })
    return null
  }
  return bytes
}

/**
 * Whether the clipboard holds an image, without moving the bytes. Used for
 * the "Image in clipboard" hint, so it must stay cheap.
 */
export async function hasClipboardImage(): Promise<boolean> {
  const platform = getPlatform()

  if (platform === 'windows' || platform === 'wsl') {
    const result = await runPowerShell(
      buildClipboardImageCheckScript(),
      POWERSHELL_CHECK_TIMEOUT_MS,
    )
    if (result?.code === 0) return true
    if (platform === 'windows') return false
    if (!(await hasLinuxClipboardTool())) return false
  }

  if (process.platform === 'win32') return false
  const commands = getShellClipboardCommands(getScreenshotPath())
  const result = await execa(commands.checkImage, {
    shell: true,
    reject: false,
  })
  return result.exitCode === 0
}

/**
 * Whether this platform has any chance of producing a clipboard image, so
 * paste handling can skip the probe entirely where it cannot work (a bare
 * SSH session on Linux, say). Sync and cheap: it runs on the paste path.
 */
export const isClipboardImageSupported = memoize((): boolean => {
  switch (getPlatform()) {
    case 'macos':
    case 'windows':
    case 'wsl':
      return true
    case 'linux':
      // No display means no clipboard for xclip/wl-paste to read. X11
      // forwarding sets DISPLAY too, and there xclip really does reach the
      // local machine's clipboard.
      return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
    default:
      return false
  }
})

/**
 * One-line explanation when the platform has no working clipboard backend at
 * all, so "no image found" can say what to install instead of leaving the
 * user guessing. Null when a backend exists and the clipboard was simply
 * empty. Probed once per session.
 */
export const getClipboardImageSetupHint = memoize(
  async (): Promise<string | null> => {
    try {
      return await describeMissingClipboardBackend()
    } catch {
      // This only ever feeds a notification; never reject, or the memo
      // caches a rejected promise for the rest of the session.
      return null
    }
  },
)

async function describeMissingClipboardBackend(): Promise<string | null> {
  switch (getPlatform()) {
    case 'macos':
      return null
    case 'windows':
      return (await resolvePowerShellBinary())
        ? null
        : 'powershell.exe was not found on PATH, so the clipboard cannot be read.'
    case 'wsl':
      if (await resolvePowerShellBinary()) return null
      if (await hasLinuxClipboardTool()) return null
      return 'Reading the Windows clipboard needs powershell.exe. Enable WSL interop, or install xclip / wl-clipboard.'
    case 'linux':
      if (!isClipboardImageSupported()) {
        return 'No display detected (DISPLAY / WAYLAND_DISPLAY unset), so there is no clipboard to read.'
      }
      return (await hasLinuxClipboardTool())
        ? null
        : 'Install xclip (X11) or wl-clipboard (Wayland) to paste images from the clipboard.'
    default:
      return null
  }
}
