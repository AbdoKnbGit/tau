import chalk, { Chalk } from 'chalk'
import { env } from './env.js'

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

  // Modern UI palette slots (UX/UI refresh Phase 1).
  // Existing themes derive these from their established palette so legacy
  // callers stay visually unchanged; the 'studio' theme uses the refreshed
  // palette directly.
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
  // Brand accent (UX/UI refresh — teal). Drives the signature surfaces:
  // the wordmark, the prompt bar, and tool-block accent bars/headers.
  brand: string
  brandDim: string
  brandBright: string
}

export const THEME_NAMES = [
  'dark',
  'light',
  'light-daltonized',
  'dark-daltonized',
  'light-ansi',
  'dark-ansi',
  'studio',
] as const

/** A renderable theme. Always resolvable to a concrete color palette. */
export type ThemeName = (typeof THEME_NAMES)[number]

export const THEME_SETTINGS = ['auto', ...THEME_NAMES] as const

/**
 * A theme preference as stored in user config. `'auto'` follows the system
 * dark/light mode and is resolved to a ThemeName at runtime.
 */
export type ThemeSetting = (typeof THEME_SETTINGS)[number]

/**
 * Light theme using explicit RGB values to avoid inconsistencies
 * from users' custom terminal ANSI color definitions
 */
const lightTheme: Theme = {
  autoAccept: 'rgb(135,0,255)', // Electric violet
  bashBorder: 'rgb(255,0,135)', // Vibrant pink
  claude: 'rgb(120,190,120)', // Tau soft green
  claudeShimmer: 'rgb(160,220,160)', // Lighter green shimmer
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(130,165,210)', // Beanie blue for spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(160,195,235)', // Lighter beanie blue shimmer
  permission: 'rgb(130,165,210)', // Beanie blue
  permissionShimmer: 'rgb(160,195,235)', // Lighter beanie blue shimmer
  planMode: 'rgb(0,102,102)', // Muted teal
  ide: 'rgb(130,165,210)', // Beanie blue
  promptBorder: 'rgb(153,153,153)', // Medium gray
  promptBorderShimmer: 'rgb(183,183,183)', // Lighter gray for shimmer effect
  text: 'rgb(0,0,0)', // Black
  inverseText: 'rgb(255,255,255)', // White
  inactive: 'rgb(102,102,102)', // Dark gray
  inactiveShimmer: 'rgb(142,142,142)', // Lighter gray for shimmer effect
  subtle: 'rgb(175,175,175)', // Light gray
  suggestion: 'rgb(130,165,210)', // Beanie blue
  remember: 'rgb(130,165,210)', // Beanie blue
  background: 'rgb(160,195,160)', // Soft green
  success: 'rgb(44,122,57)', // Green
  error: 'rgb(171,43,63)', // Red
  warning: 'rgb(150,108,30)', // Amber
  merged: 'rgb(135,0,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(200,158,80)', // Lighter amber for shimmer effect
  diffAdded: 'rgb(105,219,124)', // Light green
  diffRemoved: 'rgb(255,168,180)', // Light red
  diffAddedDimmed: 'rgb(199,225,203)', // Very light green
  diffRemovedDimmed: 'rgb(253,210,216)', // Very light red
  diffAddedWord: 'rgb(47,157,68)', // Medium green
  diffRemovedWord: 'rgb(209,69,75)', // Medium red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)', // Red 600
  blue_FOR_SUBAGENTS_ONLY: 'rgb(37,99,235)', // Blue 600
  green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)', // Green 600
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)', // Yellow 600
  purple_FOR_SUBAGENTS_ONLY: 'rgb(147,51,234)', // Purple 600
  orange_FOR_SUBAGENTS_ONLY: 'rgb(234,88,12)', // Orange 600
  pink_FOR_SUBAGENTS_ONLY: 'rgb(219,39,119)', // Pink 600
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)', // Cyan 600
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(140,200,140)', // Tau ghost green
  clawd_background: 'rgb(50,50,60)', // Dark purple-gray for ghost eyes
  userMessageBackground: 'rgb(240, 242, 238)', // Warm light gray with green tint
  userMessageBackgroundHover: 'rgb(248, 250, 246)',
  messageActionsBackground: 'rgb(228, 236, 232)', // Cool gray with green tint
  selectionBg: 'rgb(190, 225, 195)', // Soft green selection
  bashMessageBackgroundColor: 'rgb(245, 248, 245)',

  memoryBackgroundColor: 'rgb(230, 248, 235)',
  rate_limit_fill: 'rgb(130,165,210)', // Beanie blue
  rate_limit_empty: 'rgb(58,73,94)', // Dark blue
  fastMode: 'rgb(130,165,210)', // Beanie blue
  fastModeShimmer: 'rgb(160,195,235)', // Lighter beanie blue
  // Brief/assistant mode
  briefLabelYou: 'rgb(130,165,210)', // Beanie blue
  briefLabelClaude: 'rgb(120,190,120)', // Tau green
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
  // Studio palette slots (mapped from existing palette)
  primary: 'rgb(120,190,120)', // claude (brand green)
  secondary: 'rgb(130,165,210)', // permission/suggestion blue
  accent: 'rgb(135,0,255)', // autoAccept electric violet
  info: 'rgb(130,165,210)', // permission blue
  textMuted: 'rgb(102,102,102)', // inactive
  border: 'rgb(153,153,153)', // promptBorder
  borderActive: 'rgb(183,183,183)', // promptBorderShimmer
  borderSubtle: 'rgb(175,175,175)', // subtle
  backgroundPanel: 'rgb(240,242,238)', // userMessageBackground
  backgroundElement: 'rgb(228,236,232)', // messageActionsBackground
  backgroundMenu: 'rgb(245,248,245)', // bashMessageBackgroundColor
  // Brand accent — teal (deeper for contrast on light backgrounds)
  brand: 'rgb(13,148,148)',
  brandDim: 'rgb(120,178,176)',
  brandBright: 'rgb(8,170,168)',
}

