/**
 * The cheap rung of the browser ladder.
 *
 * Most pages worth reading are already text on the wire. Launching Chromium to
 * read one is seconds of startup and a page of tokens for something an HTTP
 * request answers in under a second — and the reverse mistake is worse: an
 * agent that scrapes the HTML of a client-rendered app gets an empty shell and
 * reports "no results" for a page full of them.
 *
 * So the decision is made here, from evidence, and the rung that answered is
 * always reported. Nothing in this module is host-specific beyond deriving the
 * request's platform hints from `process.platform`, so the headers stay
 * consistent with the machine actually making the request.
 */

/** Visible text below this length on an HTML page means the markup was a shell. */
const MIN_MEANINGFUL_TEXT = 200;
/** Hard cap on decoded body text held in memory. */
const MAX_BODY_CHARS = 2_000_000;
/** Refuse to download bodies larger than this when the server declares a size. */
const MAX_DECLARED_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Pinned so two runs on one machine send identical headers. */
const CHROME_MAJOR = 131;

export type Rung = "http" | "chromium";

export interface HttpRungResult {
  ok: boolean;
  status: number;
  /** Final URL after redirects. */
  url: string;
  contentType: string;
  /** Decoded text for textual bodies; empty for binary. */
  text: string;
  title?: string;
  bytes: number;
  /** Set when the http rung cannot be trusted to have answered the question. */
  escalate: boolean;
  /** Human-readable evidence for the escalation decision. */
  escalateReason?: string;
  /** True when the body was not text and was therefore not decoded. */
  binary?: boolean;
  error?: string;
}

/**
 * Platform tokens for the request headers, derived from the host rather than
 * pinned to one OS: a UA claiming Windows from a Mac is exactly the kind of
 * self-inflicted mismatch that anti-bot checks look for.
 */
export function hostPlatformTokens(platform: NodeJS.Platform = process.platform): {
  uaPlatform: string;
  clientHintPlatform: string;
} {
  if (platform === "win32") {
    return {
      uaPlatform: "Windows NT 10.0; Win64; x64",
      clientHintPlatform: '"Windows"',
    };
  }
  if (platform === "darwin") {
    return {
      uaPlatform: "Macintosh; Intel Mac OS X 10_15_7",
      clientHintPlatform: '"macOS"',
    };
  }
  return { uaPlatform: "X11; Linux x86_64", clientHintPlatform: '"Linux"' };
}

export function buildRequestHeaders(
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const { uaPlatform, clientHintPlatform } = hostPlatformTokens(platform);
  return {
    "User-Agent": `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-CH-UA": `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not?A_Brand";v="24"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": clientHintPlatform,
    "Upgrade-Insecure-Requests": "1",
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const codePoint = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        return whole;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** `<title>` of a document, decoded and collapsed. */
export function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (!match?.[1]) return undefined;
  const title = decodeEntities(match[1].replace(/\s+/g, " ")).trim();
  return title || undefined;
}

/**
 * HTML to readable text with block structure preserved. Not a Readability
 * clone: the goal is an honest measure of how much text the server actually
 * sent, and a usable read when it sent plenty.
 */
export function htmlToReadableText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ");
  const withBreaks = stripped
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|tr|h[1-6]|blockquote|pre|table|ul|ol|form|figure|nav)\s*>/gi, "\n")
    .replace(/<(hr)\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, "\t");
  const text = decodeEntities(withBreaks.replace(/<[^>]*>/g, " "));
  return text
    .split("\n")
    .map(line => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]!.length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * An empty mount point is specific enough to act on whatever else the page
 * contains: a framework that renders into it has, by definition, not rendered.
 */
const EMPTY_ROOT_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i, label: 'empty <div id="root">' },
  { pattern: /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i, label: 'empty <div id="app">' },
  { pattern: /<div[^>]+id=["']__next["'][^>]*>\s*<\/div>/i, label: 'empty <div id="__next">' },
  { pattern: /<app-root[^>]*>\s*<\/app-root>/i, label: "empty <app-root>" },
];

/** Only meaningful on a page that came back thin. */
const THIN_TEXT_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /<noscript[^>]*>[\s\S]{0,400}?(enable|turn on)\s+javascript/i,
    label: "noscript demands JavaScript",
  },
];

const BOT_WALL_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /just a moment\s*\.{0,3}/i, label: "Cloudflare interstitial" },
  { pattern: /cf-browser-verification|cf_chl_|challenge-platform/i, label: "Cloudflare challenge" },
  { pattern: /checking your browser before accessing/i, label: "browser check page" },
  { pattern: /captcha-delivery|px-captcha|geo\.captcha/i, label: "CAPTCHA wall" },
  { pattern: /unusual traffic from your computer network/i, label: "traffic block page" },
];

/** Statuses where a real browser plausibly gets through and a fetch does not. */
const ESCALATABLE_STATUS = new Set([401, 403, 429, 503]);

