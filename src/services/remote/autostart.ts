/**
 * `tau --remote-local`: start the phone listener with the session.
 *
 * main.tsx records the request; the REPL takes it once, after useRemoteMirror
 * has installed the snapshot provider and inbound handlers. Starting earlier
 * would let a phone that connects during startup see an empty session and
 * lose whatever it sends, because nothing would be listening on the REPL side.
 *
 * Nothing here persists. Without the flag Tau never starts the listener on
 * its own, so every launch that serves a phone was asked to.
 */

let requested = false

export function requestLocalAtStartup(): void {
  requested = true
}

/** True once per process when `--remote-local` was given. */
export function takeLocalAtStartup(): boolean {
  const was = requested
  requested = false
  return was
}