/**
 * Light ANSI theme using only the 16 standard ANSI colors
 * for terminals without true color support
 */
const lightAnsiTheme: Theme = {
  autoAccept: 'ansi:magenta',
  bashBorder: 'ansi:magenta',
  claude: 'ansi:greenBright',
  claudeShimmer: 'ansi:cyanBright',
  claudeBlue_FOR_SYSTEM_SPINNER: 'ansi:blue',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  permission: 'ansi:blue',
  permissionShimmer: 'ansi:blueBright',
  planMode: 'ansi:cyan',
  ide: 'ansi:blueBright',
  promptBorder: 'ansi:white',
  promptBorderShimmer: 'ansi:whiteBright',
  text: 'ansi:black',
  inverseText: 'ansi:white',
  inactive: 'ansi:blackBright',
  inactiveShimmer: 'ansi:white',
  subtle: 'ansi:blackBright',
  suggestion: 'ansi:blue',
  remember: 'ansi:blue',
  background: 'ansi:cyan',
  success: 'ansi:green',
  error: 'ansi:red',
  warning: 'ansi:yellow',
  merged: 'ansi:magenta',
  warningShimmer: 'ansi:yellowBright',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'ansi:red',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blue',
  green_FOR_SUBAGENTS_ONLY: 'ansi:green',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellow',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magenta',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyan',
  // Grove colors
  professionalBlue: 'ansi:blueBright',
  // Chrome colors
  chromeYellow: 'ansi:yellow', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'ansi:greenBright',
  clawd_background: 'ansi:black',
  userMessageBackground: 'ansi:white',
  userMessageBackgroundHover: 'ansi:whiteBright',
  messageActionsBackground: 'ansi:white',
  selectionBg: 'ansi:cyan', // lighter named bg for light-ansi; dark fgs stay readable
  bashMessageBackgroundColor: 'ansi:whiteBright',

  memoryBackgroundColor: 'ansi:white',
  rate_limit_fill: 'ansi:yellow',
  rate_limit_empty: 'ansi:black',
  fastMode: 'ansi:red',
  fastModeShimmer: 'ansi:redBright',
  briefLabelYou: 'ansi:blue',
  briefLabelClaude: 'ansi:greenBright',
  rainbow_red: 'ansi:red',
  rainbow_orange: 'ansi:redBright',
  rainbow_yellow: 'ansi:yellow',
  rainbow_green: 'ansi:green',
  rainbow_blue: 'ansi:cyan',
  rainbow_indigo: 'ansi:blue',
  rainbow_violet: 'ansi:magenta',
  rainbow_red_shimmer: 'ansi:redBright',
  rainbow_orange_shimmer: 'ansi:yellow',
  rainbow_yellow_shimmer: 'ansi:yellowBright',
  rainbow_green_shimmer: 'ansi:greenBright',
  rainbow_blue_shimmer: 'ansi:cyanBright',
  rainbow_indigo_shimmer: 'ansi:blueBright',
  rainbow_violet_shimmer: 'ansi:magentaBright',
  // Studio palette slots (ansi-only mapping)
  primary: 'ansi:greenBright',
  secondary: 'ansi:blue',
  accent: 'ansi:magenta',
  info: 'ansi:blue',
  textMuted: 'ansi:blackBright',
  border: 'ansi:white',
  borderActive: 'ansi:whiteBright',
  borderSubtle: 'ansi:blackBright',
  backgroundPanel: 'ansi:white',
  backgroundElement: 'ansi:white',
  backgroundMenu: 'ansi:whiteBright',
  // Brand accent — teal (ANSI cyan fallback)
  brand: 'ansi:cyan',
  brandDim: 'ansi:cyan',
  brandBright: 'ansi:cyanBright',
}

