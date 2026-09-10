import chalk, { Chalk } from 'chalk'
import { env } from './env.js'
import { applyPowerModeTheme } from './modeTheme.js'

export type Theme = {
  autoAccept: string
  bashBorder: string
  claude: string
  claudeShimmer: string // Lighter version of claude color for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: string
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: string
  permission: string
  permissionShimmer: string // Lighter version of permission color for shimmer effect
  planMode: string
  ide: string
  promptBorder: string
  promptBorderShimmer: string // Lighter version of promptBorder color for shimmer effect
  text: string
  inverseText: string
  inactive: string
  inactiveShimmer: string // Lighter version of inactive color for shimmer effect
  subtle: string
  suggestion: string
  remember: string
  background: string
  // Semantic colors
  success: string
  error: string
  warning: string
  merged: string
  warningShimmer: string // Lighter version of warning color for shimmer effect
  // Diff colors
  diffAdded: string
  diffRemoved: string
  diffAddedDimmed: string
  diffRemovedDimmed: string
  // Word-level diff highlighting
  diffAddedWord: string
  diffRemovedWord: string
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: string
  blue_FOR_SUBAGENTS_ONLY: string
  green_FOR_SUBAGENTS_ONLY: string
  yellow_FOR_SUBAGENTS_ONLY: string
  purple_FOR_SUBAGENTS_ONLY: string
  orange_FOR_SUBAGENTS_ONLY: string
  pink_FOR_SUBAGENTS_ONLY: string
  cyan_FOR_SUBAGENTS_ONLY: string
  // Grove colors
  professionalBlue: string
  // Chrome colors
  chromeYellow: string
  // TUI V2 colors
  clawd_body: string
  clawd_background: string
  userMessageBackground: string
  userMessageBackgroundHover: string
  /** Message-actions selection. Cool shift toward `suggestion` blue; distinct from default AND userMessageBackground. */
  messageActionsBackground: string
  /** Text-selection highlight background (alt-screen mouse selection). Solid
   *  bg that REPLACES the cell's bg while preserving its fg — matches native
   *  terminal selection. Previously SGR-7 inverse (swapped fg/bg per cell),
   *  which fragmented badly over syntax highlighting. */
  selectionBg: string
  bashMessageBackgroundColor: string

  memoryBackgroundColor: string
  rate_limit_fill: string
  rate_limit_empty: string
  fastMode: string
  fastModeShimmer: string
  // Brief/assistant mode label colors
  briefLabelYou: string
  briefLabelClaude: string
  // Rainbow colors for ultrathink keyword highlighting
  rainbow_red: string
  rainbow_orange: string
  rainbow_yellow: string
  rainbow_green: string
  rainbow_blue: string
  rainbow_indigo: string
  rainbow_violet: string
  rainbow_red_shimmer: string
  rainbow_orange_shimmer: string
  rainbow_yellow_shimmer: string
  rainbow_green_shimmer: string
  rainbow_blue_shimmer: string
  rainbow_indigo_shimmer: string
  rainbow_violet_shimmer: string

  // Shared UI palette slots.
  primary: string
  secondary: string
  accent: string
  info: string
  textMuted: string
  border: string
  borderActive: string
  borderSubtle: string
  backgroundPanel: string
  backgroundElement: string
  backgroundMenu: string
  // Metallic brand accents for the wordmark, prompt, and tool headers.
  brand: string
  brandDim: string
  brandBright: string
}

export const THEME_NAMES = ['dark', 'catppuccin-macchiato', 'light'] as const

/** A renderable theme. Always resolvable to a concrete color palette. */
export type ThemeName = (typeof THEME_NAMES)[number]

export const THEME_SETTINGS = ['auto', ...THEME_NAMES] as const

/**
 * A theme preference as stored in user config. `'auto'` follows the system
 * dark/light mode and is resolved to a ThemeName at runtime.
 */
export type ThemeSetting = (typeof THEME_SETTINGS)[number]

/**
 * Dark theme using explicit RGB values to avoid inconsistencies
 * from users' custom terminal ANSI color definitions
 */
