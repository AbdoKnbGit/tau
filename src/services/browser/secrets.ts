/**
 * Credential masking for page traffic the Browser tool shows the model:
 * request payloads and response bodies.
 *
 * Adapted from Browsentic (https://github.com/imshaikot/browsentic), MIT
 * License, Copyright (c) 2026 Shahriar. The detector is a port of its
 * secrets/shapes.ts and secrets/detect.ts. Browsentic seals what it finds into
 * handles that a vault releases back into page fields; here a finding is only
 * masked. The model learns that a credential was there and what kind it was,
 * and nothing can turn the mask back into the value.
 *
 * The detector is deliberately dumb: a closed list of patterns, a label
 * vocabulary and one entropy gate, so the same text always masks the same way.
 */

export type SecretKind =
  | "api-key"
  | "token"
  | "jwt"
  | "password"
  | "cookie"
  | "private-key"
  | "card"
  | "secret";

/**
 * How much of a finding may stay visible. Only a vendor's public format
 * marker (`sk-ant-`, `ghp_`, `AKIA`) or a card's last four say something
 * without giving anything away.
 */
interface Reveal {
  readonly head: number;
  readonly tail: number;
}

interface Shape {
  readonly id: string;
  readonly kind: SecretKind;
  /** Global. When it captures, the first defined capture group is the secret. */
  readonly pattern: RegExp;
  /** Lowercase substring the text must contain before the pattern is worth running. */
  readonly guard?: string;
  readonly reveal?: Reveal;
  readonly validate?: (value: string) => boolean;
}

export interface SecretSpan {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly kind: SecretKind;
  readonly shape: string;
  readonly reveal: Reveal;
}

const NOTHING: Reveal = { head: 0, tail: 0 };

type Word = readonly string[];

const PASSWORD_WORDS: readonly Word[] = [
  ["pass", "word"],
  ["pass", "wd"],
  ["pass", "phrase"],
  ["pass", "code"],
  ["pwd"],
  ["otp"],
  ["one", "time", "code"],
];

const TOKEN_WORDS: readonly Word[] = [
  ["secret"],
  ["token"],
  ["api", "key"],
  ["access", "key"],
  ["access", "token"],
  ["secret", "key"],
  ["client", "secret"],
  ["refresh", "token"],
  ["auth", "token"],
  ["authorization"],
  ["bearer"],
  ["credential"],
  ["credentials"],
  ["signing", "key"],
  ["private", "key"],
  ["connection", "string"],
];

const COOKIE_WORDS: readonly Word[] = [
  ["cookie"],
  ["session", "id"],
  ["session", "key"],
  ["session", "token"],
  ["csrf", "token"],
  ["xsrf", "token"],
];

const inline = (words: readonly Word[]) =>
  words.map((word) => word.join(String.raw`[_\-\s]?`)).join("|");

const PASSWORD_LABEL = inline(PASSWORD_WORDS);
const TOKEN_LABEL = inline(TOKEN_WORDS);
const COOKIE_LABEL = inline(COOKIE_WORDS);

/** Quoted or bare, with the scheme words a header puts in front of the value stripped off. */
const VALUE = String.raw`(?:Bearer\s+|Basic\s+|Token\s+)?(?:"([^"\r\n]{4,400})"|'([^'\r\n]{4,400})'|([^\s,;&"'<>{}\[\]]{4,400}))`;

const labelled = (label: string) =>
  new RegExp(String.raw`(?<![A-Za-z0-9])(?:${label})["']?\s*[:=]\s*${VALUE}`, "gi");

/**
 * The same labels joined by an English verb rather than a colon, because that
 * is how a page hands someone a credential: "your temporary password is ...".
 */
const PROSE_VALUE = String.raw`(?:"([^"\r\n]{4,400})"|'([^'\r\n]{4,400})'|([^\s"'<>]{3,399}[^\s"'<>.,;:!?]))`;

const prose = (label: string) =>
  new RegExp(
    String.raw`(?<![A-Za-z0-9])(?:${label})\s+(?:is|are|was|will\s+be)\s*:?\s+${PROSE_VALUE}`,
    "gi",
  );