/**
 * Dark ANSI theme using only the 16 standard ANSI colors
 * for terminals without true color support
 */
const darkAnsiTheme: Theme = {
  autoAccept: 'ansi:magentaBright',
  bashBorder: 'ansi:magentaBright',
  claude: 'ansi:greenBright',
  claudeShimmer: 'ansi:cyanBright',
  claudeBlue_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  permission: 'ansi:blueBright',
  permissionShimmer: 'ansi:blueBright',
  planMode: 'ansi:cyanBright',
  ide: 'ansi:blue',
  promptBorder: 'ansi:white',
  promptBorderShimmer: 'ansi:whiteBright',
  text: 'ansi:whiteBright',
  inverseText: 'ansi:black',
  inactive: 'ansi:white',
  inactiveShimmer: 'ansi:whiteBright',
  subtle: 'ansi:white',
  suggestion: 'ansi:blueBright',
  remember: 'ansi:blueBright',
  background: 'ansi:cyanBright',
  success: 'ansi:greenBright',
  error: 'ansi:redBright',
  warning: 'ansi:yellowBright',
  merged: 'ansi:magentaBright',
  warningShimmer: 'ansi:yellowBright',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blueBright',
  green_FOR_SUBAGENTS_ONLY: 'ansi:greenBright',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellowBright',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyanBright',
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'ansi:yellowBright', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'ansi:greenBright',
  clawd_background: 'ansi:black',
  userMessageBackground: 'ansi:blackBright',
  userMessageBackgroundHover: 'ansi:white',
  messageActionsBackground: 'ansi:blackBright',
  selectionBg: 'ansi:blue', // darker named bg for dark-ansi; bright fgs stay readable
  bashMessageBackgroundColor: 'ansi:black',

  memoryBackgroundColor: 'ansi:blackBright',
  rate_limit_fill: 'ansi:yellow',
  rate_limit_empty: 'ansi:white',
  fastMode: 'ansi:redBright',
  fastModeShimmer: 'ansi:redBright',
  briefLabelYou: 'ansi:blueBright',
  briefLabelClaude: 'ansi:greenBright',
  rainbow_red: 'ansi:red',
  rainbow_orange: 'ansi:redBright',
  rainbow_yellow: 'ansi:yellow',
  rainbow_green: 'ansi:green',
  rainbow_blue: 'ansi:cyan',
  rainbow_indigo: 'ansi:blue',
  rainbow_violet: 'ansi:magenta',
  rainbow_red_shimmer: 'ansi:redBright',
  rainbow_orange_shimmer: 'ansi:yellow',
  rainbow_yellow_shimmer: 'ansi:yellowBright',
  rainbow_green_shimmer: 'ansi:greenBright',
  rainbow_blue_shimmer: 'ansi:cyanBright',
  rainbow_indigo_shimmer: 'ansi:blueBright',
  rainbow_violet_shimmer: 'ansi:magentaBright',
  // Studio palette slots (ansi-only mapping, dark variant)
  primary: 'ansi:greenBright',
  secondary: 'ansi:blueBright',
  accent: 'ansi:magentaBright',
  info: 'ansi:blueBright',
  textMuted: 'ansi:white',
  border: 'ansi:white',
  borderActive: 'ansi:whiteBright',
  borderSubtle: 'ansi:white',
  backgroundPanel: 'ansi:blackBright',
  backgroundElement: 'ansi:blackBright',
  backgroundMenu: 'ansi:black',
  // Brand accent — teal (ANSI cyan fallback)
  brand: 'ansi:cyanBright',
  brandDim: 'ansi:cyan',
  brandBright: 'ansi:cyanBright',
}