const darkTheme: Theme = {
  autoAccept: 'rgb(190,130,255)', // Electric violet (saturated)
  bashBorder: 'rgb(255,95,205)', // Hot magenta neon
  claude: 'rgb(120,255,220)', // Electric cyan-mint (Tau signature)
  claudeShimmer: 'rgb(170,255,235)', // Brighter electric cyan shimmer
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(140,180,255)', // Electric cobalt for spinner hat
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(185,215,255)', // Bright electric blue shimmer
  permission: 'rgb(190,140,255)', // Electric violet
  permissionShimmer: 'rgb(220,180,255)', // Bright violet shimmer
  planMode: 'rgb(100,220,215)', // Electric teal
  ide: 'rgb(130,200,255)', // Bright electric blue
  promptBorder: 'rgb(120,130,180)', // Cool blue-gray
  promptBorderShimmer: 'rgb(170,180,230)', // Lighter cool blue
  text: 'rgb(255,255,255)', // White
  inverseText: 'rgb(0,0,0)', // Black
  inactive: 'rgb(150,155,175)', // Cool gray
  inactiveShimmer: 'rgb(190,195,215)', // Lighter cool gray
  subtle: 'rgb(75,78,95)', // Dark blue-gray
  suggestion: 'rgb(130,220,255)', // Electric sky blue
  remember: 'rgb(200,150,255)', // Electric lavender
  background: 'rgb(120,220,200)', // Neon mint
  success: 'rgb(80,240,160)', // Neon green
  error: 'rgb(255,80,140)', // Hot pink
  warning: 'rgb(255,200,60)', // Neon amber
  merged: 'rgb(190,130,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(255,225,110)', // Bright neon amber shimmer
  diffAdded: 'rgb(28,72,58)', // Deep teal-green
  diffRemoved: 'rgb(100,32,60)', // Deep magenta
  diffAddedDimmed: 'rgb(55,80,72)', // Dim teal
  diffRemovedDimmed: 'rgb(92,60,75)', // Dim magenta
  diffAddedWord: 'rgb(60,200,140)', // Bright teal-green
  diffRemovedWord: 'rgb(220,90,140)', // Bright magenta
  // Agent colors (neon variants)
  red_FOR_SUBAGENTS_ONLY: 'rgb(255,70,100)', // Neon red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(80,140,255)', // Neon blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(80,240,140)', // Neon green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(255,220,60)', // Neon yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(190,100,255)', // Neon purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,140,50)', // Neon orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,90,190)', // Neon pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(50,220,230)', // Neon cyan
  // Grove colors
  professionalBlue: 'rgb(120,170,230)',
  // Chrome colors
  chromeYellow: 'rgb(255,210,60)', // Neon chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(120,235,210)', // Electric cyan-mint ghost
  clawd_background: 'rgb(30,30,50)', // Deep midnight blue-black eyes
  userMessageBackground: 'rgb(40, 45, 62)', // Deep cool blue
  userMessageBackgroundHover: 'rgb(55, 62, 82)',
  messageActionsBackground: 'rgb(40, 46, 62)', // Deep cool blue
  selectionBg: 'rgb(45, 62, 95)', // Electric blue selection
  bashMessageBackgroundColor: 'rgb(50, 48, 64)', // Deep purple-gray

  memoryBackgroundColor: 'rgb(52, 42, 68)', // Deep violet
  rate_limit_fill: 'rgb(130,220,255)', // Electric sky blue
  rate_limit_empty: 'rgb(58,68,98)', // Deep cool blue
  fastMode: 'rgb(255,140,200)', // Hot pink (fast = zap!)
  fastModeShimmer: 'rgb(255,180,225)', // Bright hot pink shimmer
  briefLabelYou: 'rgb(130,200,255)', // Electric sky blue
  briefLabelClaude: 'rgb(120,235,210)', // Electric cyan-mint
  rainbow_red: 'rgb(255,85,130)',
  rainbow_orange: 'rgb(255,145,80)',
  rainbow_yellow: 'rgb(255,215,90)',
  rainbow_green: 'rgb(95,240,150)',
  rainbow_blue: 'rgb(100,200,255)',
  rainbow_indigo: 'rgb(150,120,255)',
  rainbow_violet: 'rgb(220,110,220)',
  rainbow_red_shimmer: 'rgb(255,155,180)',
  rainbow_orange_shimmer: 'rgb(255,190,140)',
  rainbow_yellow_shimmer: 'rgb(255,235,150)',
  rainbow_green_shimmer: 'rgb(165,250,195)',
  rainbow_blue_shimmer: 'rgb(170,225,255)',
  rainbow_indigo_shimmer: 'rgb(200,180,255)',
  rainbow_violet_shimmer: 'rgb(240,180,240)',
  // Shared UI slots for the base palette
  primary: 'rgb(120,255,220)', // claude electric cyan-mint
  secondary: 'rgb(140,180,255)', // claudeBlue cobalt
  accent: 'rgb(190,130,255)', // autoAccept electric violet
  info: 'rgb(130,200,255)', // ide bright electric blue
  textMuted: 'rgb(150,155,175)', // inactive
  border: 'rgb(120,130,180)', // promptBorder
  borderActive: 'rgb(170,180,230)', // promptBorderShimmer
  borderSubtle: 'rgb(75,78,95)', // subtle
  backgroundPanel: 'rgb(40,45,62)', // userMessageBackground
  backgroundElement: 'rgb(40,46,62)', // messageActionsBackground
  backgroundMenu: 'rgb(50,48,64)', // bashMessageBackgroundColor
  // Brand accent — soft monochrome grey→off-white (inherited by Tau dark)
  brand: 'rgb(156,156,163)',
  brandDim: 'rgb(104,104,112)',
  brandBright: 'rgb(204,204,209)',
}

