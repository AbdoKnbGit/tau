import type { PowerMode } from './powerMode.js'
import type { Theme, ThemeName } from './theme.js'

/**
 * Power-mode theme accents.
 *
 * Cheap mode softly bronzes the signature surfaces (wordmark, prompt bar,
 * Claude accents) and full-power mode gilds them; normal mode leaves the
 * user's theme untouched.
 * Only accent slots are overridden — text, borders, backgrounds, and semantic
 * colors keep full readability in every theme.
 *
 * Switching modes cross-fades the accent slots. The blend is computed here
 * from wall-clock time; the ThemeProvider drives re-renders (~30fps) while a
 * transition is active and stops when it settles, so idle cost is zero.
 * This is purely presentational: nothing here touches requests, tools, or
 * prompt-cache state.
 */

const MODE_ACCENT_SLOTS = [
  'brand',
  'brandDim',
  'brandBright',
  'claude',
  'claudeShimmer',
  'primary',
  'secondary',
  'accent',
] as const

type ModeAccentSlot = (typeof MODE_ACCENT_SLOTS)[number]

type ModeAccentOverlay = Record<ModeAccentSlot, string>

type OverlayFamily = 'dark' | 'light' | 'darkAnsi' | 'lightAnsi'

/** Soft bronze — muted copper-browns, calm rather than saturated. */
const BRONZE_OVERLAYS: Record<OverlayFamily, ModeAccentOverlay> = {
  dark: {
    brand: 'rgb(191,149,110)',
    brandDim: 'rgb(133,104,78)',
    brandBright: 'rgb(222,184,146)',
    claude: 'rgb(205,170,136)',
    claudeShimmer: 'rgb(228,198,166)',
    primary: 'rgb(205,170,136)',
    secondary: 'rgb(168,138,110)',
    accent: 'rgb(222,184,146)',
  },
  light: {
    brand: 'rgb(139,98,61)',
    brandDim: 'rgb(174,143,113)',
    brandBright: 'rgb(117,79,45)',
    claude: 'rgb(150,108,68)',
    claudeShimmer: 'rgb(178,140,100)',
    primary: 'rgb(150,108,68)',
    secondary: 'rgb(160,124,88)',
    accent: 'rgb(129,90,54)',
  },
  darkAnsi: {
    brand: 'ansi:yellow',
    brandDim: 'ansi:yellow',
    brandBright: 'ansi:yellowBright',
    claude: 'ansi:yellow',
    claudeShimmer: 'ansi:yellowBright',
    primary: 'ansi:yellow',
    secondary: 'ansi:yellow',
    accent: 'ansi:yellowBright',
  },
  lightAnsi: {
    brand: 'ansi:yellow',
    brandDim: 'ansi:yellow',
    brandBright: 'ansi:yellow',
    claude: 'ansi:yellow',
    claudeShimmer: 'ansi:yellow',
    primary: 'ansi:yellow',
    secondary: 'ansi:yellow',
    accent: 'ansi:yellow',
  },
}

/** Soft gold — warm champagne golds, gentle on dark and light bases. */
const GOLD_OVERLAYS: Record<OverlayFamily, ModeAccentOverlay> = {
  dark: {
    brand: 'rgb(212,178,106)',
    brandDim: 'rgb(148,124,74)',
    brandBright: 'rgb(240,210,140)',
    claude: 'rgb(224,194,124)',
    claudeShimmer: 'rgb(244,220,158)',
    primary: 'rgb(224,194,124)',
    secondary: 'rgb(190,160,100)',
    accent: 'rgb(240,210,140)',
  },
  light: {
    brand: 'rgb(158,124,34)',
    brandDim: 'rgb(186,160,96)',
    brandBright: 'rgb(136,104,24)',
    claude: 'rgb(168,132,40)',
    claudeShimmer: 'rgb(192,158,72)',
    primary: 'rgb(168,132,40)',
    secondary: 'rgb(172,140,60)',
    accent: 'rgb(146,112,28)',
  },
  darkAnsi: {
    brand: 'ansi:yellowBright',
    brandDim: 'ansi:yellow',
    brandBright: 'ansi:yellowBright',
    claude: 'ansi:yellowBright',
    claudeShimmer: 'ansi:yellowBright',
    primary: 'ansi:yellowBright',
    secondary: 'ansi:yellow',
    accent: 'ansi:yellowBright',
  },
  lightAnsi: {
    brand: 'ansi:yellow',
    brandDim: 'ansi:yellow',
    brandBright: 'ansi:yellow',
    claude: 'ansi:yellow',
    claudeShimmer: 'ansi:yellow',
    primary: 'ansi:yellow',
    secondary: 'ansi:yellow',
    accent: 'ansi:yellow',
  },
}

function overlayFamilyFor(themeName: ThemeName): OverlayFamily {
  const light = themeName.startsWith('light')
  const ansi = themeName.endsWith('-ansi')
  if (ansi) return light ? 'lightAnsi' : 'darkAnsi'
  return light ? 'light' : 'dark'
}