/**
 * Light daltonized theme (color-blind friendly) using explicit RGB values
 * to avoid inconsistencies from users' custom terminal ANSI color definitions
 */
const lightDaltonizedTheme: Theme = {
  autoAccept: 'rgb(135,0,255)', // Electric violet
  bashBorder: 'rgb(0,102,204)', // Blue instead of pink
  claude: 'rgb(100,180,100)', // Tau green (daltonized-safe)
  claudeShimmer: 'rgb(140,210,140)', // Lighter green shimmer
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(51,102,255)', // Bright blue for system spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(101,152,255)', // Lighter bright blue shimmer
  permission: 'rgb(51,102,255)', // Bright blue
  permissionShimmer: 'rgb(101,152,255)', // Lighter bright blue shimmer
  planMode: 'rgb(51,102,102)', // Muted blue-gray
  ide: 'rgb(130,165,210)', // Beanie blue
  promptBorder: 'rgb(153,153,153)', // Medium gray
  promptBorderShimmer: 'rgb(183,183,183)', // Lighter gray for shimmer
  text: 'rgb(0,0,0)', // Black
  inverseText: 'rgb(255,255,255)', // White
  inactive: 'rgb(102,102,102)', // Dark gray
  inactiveShimmer: 'rgb(142,142,142)', // Lighter gray for shimmer effect
  subtle: 'rgb(175,175,175)', // Light gray
  suggestion: 'rgb(51,102,255)', // Bright blue
  remember: 'rgb(51,102,255)', // Bright blue
  background: 'rgb(140,190,150)', // Soft green (color-blind friendly)
  success: 'rgb(0,102,153)', // Blue instead of green for deuteranopia
  error: 'rgb(204,0,0)', // Pure red for better distinction
  warning: 'rgb(255,153,0)', // Orange adjusted for deuteranopia
  merged: 'rgb(135,0,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(255,183,50)', // Lighter orange for shimmer
  diffAdded: 'rgb(153,204,255)', // Light blue instead of green
  diffRemoved: 'rgb(255,204,204)', // Light red
  diffAddedDimmed: 'rgb(209,231,253)', // Very light blue
  diffRemovedDimmed: 'rgb(255,233,233)', // Very light red
  diffAddedWord: 'rgb(51,102,204)', // Medium blue (less intense than deep blue)
  diffRemovedWord: 'rgb(153,51,51)', // Softer red (less intense than deep red)
  // Agent colors (daltonism-friendly)
  red_FOR_SUBAGENTS_ONLY: 'rgb(204,0,0)', // Pure red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(0,102,204)', // Pure blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(0,204,0)', // Pure green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(255,204,0)', // Golden yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(128,0,128)', // True purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,128,0)', // True orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,102,178)', // Adjusted pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(0,178,178)', // Adjusted cyan
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(140,200,140)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(220, 220, 220)', // Slightly darker grey for optimal contrast
  userMessageBackgroundHover: 'rgb(232, 232, 232)', // ≥230 to quantize distinct from base at 256-color level
  messageActionsBackground: 'rgb(210, 216, 226)', // cool gray — darker than userMsg 220, slight blue
  selectionBg: 'rgb(180, 213, 255)', // light selection blue; daltonized fgs are yellows/blues, both readable on light blue
  bashMessageBackgroundColor: 'rgb(250, 245, 250)',

  memoryBackgroundColor: 'rgb(230, 245, 250)',
  rate_limit_fill: 'rgb(51,102,255)', // Bright blue
  rate_limit_empty: 'rgb(23,46,114)', // Dark blue
  fastMode: 'rgb(255,106,0)', // Electric orange (color-blind safe)
  fastModeShimmer: 'rgb(255,150,50)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(37,99,235)', // Blue
  briefLabelClaude: 'rgb(100,180,100)', // Tau green (daltonized)
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
  // Studio palette slots (daltonized, light variant)
  primary: 'rgb(100,180,100)', // claude (daltonized green)
  secondary: 'rgb(51,102,255)', // permission bright blue
  accent: 'rgb(135,0,255)', // autoAccept electric violet
  info: 'rgb(51,102,255)',
  textMuted: 'rgb(102,102,102)',
  border: 'rgb(153,153,153)',
  borderActive: 'rgb(183,183,183)',
  borderSubtle: 'rgb(175,175,175)',
  backgroundPanel: 'rgb(220,220,220)',
  backgroundElement: 'rgb(210,216,226)',
  backgroundMenu: 'rgb(250,245,250)',
  // Brand accent — teal-leaning blue (color-blind-safe, light variant)
  brand: 'rgb(0,140,160)',
  brandDim: 'rgb(120,170,180)',
  brandBright: 'rgb(0,165,185)',
}

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
  // Studio palette slots (electric-cyan dark variant)
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
  // Brand accent — soft monochrome grey→off-white (inherited by tauDark + studio)
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