/**
 * Decides whether the HTTP answer can be trusted. Returns the evidence, not
 * just a boolean, so the model can see why a browser was started.
 */
export function shouldEscalate(input: {
  status: number;
  contentType: string;
  html: string;
  text: string;
}): string | null {
  const isHtml = /html|xml/i.test(input.contentType) || /^\s*<(!doctype|html)/i.test(input.html);
  if (ESCALATABLE_STATUS.has(input.status)) {
    return `HTTP ${input.status} — a real browser session may be required`;
  }
  if (!isHtml) return null;
  for (const marker of BOT_WALL_MARKERS) {
    if (marker.pattern.test(input.html)) return `${marker.label} in the response`;
  }
  for (const marker of EMPTY_ROOT_MARKERS) {
    if (marker.pattern.test(input.html)) {
      return `${marker.label} and only ${input.text.length} chars of text`;
    }
  }
  if (input.text.length >= MIN_MEANINGFUL_TEXT) return null;
  for (const marker of THIN_TEXT_MARKERS) {
    if (marker.pattern.test(input.html)) {
      return `${marker.label} and only ${input.text.length} chars of text`;
    }
  }
  // Thin text alone is not evidence of a shell: a small page is just small,
  // and a browser cannot invent text that no script will produce. What marks a
  // shell is text that is a rounding error next to the markup carrying it.
  const scripts = (input.html.match(/<script\b/gi) ?? []).length;
  const textShare = input.html.length > 0 ? input.text.length / input.html.length : 1;
  if (scripts > 0 && textShare < 0.05) {
    return `only ${input.text.length} chars of text (${(textShare * 100).toFixed(1)}% of the HTML) behind ${scripts} script tag(s) — client-rendered`;
  }
  if (/<i?frame\b/i.test(input.html)) {
    return `only ${input.text.length} chars of text outside this page's frames`;
  }
  return null;
}

function isTextualContentType(contentType: string): boolean {
  return /^(text\/|application\/(json|xml|xhtml|javascript|ld\+json|rss|atom))/i.test(
    contentType,
  ) || /\+(json|xml)/i.test(contentType);
}

/**
 * Fetches a URL and reports what came back, including whether the answer is
 * trustworthy. Never throws for network failure — a failed rung is a result.
 */
export async function fetchHttpRung(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HttpRungResult> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const empty: Omit<HttpRungResult, "ok" | "error" | "escalate"> = {
    status: 0,
    url,
    contentType: "",
    text: "",
    bytes: 0,
  };
  try {
    const response = await fetch(url, {
      headers: buildRequestHeaders(),
      redirect: "follow",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_DECLARED_BYTES) {
      return {
        ...empty,
        ok: false,
        status: response.status,
        url: response.url || url,
        contentType,
        bytes: declared,
        escalate: false,
        error: `Body is ${Math.round(declared / 1024 / 1024)}MB — too large to read as text.`,
      };
    }
    if (!isTextualContentType(contentType) && contentType !== "") {
      // Binary: report it honestly instead of decoding noise. A browser would
      // not read it any better, so this is not an escalation.
      const buffer = await response.arrayBuffer();
      return {
        ...empty,
        ok: response.ok,
        status: response.status,
        url: response.url || url,
        contentType,
        bytes: buffer.byteLength,
        binary: true,
        escalate: false,
      };
    }
    const body = await response.text();
    const html = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
    const isMarkup = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(html);
    const text = isMarkup ? htmlToReadableText(html) : html;
    const reason = shouldEscalate({
      status: response.status,
      contentType,
      html,
      text,
    });
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      contentType,
      text,
      ...(isMarkup ? { title: extractTitle(html) } : {}),
      bytes: body.length,
      escalate: reason !== null,
      ...(reason ? { escalateReason: reason } : {}),
    };
  } catch (error: unknown) {
    const aborted = controller.signal.aborted && !options.signal?.aborted;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...empty,
      ok: false,
      // A network-level failure is worth one browser attempt: DNS and TLS
      // quirks that break fetch sometimes work in Chrome's stack.
      escalate: true,
      escalateReason: aborted
        ? `no response within ${timeoutMs}ms`
        : `request failed (${message})`,
      error: aborted ? `Timed out after ${timeoutMs}ms` : message,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** The line that tells the model which surface actually answered. */
export function formatRung(
  rung: Rung,
  detail: { bytes?: number; words?: number; ms: number; escalatedFrom?: string },
): string {
  const parts = [`rung=${rung}`];
  if (detail.escalatedFrom) parts.push(`escalated from http: ${detail.escalatedFrom}`);
  if (detail.bytes !== undefined) parts.push(`${detail.bytes} bytes`);
  if (detail.words !== undefined) parts.push(`${detail.words} words`);
  parts.push(`${detail.ms}ms`);
  return parts.join(" · ");
}
