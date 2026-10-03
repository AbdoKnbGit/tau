/**
 * Cross-platform terminal clearing with scrollback support.
 */

import { CURSOR_HOME, ERASE_SCREEN, ERASE_SCROLLBACK } from './termio/csi.js'

/**
 * Returns the ANSI escape sequence to clear the terminal including scrollback.
 *
 * ESC[3J goes out on Windows too, whatever the terminal. A full reset writes
 * the whole transcript again, so a terminal that keeps the old scrollback ends
 * up with one more copy of it per reset. Windows Terminal, VS Code and mintty
 * always got it; WezTerm, Alacritty and other ConPTY hosts honour it as well
 * when their ConPTY passes it through. Windows 10's built-in ConPTY drops it,
 * which leaves those hosts no worse than without it.
 */
export function getClearTerminalSequence(): string {
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
}

/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export const clearTerminal = getClearTerminalSequence()