/**
 * Dark daltonized theme (color-blind friendly) using explicit RGB values
 * to avoid inconsistencies from users' custom terminal ANSI color definitions
 */
const darkDaltonizedTheme: Theme = {
  autoAccept: 'rgb(175,135,255)', // Electric violet
  bashBorder: 'rgb(51,153,255)', // Bright blue
  claude: 'rgb(130,200,130)', // Tau green (dark daltonized)
  claudeShimmer: 'rgb(170,230,170)', // Lighter green shimmer
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(153,204,255)', // Light blue for system spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(183,224,255)', // Lighter blue shimmer
  permission: 'rgb(153,204,255)', // Light blue
  permissionShimmer: 'rgb(183,224,255)', // Lighter blue shimmer
  planMode: 'rgb(102,153,153)', // Muted gray-teal
  ide: 'rgb(150,185,230)', // Beanie blue
  promptBorder: 'rgb(136,136,136)', // Medium gray
  promptBorderShimmer: 'rgb(166,166,166)', // Lighter gray for shimmer
  text: 'rgb(255,255,255)', // White
  inverseText: 'rgb(0,0,0)', // Black
  inactive: 'rgb(153,153,153)', // Light gray
  inactiveShimmer: 'rgb(193,193,193)', // Lighter gray for shimmer effect
  subtle: 'rgb(80,80,80)', // Dark gray
  suggestion: 'rgb(153,204,255)', // Light blue
  remember: 'rgb(153,204,255)', // Light blue
  background: 'rgb(0,204,204)', // Bright cyan (color-blind friendly)
  success: 'rgb(51,153,255)', // Blue instead of green
  error: 'rgb(255,102,102)', // Bright red
  warning: 'rgb(255,204,0)', // Yellow-orange for deuteranopia
  merged: 'rgb(175,135,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(255,234,50)', // Lighter yellow-orange for shimmer
  diffAdded: 'rgb(0,68,102)', // Dark blue
  diffRemoved: 'rgb(102,0,0)', // Dark red
  diffAddedDimmed: 'rgb(62,81,91)', // Dimmed blue
  diffRemovedDimmed: 'rgb(62,44,44)', // Dimmed red
  diffAddedWord: 'rgb(0,119,179)', // Medium blue
  diffRemovedWord: 'rgb(179,0,0)', // Medium red
  // Agent colors (daltonism-friendly, dark mode)
  red_FOR_SUBAGENTS_ONLY: 'rgb(255,102,102)', // Bright red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(102,178,255)', // Bright blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(102,255,102)', // Bright green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(255,255,102)', // Bright yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(178,102,255)', // Bright purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,178,102)', // Bright orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,153,204)', // Bright pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(102,204,204)', // Bright cyan
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(140,200,140)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(55, 55, 55)', // Lighter grey for better visual contrast
  userMessageBackgroundHover: 'rgb(70, 70, 70)',
  messageActionsBackground: 'rgb(44, 50, 62)', // cool gray, slight blue
  selectionBg: 'rgb(38, 79, 120)', // classic dark-mode selection blue (VS Code dark default); light fgs stay readable
  bashMessageBackgroundColor: 'rgb(65, 60, 65)',

  memoryBackgroundColor: 'rgb(55, 65, 70)',
  rate_limit_fill: 'rgb(153,204,255)', // Light blue
  rate_limit_empty: 'rgb(69,92,115)', // Dark blue
  fastMode: 'rgb(255,120,20)', // Electric orange for dark bg (color-blind safe)
  fastModeShimmer: 'rgb(255,165,70)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(122,180,232)', // Light blue
  briefLabelClaude: 'rgb(100,180,100)', // Tau green (daltonized)
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
  // Studio palette slots (daltonized, dark variant)
  primary: 'rgb(130,200,130)', // claude daltonized green
  secondary: 'rgb(153,204,255)', // permission light blue
  accent: 'rgb(175,135,255)', // autoAccept electric violet
  info: 'rgb(150,185,230)', // ide
  textMuted: 'rgb(153,153,153)',
  border: 'rgb(136,136,136)',
  borderActive: 'rgb(166,166,166)',
  borderSubtle: 'rgb(80,80,80)',
  backgroundPanel: 'rgb(55,55,55)',
  backgroundElement: 'rgb(44,50,62)',
  backgroundMenu: 'rgb(65,60,65)',
  // Brand accent — teal (color-blind-safe, dark variant)
  brand: 'rgb(100,210,225)',
  brandDim: 'rgb(70,140,150)',
  brandBright: 'rgb(150,235,245)',
}

