/**
 * WebSocket close codes the /remote server and phone page share.
 *
 * A refused socket is upgraded and then closed with one of these, instead of
 * being dropped mid-handshake. A drop reaches the page as a bare 1006, which
 * looks exactly like "the computer is unreachable", so the page used to retry
 * a dead link forever. With a code it can stop and say what to do.
 */

/** No session token, or one from an earlier session. Scan the new QR code. */
export const CLOSE_STALE_LINK = 4003
/** At sign-in: this device id is not remembered here, or its proof was wrong. */
export const CLOSE_NOT_REMEMBERED = 4004
/** A remembered phone signing in from a page this listener did not serve. */
export const CLOSE_WRONG_ORIGIN = 4005
/** The user forgot this phone while it was connected. Do not come back. */
export const CLOSE_FORGOTTEN = 4006
/** The phone did not answer the sign-in challenge in time. */
export const CLOSE_AUTH_TIMEOUT = 4008
/** The device list could not be read just now. Retry; keep the key. */
export const CLOSE_TRY_AGAIN = 4013
