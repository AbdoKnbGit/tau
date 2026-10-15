// Keep control-plane and generation calls on one Antigravity Hub release.
// Mixing client families creates an inconsistent request profile and makes
// opaque backend rejections much harder to distinguish from real quota errors.
// Argon is gated behind the 2.23.0 Hub client identity (CLIProxyAPI #6627).
export const ANTIGRAVITY_API_VERSION = '2.23.0'
export const ANTIGRAVITY_HUB_USER_AGENT =
  `antigravity/hub/${ANTIGRAVITY_API_VERSION} darwin/arm64`
// Primary generation channel. The non-sandbox daily endpoint is what the
// Antigravity client actually ships against (and what CLIProxyAPI/9router
// route to first — CLIProxyAPI has the sandbox host commented out
// entirely). The sandbox channel accepts the same envelope but its
// implicit prompt cache measured flaky partial-prefix reads. Generation
// stays on daily, including after 404s; sandbox hosts are not fallbacks.
export const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_ENDPOINT_DAILY_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH = 'https://autopush-cloudcode-pa.sandbox.googleapis.com'
export const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'