/**
 * Tau default dark theme: a calm monochrome palette — near-black background,
 * zinc greys, soft-white text — where brightness (not hue) carries emphasis.
 * Easy on the eyes for long sessions; the wordmark renders its own grey→white
 * gradient. Same `dark` setting name for existing users.
 */
const tauDarkTheme: Theme = {
  ...darkTheme,
  autoAccept: 'rgb(230,230,234)',
  bashBorder: 'rgb(170,170,178)',
  claude: 'rgb(196,196,201)',
  claudeShimmer: 'rgb(214,214,218)',
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(158,158,166)',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(196,196,202)',
  permission: 'rgb(188,188,194)',
  permissionShimmer: 'rgb(208,208,213)',
  planMode: 'rgb(146,146,154)',
  ide: 'rgb(180,180,186)',
  promptBorder: 'rgb(78,80,88)',
  promptBorderShimmer: 'rgb(116,118,126)',
  text: 'rgb(206,206,210)',
  inverseText: 'rgb(12,12,14)',
  inactive: 'rgb(144,144,152)',
  inactiveShimmer: 'rgb(176,176,184)',
  subtle: 'rgb(48,48,54)',
  suggestion: 'rgb(162,162,170)',
  remember: 'rgb(180,180,186)',
  background: 'rgb(22,22,25)',
  success: 'rgb(138,176,116)',
  error: 'rgb(232,120,120)',
  warning: 'rgb(224,180,120)',
  merged: 'rgb(175,175,182)',
  warningShimmer: 'rgb(240,205,150)',
  diffAdded: 'rgb(30,46,38)',
  diffRemoved: 'rgb(52,32,34)',
  diffAddedDimmed: 'rgb(34,42,38)',
  diffRemovedDimmed: 'rgb(46,36,38)',
  diffAddedWord: 'rgb(120,190,130)',
  diffRemovedWord: 'rgb(220,120,120)',
  red_FOR_SUBAGENTS_ONLY: 'rgb(244,72,62)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(166,103,92)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(145,170,112)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(232,170,82)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(175,92,112)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(220,104,58)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(228,96,116)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(155,132,110)',
  professionalBlue: 'rgb(148,116,108)',
  chromeYellow: 'rgb(232,174,82)',
  clawd_body: 'rgb(210,210,216)',
  clawd_background: 'rgb(20,20,24)',
  userMessageBackground: 'rgb(28,28,32)',
  userMessageBackgroundHover: 'rgb(38,38,43)',
  messageActionsBackground: 'rgb(36,38,40)',
  selectionBg: 'rgb(48,52,56)',
  bashMessageBackgroundColor: 'rgb(26,28,30)',
  memoryBackgroundColor: 'rgb(30,30,34)',
  rate_limit_fill: 'rgb(200,200,206)',
  rate_limit_empty: 'rgb(46,48,55)',
  fastMode: 'rgb(210,210,216)',
  fastModeShimmer: 'rgb(240,240,243)',
  briefLabelYou: 'rgb(170,170,178)',
  briefLabelClaude: 'rgb(220,220,225)',
  rainbow_red: 'rgb(255,72,62)',
  rainbow_orange: 'rgb(225,116,72)',
  rainbow_yellow: 'rgb(232,170,82)',
  rainbow_green: 'rgb(160,120,88)',
  rainbow_blue: 'rgb(128,82,68)',
  rainbow_indigo: 'rgb(165,76,72)',
  rainbow_violet: 'rgb(210,82,88)',
  rainbow_red_shimmer: 'rgb(255,136,118)',
  rainbow_orange_shimmer: 'rgb(255,166,112)',
  rainbow_yellow_shimmer: 'rgb(255,204,126)',
  rainbow_green_shimmer: 'rgb(206,158,116)',
  rainbow_blue_shimmer: 'rgb(176,122,104)',
  rainbow_indigo_shimmer: 'rgb(214,118,112)',
  rainbow_violet_shimmer: 'rgb(244,132,140)',
  // Modern UI slots — soft monochrome zinc + off-white accent
  primary: 'rgb(196,196,201)', // soft off-white
  secondary: 'rgb(162,162,170)', // grey
  accent: 'rgb(206,206,211)', // off-white
  info: 'rgb(180,180,186)', // grey
  textMuted: 'rgb(140,140,148)', // zinc-400
  border: 'rgb(75,77,85)', // zinc
  borderActive: 'rgb(112,115,124)', // zinc
  borderSubtle: 'rgb(48,48,54)', // zinc-800
  backgroundPanel: 'rgb(24,24,27)', // zinc-900
  backgroundElement: 'rgb(32,32,36)', // zinc-850
  backgroundMenu: 'rgb(28,28,32)', // zinc
}


