import { stripVTControlCharacters } from 'node:util'

// These probes only need Read. Decline the optional Bash installation before
// accepting trust for the probe's temporary project and waiting for the REPL.
export function replStartupReady(terminal) {
  let handledThrough = 0
  let declinedBash = false
  let acceptedTrust = false
  return output => {
    const screen = stripVTControlCharacters(output.slice(handledThrough)).replace(/\s+/g, '')
    if (!declinedBash && screen.includes('SetupbashforTau') && screen.includes('No,skipandcontinue')) {
      declinedBash = true
      handledThrough = output.length
      terminal.write('\x1b')
      return false
    }
    if (!acceptedTrust && screen.includes('Yes,Itrustthisfolder')) {
      acceptedTrust = true
      handledThrough = output.length
      terminal.write('\r')
      return false
    }
    return /Anthropic|ClaudeSonnet/.test(screen)
  }
}