function overlayFor(
  mode: PowerMode,
  themeName: ThemeName,
): ModeAccentOverlay | null {
  if (mode === 'cheap') return BRONZE_OVERLAYS[overlayFamilyFor(themeName)]
  if (mode === 'full') return GOLD_OVERLAYS[overlayFamilyFor(themeName)]
  return null
}

// ---------------------------------------------------------------------------
// Module state — the active mode and (optionally) an in-flight cross-fade.
// ---------------------------------------------------------------------------

export const POWER_MODE_THEME_TRANSITION_MS = 900

/**
 * The "from" side of a transition. Usually a plain mode, but when a switch
 * interrupts a running transition the from-side is the exact blend that was
 * on screen at that instant (a→b at t), so the new fade starts without a jump.
 */
type BlendSource = { a: PowerMode; b: PowerMode; t: number }

type ModeThemeTransition = {
  from: BlendSource
  to: PowerMode
  startedAt: number
  durationMs: number
}

let currentMode: PowerMode = 'normal'
let transition: ModeThemeTransition | null = null
let initialized = false

const listeners = new Set<() => void>()

/** Notifies the ThemeProvider that a transition started (so it can tick). */
export function subscribePowerModeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // Listeners are UI re-render kicks; never let one break the others.
    }
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function transitionProgress(now: number): number {
  if (!transition) return 1
  if (transition.durationMs <= 0) return 1
  return Math.min(1, (now - transition.startedAt) / transition.durationMs)
}

/**
 * One-time seed from persisted settings so the very first frame renders with
 * the mode's palette (no flash). Later calls are no-ops; /mode uses
 * setPowerModeTheme.
 */
export function initializePowerModeTheme(mode: PowerMode): void {
  if (initialized) return
  initialized = true
  currentMode = mode
  transition = null
}

/**
 * Switch the active mode palette, cross-fading the accent slots.
 * Animation is time-based; the provider re-renders while
 * isPowerModeThemeTransitionActive() stays true.
 */
export function setPowerModeTheme(
  mode: PowerMode,
  options?: { animate?: boolean; durationMs?: number },
): void {
  initialized = true
  const animate = options?.animate ?? true
  if (mode === currentMode && !transition) {
    return
  }

  if (!animate) {
    currentMode = mode
    transition = null
    emit()
    return
  }

  const now = Date.now()
  // Interrupting a running fade: freeze its on-screen blend as the new
  // origin so back-to-back /mode switches never visibly jump. (For a fade
  // that started from a pure mode this is exact; for a double interrupt
  // it's a close approximation.)
  const from: BlendSource = transition
    ? {
        a: transition.from.b,
        b: transition.to,
        t: easeInOutCubic(transitionProgress(now)),
      }
    : { a: currentMode, b: currentMode, t: 0 }

  currentMode = mode
  transition = {
    from,
    to: mode,
    startedAt: now,
    durationMs: options?.durationMs ?? POWER_MODE_THEME_TRANSITION_MS,
  }
  emit()
}

export function getPowerModeThemeMode(): PowerMode {
  return currentMode
}

export function isPowerModeThemeTransitionActive(): boolean {
  if (!transition) return false
  if (transitionProgress(Date.now()) >= 1) {
    transition = null
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

function parseRgb(value: string): [number, number, number] | null {
  const match = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/)
  if (!match) return null
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ]
}

/** Lerp two theme colors; non-rgb values (ANSI names) snap at the midpoint. */
function mixColors(fromColor: string, toColor: string, t: number): string {
  if (fromColor === toColor) return toColor
  const from = parseRgb(fromColor)
  const to = parseRgb(toColor)
  if (!from || !to) {
    return t < 0.5 ? fromColor : toColor
  }
  const r = Math.round(from[0] + (to[0] - from[0]) * t)
  const g = Math.round(from[1] + (to[1] - from[1]) * t)
  const b = Math.round(from[2] + (to[2] - from[2]) * t)
  return `rgb(${r},${g},${b})`
}

// ---------------------------------------------------------------------------
// Wordmark palette — the animated "tau" logo draws from five color roles.
// Single source of truth for all modes (TauWordmark imports from here) so the
// logo cross-fades on /mode in lockstep with the accent slots: the wordmark
// samples this every animation frame, and the same wall-clock transition
// drives both.
// ---------------------------------------------------------------------------

export type WordmarkRgb = { r: number; g: number; b: number }

export type WordmarkPalette = {
  /** Left edge of the horizontal body gradient. */
  bodyLeft: WordmarkRgb
  /** Right edge of the horizontal body gradient. */
  bodyRight: WordmarkRgb
  /** Dark relief cells under the glyphs. */
  shadow: WordmarkRgb
  /** Ripple/pulse tint target. */
  primary: WordmarkRgb
  /** Brightest crest color for wave peaks and click flashes. */
  peak: WordmarkRgb
}