/**
 * Prose is mostly ordinary words, so a value after "password is" only counts
 * when it looks unlike one: a digit, a symbol a password uses, or a case change
 * mid-word. "The password is required" stays a sentence.
 */
const CREDENTIAL_SIGNAL = /\d|[!@#$%^&*()_+=[\]{}|\\<>~/&]|[a-z][A-Z]/;

export function looksLikeCredential(value: string): boolean {
  return value.length >= 6 && notAPlaceholder(value) && CREDENTIAL_SIGNAL.test(value);
}

/** Values that occupy a secret's slot without being one: `password: ********`. */
const PLACEHOLDER =
  /^(?:null|nil|none|true|false|undefined|n\/?a|empty|blank|test|demo|example|sample|changeme|hidden|redacted|your[-_\s].*|my[-_\s].*|x{3,}|\*+|\.{3,}|-+|_+|\[[^\]]*\]|<[^>]*>|\{\{.*\}\}|\$\{.*\})$/i;

/** Bullets and ellipses, the other way a page draws a hidden value. */
const ELLIPSIS = String.fromCharCode(0x2026);
const MASK_GLYPHS = new RegExp(`^[${String.fromCharCode(0x2022)}${ELLIPSIS}]+$`);

export function notAPlaceholder(value: string): boolean {
  if (PLACEHOLDER.test(value) || MASK_GLYPHS.test(value)) return false;
  if (/^(.)\1*$/.test(value)) return false;
  return !value.includes(ELLIPSIS);
}

/** Luhn check over 13-19 digits, so an order number does not read as a card. */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const SHAPES: readonly Shape[] = [
  {
    id: "private-key",
    kind: "private-key",
    guard: "-----begin",
    pattern:
      /-----BEGIN(?:[A-Z ]{0,32})PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,8000}-----END(?:[A-Z ]{0,32})PRIVATE KEY-----/g,
  },
  {
    id: "jwt",
    kind: "jwt",
    guard: "eyj",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  },
  {
    id: "anthropic-key",
    kind: "api-key",
    guard: "sk-ant-",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    reveal: { head: 7, tail: 0 },
  },
  {
    id: "openai-key",
    kind: "api-key",
    guard: "sk-",
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    reveal: { head: 3, tail: 0 },
  },
  {
    id: "google-key",
    kind: "api-key",
    guard: "aiza",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    reveal: { head: 4, tail: 0 },
  },
  {
    id: "aws-access-key",
    kind: "api-key",
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA)[0-9A-Z]{16}\b/g,
    reveal: { head: 4, tail: 0 },
  },
  {
    id: "github-pat",
    kind: "token",
    guard: "github_pat_",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
    reveal: { head: 11, tail: 0 },
  },
  {
    id: "github-token",
    kind: "token",
    guard: "gh",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    reveal: { head: 4, tail: 0 },
  },
  {
    id: "slack-token",
    kind: "token",
    guard: "xox",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    reveal: { head: 4, tail: 0 },
  },
  {
    id: "stripe-key",
    kind: "api-key",
    guard: "k_",
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    reveal: { head: 8, tail: 0 },
  },
  {
    id: "npm-token",
    kind: "token",
    guard: "npm_",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    reveal: { head: 4, tail: 0 },
  },
  {
    id: "gitlab-token",
    kind: "token",
    guard: "glpat-",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
    reveal: { head: 6, tail: 0 },
  },
  {
    id: "sendgrid-key",
    kind: "api-key",
    guard: "sg.",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    reveal: { head: 3, tail: 0 },
  },
  {
    id: "basic-auth",
    kind: "password",
    guard: "@",
    pattern: /\bhttps?:\/\/[^\s/:@]{1,64}:([^\s/@]{3,128})@/g,
  },
  {
    id: "cookie-header",
    kind: "cookie",
    guard: "cookie",
    pattern: /(?:^|\n)[ \t]*(?:set-)?cookie[ \t]*:[ \t]*([^\r\n]{4,4000})/gi,
  },
  {
    id: "labelled-password",
    kind: "password",
    pattern: labelled(PASSWORD_LABEL),
    validate: notAPlaceholder,
  },
  {
    id: "labelled-token",
    kind: "token",
    pattern: labelled(TOKEN_LABEL),
    validate: notAPlaceholder,
  },
  {
    id: "labelled-cookie",
    kind: "cookie",
    pattern: labelled(COOKIE_LABEL),
    validate: notAPlaceholder,
  },
  {
    id: "prose-password",
    kind: "password",
    pattern: prose(PASSWORD_LABEL),
    validate: looksLikeCredential,
  },
  {
    id: "prose-token",
    kind: "token",
    pattern: prose(TOKEN_LABEL),
    validate: looksLikeCredential,
  },
  {
    id: "card",
    kind: "card",
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    reveal: { head: 0, tail: 4 },
    validate: looksLikeCardNumber,
  },
];

