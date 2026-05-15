type NutModule = typeof import('@computer-use/nut-js')
type NutKey = Parameters<NutModule['keyboard']['pressKey']>[0]

export type DesktopScreenshot = {
  base64: string
  width: number
  height: number
  logicalWidth: number
  logicalHeight: number
  physicalWidth: number
  physicalHeight: number
  scaleFactor: number
  mediaType: 'image/jpeg' | 'image/png'
}

export type DesktopScreenshotOptions = {
  fixedHeight?: number
  fixedWidth?: number
  format?: 'jpeg' | 'png'
  jpegQuality?: number
  maxHeight?: number
  maxWidth?: number
}

export type MouseButtonName = 'left' | 'middle' | 'right'
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

let nutPromise: Promise<NutModule> | undefined

async function getNut(): Promise<NutModule> {
  nutPromise ??= import('@computer-use/nut-js').catch(err => {
    nutPromise = undefined
    throw new Error(
      'Computer tool requires optional dependency @computer-use/nut-js. Install it in the same environment to enable desktop control.',
      { cause: err },
    )
  })
  return nutPromise
}

function normalizePoint(value: number): number {
  return Math.max(0, Math.round(value))
}

function normalizeDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(60_000, Math.round(value)))
}

function normalizeImageLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

function getTargetSize(args: {
  fixedHeight?: number
  fixedWidth?: number
  height: number
  maxHeight: number
  maxWidth: number
  width: number
}): { height: number; width: number } {
  if (args.fixedHeight !== undefined && args.fixedWidth !== undefined) {
    return {
      height: Math.max(1, Math.round(args.fixedHeight)),
      width: Math.max(1, Math.round(args.fixedWidth)),
    }
  }

  const scale = Math.min(
    1,
    args.maxWidth / args.width,
    args.maxHeight / args.height,
  )
  return {
    height: Math.max(1, Math.round(args.height * scale)),
    width: Math.max(1, Math.round(args.width * scale)),
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  const durationMs = normalizeDelayMs(ms)
  if (durationMs === 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(signal.reason)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, durationMs)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function configureMouse(nut: NutModule): void {
  nut.mouse.config.mouseSpeed = 3600
}

async function moveTo(nut: NutModule, x: number, y: number): Promise<void> {
  await nut.mouse.move(
    nut.straightTo(new nut.Point(normalizePoint(x), normalizePoint(y))),
  )
}

function buttonFromName(nut: NutModule, button: MouseButtonName) {
  switch (button) {
    case 'right':
      return nut.Button.RIGHT
    case 'middle':
      return nut.Button.MIDDLE
    case 'left':
    default:
      return nut.Button.LEFT
  }
}

function splitKeyString(key: string): string[] {
  return key
    .trim()
    .toLowerCase()
    .replace(/page\s+down/g, 'pagedown')
    .replace(/page\s+up/g, 'pageup')
    .replace(/arrow\s+up/g, 'arrowup')
    .replace(/arrow\s+down/g, 'arrowdown')
    .replace(/arrow\s+left/g, 'arrowleft')
    .replace(/arrow\s+right/g, 'arrowright')
    .split(/[\s+]+/)
    .filter(Boolean)
}

function resolveKey(nut: NutModule, key: string): NutKey {
  const platformCommandKey =
    process.platform === 'darwin' ? nut.Key.LeftCmd : nut.Key.LeftWin
  const platformShortcutKey =
    process.platform === 'darwin' ? nut.Key.LeftCmd : nut.Key.LeftControl

  const aliases: Record<string, NutKey> = {
    alt: nut.Key.LeftAlt,
    arrowdown: nut.Key.Down,
    arrowleft: nut.Key.Left,
    arrowright: nut.Key.Right,
    arrowup: nut.Key.Up,
    backspace: nut.Key.Backspace,
    cmd: platformCommandKey,
    command: platformCommandKey,
    control: platformShortcutKey,
    ctrl: platformShortcutKey,
    del: nut.Key.Delete,
    delete: nut.Key.Delete,
    enter: nut.Key.Enter,
    esc: nut.Key.Escape,
    escape: nut.Key.Escape,
    meta: platformCommandKey,
    mod: platformShortcutKey,
    option: nut.Key.LeftAlt,
    pagedown: nut.Key.PageDown,
    pageup: nut.Key.PageUp,
    return: nut.Key.Enter,
    shift: nut.Key.LeftShift,
    space: nut.Key.Space,
    super: platformCommandKey,
    tab: nut.Key.Tab,
    win: platformCommandKey,
    windows: platformCommandKey,
    ',': nut.Key.Comma,
    '.': nut.Key.Period,
    '/': nut.Key.Slash,
    '\\': nut.Key.Backslash,
    '-': nut.Key.Minus,
    '=': nut.Key.Equal,
    ';': nut.Key.Semicolon,
    "'": nut.Key.Quote,
    '`': nut.Key.Grave,
    '0': nut.Key.Num0,
    '1': nut.Key.Num1,
    '2': nut.Key.Num2,
    '3': nut.Key.Num3,
    '4': nut.Key.Num4,
    '5': nut.Key.Num5,
    '6': nut.Key.Num6,
    '7': nut.Key.Num7,
    '8': nut.Key.Num8,
    '9': nut.Key.Num9,
  }
  if (aliases[key] !== undefined) return aliases[key]

  const enumKey = Object.entries(nut.Key).find(
    ([name, value]) => name.toLowerCase() === key && typeof value === 'number',
  )
  if (enumKey) return enumKey[1] as NutKey

  if (/^[a-z]$/.test(key)) {
    return nut.Key[key.toUpperCase() as keyof NutModule['Key']] as NutKey
  }

  throw new Error(`Unsupported keyboard key: ${key}`)
}

export function normalizeHotkeyInput(input: {
  key?: string
  keys?: string[]
}): string[] {
  if (input.keys?.length) return input.keys.flatMap(splitKeyString)
  if (input.key) return splitKeyString(input.key)
  return []
}

export async function takeDesktopScreenshot(
  options: DesktopScreenshotOptions = {},
): Promise<DesktopScreenshot> {
  const nut = await getNut()
  const grabbedImage = await nut.screen.grab()
  const rgbImage = await grabbedImage.toRGB()
  const scaleX = rgbImage.pixelDensity.scaleX || 1
  const scaleY = rgbImage.pixelDensity.scaleY || 1
  const logicalWidth = Math.round(rgbImage.width / scaleX)
  const logicalHeight = Math.round(rgbImage.height / scaleY)
  const target = getTargetSize({
    fixedHeight:
      options.fixedHeight === undefined
        ? undefined
        : normalizeImageLimit(options.fixedHeight, 1000),
    fixedWidth:
      options.fixedWidth === undefined
        ? undefined
        : normalizeImageLimit(options.fixedWidth, 1000),
    height: logicalHeight,
    maxHeight: normalizeImageLimit(options.maxHeight, 768),
    maxWidth: normalizeImageLimit(options.maxWidth, 1024),
    width: logicalWidth,
  })
  const image = nut.imageToJimp(rgbImage)
  const resized = image.resize(target.width, target.height)
  const mediaType = options.format === 'png' ? 'image/png' : 'image/jpeg'
  if (mediaType === 'image/jpeg' && typeof resized.quality === 'function') {
    resized.quality(options.jpegQuality ?? 70)
  }
  const imageBuffer = await resized.getBufferAsync(mediaType)

  return {
    base64: imageBuffer.toString('base64'),
    height: target.height,
    logicalHeight,
    logicalWidth,
    mediaType,
    physicalWidth: rgbImage.width,
    physicalHeight: rgbImage.height,
    scaleFactor: scaleX,
    width: target.width,
  }
}

export async function moveMouse(x: number, y: number): Promise<void> {
  const nut = await getNut()
  configureMouse(nut)
  await moveTo(nut, x, y)
}

export async function clickMouse(args: {
  x: number
  y: number
  button: MouseButtonName
  double?: boolean
}): Promise<void> {
  const nut = await getNut()
  configureMouse(nut)
  await moveTo(nut, args.x, args.y)
  await abortableDelay(100)
  const button = buttonFromName(nut, args.button)
  if (args.double) {
    await nut.mouse.doubleClick(button)
  } else {
    await nut.mouse.click(button)
  }
}

export async function dragMouse(args: {
  fromX: number
  fromY: number
  toX: number
  toY: number
}): Promise<void> {
  const nut = await getNut()
  configureMouse(nut)
  await moveTo(nut, args.fromX, args.fromY)
  await abortableDelay(100)
  await nut.mouse.drag(
    nut.straightTo(new nut.Point(normalizePoint(args.toX), normalizePoint(args.toY))),
  )
}

export async function typeText(args: {
  text: string
  submit?: boolean
  viaClipboard?: boolean
}): Promise<void> {
  const nut = await getNut()
  const text = args.text.replace(/\\n$/, '').replace(/\n$/, '')
  const shouldSubmit =
    args.submit === true || args.text.endsWith('\n') || args.text.endsWith('\\n')
  const previousDelayMs = nut.keyboard.config.autoDelayMs
  nut.keyboard.config.autoDelayMs = 0

  try {
    if (process.platform === 'win32' && args.viaClipboard !== false) {
      const originalClipboard = await nut.clipboard.getContent()
      try {
        await nut.clipboard.setContent(text)
        await nut.keyboard.pressKey(nut.Key.LeftControl, nut.Key.V)
        await abortableDelay(50)
        await nut.keyboard.releaseKey(nut.Key.LeftControl, nut.Key.V)
      } finally {
        await abortableDelay(50)
        await nut.clipboard.setContent(originalClipboard)
      }
    } else {
      await nut.keyboard.type(text)
    }

    if (shouldSubmit) {
      await nut.keyboard.pressKey(nut.Key.Enter)
      await nut.keyboard.releaseKey(nut.Key.Enter)
    }
  } finally {
    nut.keyboard.config.autoDelayMs = previousDelayMs
  }
}

export async function pressHotkey(keys: string[]): Promise<void> {
  if (keys.length === 0) {
    throw new Error('Hotkey requires at least one key.')
  }
  const nut = await getNut()
  const resolvedKeys = keys.map(key => resolveKey(nut, key.toLowerCase()))
  await nut.keyboard.pressKey(...resolvedKeys)
  await nut.keyboard.releaseKey(...resolvedKeys)
}

export async function scrollDesktop(args: {
  x?: number
  y?: number
  direction: ScrollDirection
  amount: number
}): Promise<void> {
  const nut = await getNut()
  configureMouse(nut)
  if (args.x !== undefined && args.y !== undefined) {
    await moveTo(nut, args.x, args.y)
  }

  switch (args.direction) {
    case 'up':
      await nut.mouse.scrollUp(args.amount)
      break
    case 'down':
      await nut.mouse.scrollDown(args.amount)
      break
    case 'left':
      await nut.mouse.scrollLeft(args.amount)
      break
    case 'right':
      await nut.mouse.scrollRight(args.amount)
      break
  }
}

export async function waitForDesktop(
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await abortableDelay(durationMs, signal)
}