/** Labels shared by /theme and /config. Only three palettes are offered. */
export const THEME_LABELS: Record<ThemeSetting, string> = {
  auto: 'Auto (match terminal)',
  dark: 'Tau dark',
  'catppuccin-macchiato': 'Catppuccin Macchiato',
  light: 'Tau white',
}

/** Retired settings still load safely, without appearing in the picker. */
export function normalizeThemeSetting(value: unknown): ThemeSetting {
  if (typeof value === 'string' && (THEME_SETTINGS as readonly string[]).includes(value)) {
    return value as ThemeSetting
  }
  if (value === 'studio') return 'catppuccin-macchiato'
  if (value === 'light-ansi' || value === 'light-daltonized') return 'light'
  return 'dark'
}

/** Porcelain white, graphite type, and brushed-silver brand accents. */
const lightTheme: Theme = {
  ...tauDarkTheme,
  autoAccept: 'rgb(109,80,146)',
  bashBorder: 'rgb(139,98,61)',
  claude: 'rgb(82,89,102)',
  claudeShimmer: 'rgb(105,113,128)',
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(66,99,145)',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(92,116,154)',
  permission: 'rgb(66,99,145)',
  permissionShimmer: 'rgb(92,116,154)',
  planMode: 'rgb(38,113,112)',
  ide: 'rgb(66,99,145)',
  promptBorder: 'rgb(121,127,138)',
  promptBorderShimmer: 'rgb(92,99,112)',
  text: 'rgb(40,43,51)',
  inverseText: 'rgb(250,249,246)',
  inactive: 'rgb(101,106,117)',
  inactiveShimmer: 'rgb(119,125,137)',
  subtle: 'rgb(151,154,163)',
  suggestion: 'rgb(66,99,145)',
  remember: 'rgb(109,80,146)',
  background: 'rgb(250,249,246)',
  success: 'rgb(49,111,75)',
  error: 'rgb(170,57,72)',
  warning: 'rgb(139,103,30)',
  warningShimmer: 'rgb(156,116,38)',
  merged: 'rgb(109,80,146)',
  diffAdded: 'rgb(222,238,223)',
  diffRemoved: 'rgb(249,225,225)',
  diffAddedDimmed: 'rgb(233,241,231)',
  diffRemovedDimmed: 'rgb(247,235,232)',
  diffAddedWord: 'rgb(181,216,188)',
  diffRemovedWord: 'rgb(232,182,185)',
  red_FOR_SUBAGENTS_ONLY: 'rgb(170,57,72)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(66,99,145)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(49,111,75)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(139,103,30)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(109,80,146)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(151,82,42)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(150,72,121)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(38,113,112)',
  professionalBlue: 'rgb(66,99,145)',
  chromeYellow: 'rgb(139,103,30)',
  clawd_body: 'rgb(82,89,102)',
  clawd_background: 'rgb(250,249,246)',
  userMessageBackground: 'rgb(250,249,246)',
  userMessageBackgroundHover: 'rgb(237,237,235)',
  messageActionsBackground: 'rgb(223,228,236)',
  selectionBg: 'rgb(207,218,234)',
  bashMessageBackgroundColor: 'rgb(243,240,234)',
  memoryBackgroundColor: 'rgb(238,234,243)',
  rate_limit_fill: 'rgb(82,89,102)',
  rate_limit_empty: 'rgb(214,214,218)',
  fastMode: 'rgb(139,103,30)',
  fastModeShimmer: 'rgb(156,116,38)',
  briefLabelYou: 'rgb(101,106,117)',
  briefLabelClaude: 'rgb(82,89,102)',
  rainbow_red: 'rgb(170,57,72)',
  rainbow_orange: 'rgb(151,82,42)',
  rainbow_yellow: 'rgb(139,103,30)',
  rainbow_green: 'rgb(49,111,75)',
  rainbow_blue: 'rgb(66,99,145)',
  rainbow_indigo: 'rgb(109,80,146)',
  rainbow_violet: 'rgb(150,72,121)',
  rainbow_red_shimmer: 'rgb(186,72,84)',
  rainbow_orange_shimmer: 'rgb(166,96,54)',
  rainbow_yellow_shimmer: 'rgb(156,116,38)',
  rainbow_green_shimmer: 'rgb(63,126,88)',
  rainbow_blue_shimmer: 'rgb(80,114,159)',
  rainbow_indigo_shimmer: 'rgb(124,94,160)',
  rainbow_violet_shimmer: 'rgb(165,86,135)',
  primary: 'rgb(82,89,102)',
  secondary: 'rgb(101,106,117)',
  accent: 'rgb(139,103,30)',
  info: 'rgb(66,99,145)',
  textMuted: 'rgb(101,106,117)',
  border: 'rgb(151,154,163)',
  borderActive: 'rgb(92,99,112)',
  borderSubtle: 'rgb(214,214,218)',
  backgroundPanel: 'rgb(250,249,246)',
  backgroundElement: 'rgb(237,237,235)',
  backgroundMenu: 'rgb(243,242,239)',
  brand: 'rgb(92,99,112)',
  brandDim: 'rgb(121,127,138)',
  brandBright: 'rgb(67,74,87)',
}