/**
 * The last pass catches a bare token sitting on a page with nothing announcing
 * it. Every clause keeps something specific out: digests and ids are hex,
 * identifiers a person wrote are camel case, asset hashes live in URL paths.
 */
const CANDIDATE = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,4096}={0,2}(?![A-Za-z0-9+/_-])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTROPY_BITS = 4.3;
/**
 * Random credentials flip case about half the time between adjacent letters;
 * identifiers written by a person flip once per word.
 */
const CASE_FLIPS = 0.5;

/** Inline data URLs are image bytes, not credentials, and scanning them is pure cost. */
const DATA_URL = /\bdata:[^\s;,]{0,80};base64,[A-Za-z0-9+/=]+/g;

interface Range {
  readonly start: number;
  readonly end: number;
}

export function findSecrets(text: string): SecretSpan[] {
  if (!text) return [];
  const claimed: Range[] = rangesOf(text, DATA_URL);
  const lower = text.toLowerCase();
  const found: SecretSpan[] = [];

  const take = (span: SecretSpan) => {
    if (overlaps(claimed, span)) return;
    claimed.push(span);
    found.push(span);
  };

  for (const shape of SHAPES) {
    if (shape.guard && !lower.includes(shape.guard)) continue;
    for (const match of text.matchAll(shape.pattern)) {
      const at = secretIn(match);
      if (!at) continue;
      if (shape.validate && !shape.validate(at.value)) continue;
      take({ ...at, kind: shape.kind, shape: shape.id, reveal: shape.reveal ?? NOTHING });
    }
  }

  for (const match of text.matchAll(CANDIDATE)) {
    const value = match[0];
    if (match.index === undefined || !looksHighEntropy(value)) continue;
    take({
      start: match.index,
      end: match.index + value.length,
      value,
      kind: "secret",
      shape: "high-entropy",
      reveal: NOTHING,
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * Replaces every credential in `text` with `[masked <kind>]`, keeping only a
 * vendor prefix or a card's last four. Returns how many were masked.
 */
export function maskSecrets(text: string): { text: string; masked: number } {
  const spans = findSecrets(text);
  if (spans.length === 0) return { text, masked: 0 };
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + maskSpan(span);
    cursor = span.end;
  }
  return { text: out + text.slice(cursor), masked: spans.length };
}

const KEY_WORDS: ReadonlyArray<readonly [SecretKind, readonly Word[]]> = [
  ["password", PASSWORD_WORDS],
  ["token", TOKEN_WORDS],
  ["cookie", COOKIE_WORDS],
];

/**
 * The kind of credential a field name stands for, or null. Separators are
 * ignored, so `newPassword`, `new_password` and `NEW-PASSWORD` read the same.
 * `{ "password": "hunter2" }` has no label inside the value; the key is all
 * that says what it is.
 */
export function kindForKey(key: string): SecretKind | null {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  const forms = normalized.endsWith("s") ? [normalized, normalized.slice(0, -1)] : [normalized];
  for (const [kind, words] of KEY_WORDS) {
    if (words.some((word) => forms.some((form) => form.endsWith(word.join(""))))) return kind;
  }
  return null;
}

/** Shorter values under a credential key are left alone: too short to be one. */
const MIN_KEYED = 4;
const MAX_DEPTH = 12;

/**
 * Masks a request or response body. JSON is parsed and every value scanned on
 * its own, so JSON encoded into a string (an echo, a log line) is read
 * unescaped and a value under a credential key is masked whole. A form post
 * is decoded first, so `password%3A+...` reads as the `password: ...` it is.
 * Anything else is scanned as text.
 */
export function maskBody(text: string): string {
  const json = parseJsonText(text);
  if (json !== undefined) return JSON.stringify(maskJson(json, 0, null));
  const form = parseForm(text);
  if (form) {
    return [...form]
      .map(([key, value]) => `${key}=${maskField(value, kindForKey(key))}`)
      .join("&");
  }
  return maskSecrets(text).text;
}

function maskJson(value: unknown, depth: number, keyKind: SecretKind | null): unknown {
  if (typeof value === "string") {
    const nested = parseJsonText(value);
    if (nested !== undefined) return JSON.stringify(maskJson(nested, depth + 1, null));
    return maskField(value, keyKind);
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => maskJson(item, depth + 1, keyKind));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = maskJson(nested, depth + 1, kindForKey(key));
  }
  return out;
}

/** One field value: masked whole under a credential key, else scanned as text. */
function maskField(value: string, keyKind: SecretKind | null): string {
  if (keyKind && value.length >= MIN_KEYED && notAPlaceholder(value)) {
    const whole = findSecrets(value).find((span) => span.start === 0 && span.end === value.length);
    return whole ? maskSpan(whole) : `[masked ${keyKind}]`;
  }
  return maskSecrets(value).text;
}

/** An object or array written as JSON text, or undefined. */
function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `a=1&b=two+words`: a form post, recognised by having no raw whitespace. */
function parseForm(text: string): URLSearchParams | undefined {
  const trimmed = text.trim();
  if (!/^[^=&\s]+=\S*$/.test(trimmed)) return undefined;
  try {
    return new URLSearchParams(trimmed);
  } catch {
    return undefined;
  }
}

function maskSpan(span: SecretSpan): string {
  const room = Math.max(0, span.value.length - 4);
  const head = span.value.slice(0, Math.min(span.reveal.head, room));
  const tail =
    span.reveal.tail && span.value.length - span.reveal.tail > head.length
      ? span.value.slice(-span.reveal.tail)
      : "";
  return `${head}[masked ${span.kind}]${tail ? `...${tail}` : ""}`;
}

/** The first defined capture group is the secret; with no groups, the whole match is. */
function secretIn(
  match: RegExpMatchArray,
): { start: number; end: number; value: string } | null {
  if (match.index === undefined) return null;
  const captured = match.slice(1).find((group) => group !== undefined);
  if (captured === undefined) {
    return { start: match.index, end: match.index + match[0].length, value: match[0] };
  }
  if (!captured) return null;
  const offset = match[0].lastIndexOf(captured);
  if (offset < 0) return null;
  return {
    start: match.index + offset,
    end: match.index + offset + captured.length,
    value: captured,
  };
}

function looksHighEntropy(value: string): boolean {
  if (value.length < 32) return false;
  if (UUID.test(value)) return false;
  if (/^[0-9a-f]+$/i.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) return false;
  return entropy(value) >= ENTROPY_BITS && caseFlips(value) >= CASE_FLIPS;
}

function caseFlips(value: string): number {
  const letters = value.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) return 0;
  let flips = 0;
  for (let at = 1; at < letters.length; at += 1) {
    if (isUpper(letters[at]!) !== isUpper(letters[at - 1]!)) flips += 1;
  }
  return flips / (letters.length - 1);
}

const isUpper = (char: string) => char === char.toUpperCase();

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function rangesOf(text: string, pattern: RegExp): Range[] {
  return [...text.matchAll(pattern)].flatMap((match) =>
    match.index === undefined
      ? []
      : [{ start: match.index, end: match.index + match[0].length }],
  );
}

function overlaps(claimed: readonly Range[], span: Range): boolean {
  return claimed.some((range) => span.start < range.end && range.start < span.end);
}