/**
 * Studio theme. Refined dark UI: peach primary, blue secondary, purple accent
 * on near-black background. Built on top of darkTheme so legacy slots stay
 * sensible while the new modern-UI slots use the refreshed palette directly.
 */
const studioTheme: Theme = {
  ...darkTheme,
  // Brand / accents
  autoAccept: 'rgb(157,124,216)', // accent purple
  bashBorder: 'rgb(157,124,216)',
  claude: 'rgb(250,178,131)', // primary peach
  claudeShimmer: 'rgb(255,192,159)',
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(92,156,245)',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(140,184,250)',
  permission: 'rgb(92,156,245)',
  permissionShimmer: 'rgb(140,184,250)',
  planMode: 'rgb(86,182,194)', // info cyan
  ide: 'rgb(92,156,245)',
  promptBorder: 'rgb(72,72,72)',
  promptBorderShimmer: 'rgb(96,96,96)',
  text: 'rgb(238,238,238)',
  inverseText: 'rgb(10,10,10)',
  inactive: 'rgb(128,128,128)',
  inactiveShimmer: 'rgb(160,160,160)',
  subtle: 'rgb(60,60,60)',
  suggestion: 'rgb(92,156,245)',
  remember: 'rgb(157,124,216)',
  background: 'rgb(10,10,10)',
  // Status
  success: 'rgb(127,216,143)',
  error: 'rgb(224,108,117)',
  warning: 'rgb(245,167,66)',
  merged: 'rgb(157,124,216)',
  warningShimmer: 'rgb(248,192,118)',
  // Diff
  diffAdded: 'rgb(79,214,190)',
  diffRemoved: 'rgb(197,59,83)',
  diffAddedDimmed: 'rgb(32,48,59)',
  diffRemovedDimmed: 'rgb(55,34,44)',
  diffAddedWord: 'rgb(184,219,135)',
  diffRemovedWord: 'rgb(226,106,117)',
  // Subagent palette (mapped to studio hues)
  red_FOR_SUBAGENTS_ONLY: 'rgb(224,108,117)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(92,156,245)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(127,216,143)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(229,192,123)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(157,124,216)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(245,167,66)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(224,108,117)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(86,182,194)',
  // Misc
  professionalBlue: 'rgb(92,156,245)',
  chromeYellow: 'rgb(229,192,123)',
  clawd_body: 'rgb(250,178,131)',
  clawd_background: 'rgb(20,20,20)',
  userMessageBackground: 'rgb(20,20,20)',
  userMessageBackgroundHover: 'rgb(30,30,30)',
  messageActionsBackground: 'rgb(40,40,40)',
  selectionBg: 'rgb(50,50,50)',
  bashMessageBackgroundColor: 'rgb(20,20,20)',
  memoryBackgroundColor: 'rgb(30,30,30)',
  rate_limit_fill: 'rgb(250,178,131)',
  rate_limit_empty: 'rgb(40,40,40)',
  fastMode: 'rgb(245,167,66)',
  fastModeShimmer: 'rgb(248,192,118)',
  briefLabelYou: 'rgb(92,156,245)',
  briefLabelClaude: 'rgb(250,178,131)',
  rainbow_red: 'rgb(224,108,117)',
  rainbow_orange: 'rgb(245,167,66)',
  rainbow_yellow: 'rgb(229,192,123)',
  rainbow_green: 'rgb(127,216,143)',
  rainbow_blue: 'rgb(92,156,245)',
  rainbow_indigo: 'rgb(157,124,216)',
  rainbow_violet: 'rgb(157,124,216)',
  rainbow_red_shimmer: 'rgb(238,140,148)',
  rainbow_orange_shimmer: 'rgb(248,192,118)',
  rainbow_yellow_shimmer: 'rgb(238,210,148)',
  rainbow_green_shimmer: 'rgb(168,228,180)',
  rainbow_blue_shimmer: 'rgb(140,184,250)',
  rainbow_indigo_shimmer: 'rgb(190,162,232)',
  rainbow_violet_shimmer: 'rgb(190,162,232)',
  // Studio palette slots — refreshed dark UI values
  primary: 'rgb(250,178,131)', // peach
  secondary: 'rgb(92,156,245)', // blue
  accent: 'rgb(157,124,216)', // purple
  info: 'rgb(86,182,194)', // cyan
  textMuted: 'rgb(128,128,128)',
  border: 'rgb(72,72,72)',
  borderActive: 'rgb(96,96,96)',
  borderSubtle: 'rgb(60,60,60)',
  backgroundPanel: 'rgb(20,20,20)',
  backgroundElement: 'rgb(30,30,30)',
  backgroundMenu: 'rgb(30,30,30)',
}

export function getTheme(themeName: ThemeName): Theme {
  switch (themeName) {
    case 'dark':
      return tauDarkTheme
    case 'light':
      return lightTheme
    case 'light-ansi':
      return lightAnsiTheme
    case 'dark-ansi':
      return darkAnsiTheme
    case 'light-daltonized':
      return lightDaltonizedTheme
    case 'dark-daltonized':
      return darkDaltonizedTheme
    case 'studio':
      return studioTheme
    default:
      return tauDarkTheme
  }
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