/** Official Macchiato palette: https://catppuccin.com/palette/#macchiato
 * Tau's silver wordmark and the bronze/gold power-mode overlays stay metallic.
 */
const macchiatoTheme: Theme = {
  ...tauDarkTheme,
  autoAccept: 'rgb(198,160,246)',
  bashBorder: 'rgb(245,189,230)',
  claude: 'rgb(202,211,245)',
  claudeShimmer: 'rgb(244,219,214)',
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(138,173,244)',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(183,189,248)',
  permission: 'rgb(138,173,244)',
  permissionShimmer: 'rgb(183,189,248)',
  planMode: 'rgb(139,213,202)',
  ide: 'rgb(145,215,227)',
  promptBorder: 'rgb(110,115,141)',
  promptBorderShimmer: 'rgb(147,154,183)',
  text: 'rgb(202,211,245)',
  inverseText: 'rgb(36,39,58)',
  inactive: 'rgb(165,173,203)',
  inactiveShimmer: 'rgb(184,192,224)',
  subtle: 'rgb(110,115,141)',
  suggestion: 'rgb(138,173,244)',
  remember: 'rgb(198,160,246)',
  background: 'rgb(36,39,58)',
  success: 'rgb(166,218,149)',
  error: 'rgb(237,135,150)',
  warning: 'rgb(238,212,159)',
  warningShimmer: 'rgb(244,219,214)',
  merged: 'rgb(198,160,246)',
  diffAdded: 'rgb(48,65,57)',
  diffRemoved: 'rgb(70,45,57)',
  diffAddedDimmed: 'rgb(43,53,53)',
  diffRemovedDimmed: 'rgb(55,43,55)',
  diffAddedWord: 'rgb(62,86,62)',
  diffRemovedWord: 'rgb(92,53,68)',
  red_FOR_SUBAGENTS_ONLY: 'rgb(237,135,150)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(138,173,244)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(166,218,149)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(238,212,159)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(198,160,246)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(245,169,127)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(245,189,230)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(139,213,202)',
  professionalBlue: 'rgb(138,173,244)',
  chromeYellow: 'rgb(238,212,159)',
  clawd_body: 'rgb(183,189,248)',
  clawd_background: 'rgb(30,32,48)',
  userMessageBackground: 'rgb(36,39,58)',
  userMessageBackgroundHover: 'rgb(54,58,79)',
  messageActionsBackground: 'rgb(54,58,79)',
  selectionBg: 'rgb(73,77,100)',
  bashMessageBackgroundColor: 'rgb(30,32,48)',
  memoryBackgroundColor: 'rgb(54,58,79)',
  rate_limit_fill: 'rgb(183,189,248)',
  rate_limit_empty: 'rgb(73,77,100)',
  fastMode: 'rgb(245,169,127)',
  fastModeShimmer: 'rgb(244,219,214)',
  briefLabelYou: 'rgb(138,173,244)',
  briefLabelClaude: 'rgb(202,211,245)',
  rainbow_red: 'rgb(237,135,150)',
  rainbow_orange: 'rgb(245,169,127)',
  rainbow_yellow: 'rgb(238,212,159)',
  rainbow_green: 'rgb(166,218,149)',
  rainbow_blue: 'rgb(138,173,244)',
  rainbow_indigo: 'rgb(183,189,248)',
  rainbow_violet: 'rgb(198,160,246)',
  rainbow_red_shimmer: 'rgb(240,198,198)',
  rainbow_orange_shimmer: 'rgb(244,219,214)',
  rainbow_yellow_shimmer: 'rgb(244,219,214)',
  rainbow_green_shimmer: 'rgb(139,213,202)',
  rainbow_blue_shimmer: 'rgb(145,215,227)',
  rainbow_indigo_shimmer: 'rgb(202,211,245)',
  rainbow_violet_shimmer: 'rgb(245,189,230)',
  primary: 'rgb(202,211,245)',
  secondary: 'rgb(138,173,244)',
  accent: 'rgb(198,160,246)',
  info: 'rgb(145,215,227)',
  textMuted: 'rgb(165,173,203)',
  border: 'rgb(110,115,141)',
  borderActive: 'rgb(183,189,248)',
  borderSubtle: 'rgb(73,77,100)',
  backgroundPanel: 'rgb(36,39,58)',
  backgroundElement: 'rgb(54,58,79)',
  backgroundMenu: 'rgb(30,32,48)',
  brand: 'rgb(183,189,208)',
  brandDim: 'rgb(128,135,156)',
  brandBright: 'rgb(218,223,236)',
}

