/**
 * Clipboard image backend tests.
 *
 * The PowerShell scripts are built as strings and handed to a process we
 * can't introspect, so the shape of those strings is the contract. Two of
 * the assertions below encode bugs that are easy to reintroduce:
 *
 *  - Output must go through [Console]::Out.Write. PowerShell's formatter
 *    hard-wraps long strings at the host width, which corrupts base64.
 *  - Get-Clipboard emits a bare $null on an empty clipboard, so @() wraps it
 *    into a ONE-element array. Counting it reports an image that isn't there;
 *    the scripts have to skip nulls instead.
 *
 * Run: bun run src/utils/clipboardImage.test.ts
 * Live round trip against the real clipboard (Windows only, overwrites it):
 *   CLIPBOARD_E2E=1 bun run src/utils/clipboardImage.test.ts
 */

import {
  buildClipboardImageCheckScript,
  buildClipboardImageScript,
  isClipboardImageSupported,
  looksLikeImageBuffer,
  readClipboardImageBytes,
} from './clipboardImage.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.then(
        () => {
          passed++
          console.log(`  ok  ${name}`)
        },
        (e: unknown) => {
          failed++
          console.log(`  FAIL ${name}: ${String(e)}`)
        },
      )
    }
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}: ${String(e)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ])
}

async function main(): Promise<void> {
  console.log('clipboardImage')

  test('read script handles clipboard bitmaps', () => {
    const script = buildClipboardImageScript()
    assert(script.includes('Get-Clipboard -Format Image'), 'missing bitmap read')
    assert(
      script.includes('[System.Drawing.Imaging.ImageFormat]::Png'),
      'bitmap must be encoded as PNG',
    )
  })

  test('read script handles image files copied in Explorer', () => {
    const script = buildClipboardImageScript()
    assert(
      script.includes('Get-Clipboard -Format FileDropList'),
      'missing copied-file read',
    )
    assert(
      script.includes('[System.IO.File]::ReadAllBytes'),
      'copied files must be read as bytes, not handed back as a Windows path',
    )
    assert(/\$f\.Length -gt \d+/.test(script), 'copied files need a size cap')
  })

  test('read script writes base64 without the formatter', () => {
    const script = buildClipboardImageScript()
    assert(
      script.includes('[Console]::Out.Write([Convert]::ToBase64String'),
      'payload must bypass PowerShell formatting (it wraps long lines)',
    )
    assert(!/Write-(Output|Host)/.test(script), 'no formatted output allowed')
  })

  test('scripts skip the null Get-Clipboard emits for an empty clipboard', () => {
    for (const script of [
      buildClipboardImageScript(),
      buildClipboardImageCheckScript(),
    ]) {
      assert(
        script.includes('if ($null -eq $f) { continue }'),
        'FileDropList loop must skip nulls',
      )
      assert(!script.includes('.Count'), 'counting a $null array reports a phantom image')
    }
  })

  test('scripts report "nothing to paste" as a non-zero exit', () => {
    assert(buildClipboardImageScript().endsWith('exit 1'), 'read must exit 1')
    assert(buildClipboardImageCheckScript().endsWith('exit 1'), 'check must exit 1')
  })

  test('check script never moves the bytes', () => {
    assert(
      !buildClipboardImageCheckScript().includes('ToBase64String'),
      'the hint probe must stay cheap',
    )
  })

  test('scripts only accept extensions the API can take', () => {
    for (const script of [
      buildClipboardImageScript(),
      buildClipboardImageCheckScript(),
    ]) {
      assert(script.includes('png|jpe?g|gif|webp|bmp'), 'unexpected extension set')
      assert(!/tiff?/.test(script), 'TIFF is not a supported media type')
    }
  })

  test('looksLikeImageBuffer accepts every format a backend can produce', () => {
    assert(looksLikeImageBuffer(png()), 'PNG')
    assert(
      looksLikeImageBuffer(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)])),
      'JPEG',
    )
    assert(looksLikeImageBuffer(Buffer.from('GIF89a' + 'x'.repeat(16))), 'GIF')
    assert(looksLikeImageBuffer(Buffer.from('BM' + 'x'.repeat(16))), 'BMP')
    assert(
      looksLikeImageBuffer(Buffer.from('RIFF' + '1234' + 'WEBP' + 'x'.repeat(8))),
      'WEBP',
    )
  })

  test('looksLikeImageBuffer rejects what a failed helper leaves behind', () => {
    assert(!looksLikeImageBuffer(Buffer.alloc(0)), 'empty file')
    assert(!looksLikeImageBuffer(Buffer.from('Error: target not available')), 'xclip error text')
    assert(!looksLikeImageBuffer(Buffer.from([0x89, 0x50])), 'truncated header')
  })

  await test('no machine-specific paths are baked into the module', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      fileURLToPath(new URL('./clipboardImage.ts', import.meta.url)),
      'utf8',
    )
    assert(
      !source.includes('/mnt/'),
      'WSL drive mount roots are configurable (/mnt is only the default) - ask wslpath instead',
    )
    assert(
      !/['"`]\/(home|Users)\//.test(source),
      'no user-specific paths',
    )
    assert(
      !/['"`]\/tmp/.test(source),
      'temp dir must come from os.tmpdir(), which resolves TMPDIR/TEMP/TMP',
    )
    // One absolute Windows path is allowed: the System32 location handed to
    // wslpath for translation, used only when SystemRoot/PATH give nothing.
    const windowsLiterals = source.match(/'[A-Za-z]:\\\\[^']*'/g) ?? []
    assert(
      windowsLiterals.length === 1,
      `expected exactly one Windows path literal, found ${windowsLiterals.length}: ${windowsLiterals.join(', ')}`,
    )
  })

  await test('the clipboard backend stays out of the request path', async () => {
    // Cache safety: anything that runs while a request is being serialized can
    // shift an already-cached prompt prefix. Clipboard reads are UI-event only,
    // and the bytes they produce are frozen into the message at paste time.
    const { readdirSync, readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { join } = await import('node:path')
    const srcDir = fileURLToPath(new URL('..', import.meta.url))
    const offenders: string[] = []
    for (const area of ['lanes', 'services/api', 'query']) {
      let files: string[]
      try {
        files = readdirSync(join(srcDir, area), { recursive: true }) as string[]
      } catch {
        continue // area may not exist in every checkout
      }
      for (const file of files) {
        if (!/\.tsx?$/.test(String(file))) continue
        const full = join(srcDir, area, String(file))
        if (readFileSync(full, 'utf8').includes('clipboardImage.js')) {
          offenders.push(`${area}/${file}`)
        }
      }
    }
    assert(
      offenders.length === 0,
      `request-path code must not read the clipboard: ${offenders.join(', ')}`,
    )
  })

  test('clipboard support is decided per platform, not just macOS', () => {
    const supported = isClipboardImageSupported()
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert(supported, 'macOS and Windows always have a clipboard backend')
    } else {
      // Linux and WSL: only claimed when there is something to read from.
      assert(typeof supported === 'boolean', 'must resolve to a boolean')
    }
  })

  if (process.env.CLIPBOARD_E2E === '1' && process.platform === 'win32') {
    await test('live: reads a bitmap off the real Windows clipboard', async () => {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const run = promisify(execFile)
      const setup = [
        'Add-Type -AssemblyName System.Drawing, System.Windows.Forms',
        '$bmp = New-Object System.Drawing.Bitmap 300, 200',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$g.Clear([System.Drawing.Color]::Teal)',
        '$g.Dispose()',
        '[System.Windows.Forms.Clipboard]::SetImage($bmp)',
        '$bmp.Dispose()',
      ].join('\n')
      await run('powershell.exe', [
        '-NoProfile',
        '-EncodedCommand',
        Buffer.from(setup, 'utf16le').toString('base64'),
      ])

      const bytes = await readClipboardImageBytes()
      assert(bytes !== null, 'clipboard bitmap was not read back')
      assert(looksLikeImageBuffer(bytes!), 'bytes are not a recognizable image')
      assert(bytes!.readUInt32BE(16) === 300, 'wrong width')
      assert(bytes!.readUInt32BE(20) === 200, 'wrong height')
    })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