/** Normal mode — the wordmark's original grey→off-white design. */
const WORDMARK_NORMAL: WordmarkPalette = {
  bodyLeft: { r: 108, g: 108, b: 104 },
  bodyRight: { r: 235, g: 235, b: 226 },
  shadow: { r: 34, g: 35, b: 38 },
  primary: { r: 244, g: 244, b: 236 },
  peak: { r: 255, g: 255, b: 255 },
}

/** Cheap mode — soft bronze, same luminance ramp as the grey original. */
const WORDMARK_BRONZE: WordmarkPalette = {
  bodyLeft: { r: 122, g: 95, b: 72 },
  bodyRight: { r: 226, g: 191, b: 152 },
  shadow: { r: 40, g: 33, b: 27 },
  primary: { r: 238, g: 212, b: 178 },
  peak: { r: 255, g: 240, b: 216 },
}

/** Full-power mode — soft gold, same luminance ramp as the grey original. */
const WORDMARK_GOLD: WordmarkPalette = {
  bodyLeft: { r: 138, g: 112, b: 60 },
  bodyRight: { r: 240, g: 213, b: 140 },
  shadow: { r: 42, g: 36, b: 23 },
  primary: { r: 248, g: 227, b: 166 },
  peak: { r: 255, g: 246, b: 214 },
}

function wordmarkFor(mode: PowerMode): WordmarkPalette {
  if (mode === 'cheap') return WORDMARK_BRONZE
  if (mode === 'full') return WORDMARK_GOLD
  return WORDMARK_NORMAL
}

function mixRgb(a: WordmarkRgb, b: WordmarkRgb, t: number): WordmarkRgb {
  if (t <= 0) return a
  if (t >= 1) return b
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  }
}

function mixWordmark(
  a: WordmarkPalette,
  b: WordmarkPalette,
  t: number,
): WordmarkPalette {
  if (t <= 0) return a
  if (t >= 1) return b
  return {
    bodyLeft: mixRgb(a.bodyLeft, b.bodyLeft, t),
    bodyRight: mixRgb(a.bodyRight, b.bodyRight, t),
    shadow: mixRgb(a.shadow, b.shadow, t),
    primary: mixRgb(a.primary, b.primary, t),
    peak: mixRgb(a.peak, b.peak, t),
  }
}

/**
 * Wordmark palette for the current mode, blended through any in-flight
 * /mode cross-fade. `snap: true` skips the blend and returns the target
 * palette immediately (prefers-reduced-motion).
 */
export function getPowerModeWordmarkPalette(options?: {
  snap?: boolean
}): WordmarkPalette {
  if (options?.snap || !isPowerModeThemeTransitionActive() || !transition) {
    return wordmarkFor(currentMode)
  }
  const progress = easeInOutCubic(transitionProgress(Date.now()))
  const fromPalette = mixWordmark(
    wordmarkFor(transition.from.a),
    wordmarkFor(transition.from.b),
    transition.from.t,
  )
  return mixWordmark(fromPalette, wordmarkFor(transition.to), progress)
}

// ---------------------------------------------------------------------------
// Theme application (called from getTheme on every resolve — keep it cheap)
// ---------------------------------------------------------------------------

const overlayCache = new Map<string, Theme>()
const OVERLAY_CACHE_MAX = 128

function slotValue(
  base: Theme,
  themeName: ThemeName,
  mode: PowerMode,
  slot: ModeAccentSlot,
): string {
  const overlay = overlayFor(mode, themeName)
  return overlay ? overlay[slot] : base[slot]
}

/**
 * Apply the power-mode accent overlay (and any in-flight cross-fade) to a
 * resolved theme. Fast path: normal mode with no transition returns the base
 * theme object untouched.
 */
export function applyPowerModeTheme(base: Theme, themeName: ThemeName): Theme {
  const active = isPowerModeThemeTransitionActive()
  if (!active && currentMode === 'normal') {
    return base
  }

  const now = Date.now()
  const progress = active ? easeInOutCubic(transitionProgress(now)) : 1
  // Quantize the animation for cache hits within a render pass (~1% steps).
  const frame = active ? Math.round(progress * 100) : -1
  const fromKey =
    active && transition
      ? `${transition.from.a}>${transition.from.b}@${transition.from.t.toFixed(2)}`
      : 'idle'
  const cacheKey = `${themeName}|${currentMode}|${fromKey}|${frame}`
  const cached = overlayCache.get(cacheKey)
  if (cached) return cached

  const patch: Partial<Record<ModeAccentSlot, string>> = {}
  for (const slot of MODE_ACCENT_SLOTS) {
    const targetValue = slotValue(base, themeName, currentMode, slot)
    if (active && transition) {
      const fromValue = mixColors(
        slotValue(base, themeName, transition.from.a, slot),
        slotValue(base, themeName, transition.from.b, slot),
        transition.from.t,
      )
      patch[slot] = mixColors(fromValue, targetValue, progress)
    } else {
      patch[slot] = targetValue
    }
  }

  const result: Theme = { ...base, ...patch }
  if (overlayCache.size >= OVERLAY_CACHE_MAX) {
    overlayCache.clear()
  }
  overlayCache.set(cacheKey, result)
  return result
}