function getBaseTheme(themeName: ThemeName): Theme {
  switch (themeName) {
    case 'dark':
      return tauDarkTheme
    case 'light':
      return lightTheme
    case 'catppuccin-macchiato':
      return macchiatoTheme
    default:
      return tauDarkTheme
  }
}

export function getTheme(themeName: ThemeName): Theme {
  // Power mode tints the accent slots (bronze in cheap, gold in full) and
  // cross-fades them on /mode switches. Normal mode returns the base theme
  // object unchanged (fast path — no allocation).
  return applyPowerModeTheme(getBaseTheme(themeName), themeName)
}

// Create a chalk instance with 256-color level for Apple Terminal
// Apple Terminal doesn't handle 24-bit color escape sequences well
const chalkForChart =
  env.terminal === 'Apple_Terminal'
    ? new Chalk({ level: 2 }) // 256 colors
    : chalk

/**
 * Converts a theme color to an ANSI escape sequence for use with asciichart.
 * Uses chalk to generate the escape codes, with 256-color mode for Apple Terminal.
 */
export function themeColorToAnsi(themeColor: string): string {
  const rgbMatch = themeColor.match(/rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)/)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]!, 10)
    const g = parseInt(rgbMatch[2]!, 10)
    const b = parseInt(rgbMatch[3]!, 10)
    // Use chalk.rgb which auto-converts to 256 colors when level is 2
    // Extract just the opening escape sequence by using a marker
    const colored = chalkForChart.rgb(r, g, b)('X')
    return colored.slice(0, colored.indexOf('X'))
  }
  // Fallback to magenta if parsing fails
  return '\x1b[35m'
}
