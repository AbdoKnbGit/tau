/**
 * Choosing the surface, so the model does not have to.
 *
 * Both directions of this decision are expensive when a model makes it by
 * intuition. Opening a browser to read a server-rendered listing costs a
 * process launch and a page of tokens for something an HTTP request answers in
 * under a second; scraping the HTML of a client-rendered app returns an empty
 * shell and gets reported as "no results" for a page full of them.
 *
 * The rule here is evidence-based and one-way: start cheap, escalate only when
 * the bytes prove the cheap rung cannot answer, and always say which rung did.
 */

import { fetchHttpRung, formatRung, type Rung } from "./httpRung.js";
import type { ReadResult } from "./pageScripts.js";

/** The slice of the browser session the ladder needs. */
export interface LadderSessionLike {
  isRunning(): boolean;
  ensureStarted(options: {
    signal?: AbortSignal;
  }): Promise<{ launched: string; note?: string }>;
  navigate(url: string, signal?: AbortSignal): Promise<void>;
  readPage(options: { maxChars?: number }): Promise<ReadResult>;
  getLastKnownUrl(): string | undefined;
  drainSessionNotes(): string[];
}

export interface LadderResult {
  ok: boolean;
  rungUsed: Rung;
  message: string;
  rung: string;
  url?: string;
  title?: string;
  text?: string;
  reason?: string;
  warnings: string[];
}

export interface LadderOptions {
  url: string;
  /** Already normalised by the caller (localhost → http, local file → file://). */
  surface?: "auto" | "http" | "chromium";
  maxChars?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injected for tests; defaults to the real clock. */
  now?: () => number;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export async function runSurfaceLadder(
  session: LadderSessionLike,
  options: LadderOptions,
): Promise<LadderResult> {
  const now = options.now ?? Date.now;
  const surface = options.surface ?? "auto";
  const maxChars = Math.min(Math.max(options.maxChars ?? 6000, 500), 30_000);
  const target = options.url;
  const isFile = target.startsWith("file://");
  const warnings: string[] = [];
  const startedAt = now();
  let escalatedFrom: string | undefined;

  if (surface !== "chromium" && !isFile) {
    const http = await fetchHttpRung(target, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (surface === "auto" && http.escalate) {
      escalatedFrom = http.escalateReason;
    } else {
      const ms = now() - startedAt;
      if (http.escalate && http.escalateReason) {
        warnings.push(
          `You forced the http rung, but this response looks unreliable: ${http.escalateReason}. Retry with { "action": "get", "surface": "chromium" } if content is missing.`,
        );
      }
      if (http.binary) {
        return {
          ok: http.ok,
          rungUsed: "http",
          message: `${http.status} ${http.url} — ${http.contentType}, ${http.bytes} bytes of binary content (not text; nothing to read).`,
          rung: formatRung("http", { bytes: http.bytes, ms }),
          url: http.url,
          warnings,
        };
      }
      if (!http.ok && !http.text) {
        return {
          ok: false,
          rungUsed: "http",
          message: http.error
            ? `Could not fetch ${target}: ${http.error}`
            : `HTTP ${http.status} from ${http.url} with an empty body.`,
          rung: formatRung("http", { bytes: http.bytes, ms }),
          url: http.url,
          warnings,
        };
      }
      const truncated = http.text.length > maxChars;
      return {
        ok: http.ok,
        rungUsed: "http",
        message: `HTTP ${http.status} ${http.url}${http.title ? ` — ${http.title}` : ""}`,
        rung: formatRung("http", {
          bytes: http.bytes,
          words: wordCount(http.text),
          ms,
        }),
        url: http.url,
        ...(http.title ? { title: http.title } : {}),
        text: truncated
          ? `${http.text.slice(0, maxChars)}\n… ${http.text.length - maxChars} more characters not shown (raise maxChars to see more).`
          : http.text,
        warnings,
      };
    }
  }

  if (!session.isRunning()) {
    const started = await session.ensureStarted(
      options.signal ? { signal: options.signal } : {},
    );
    warnings.push(started.note ?? "Started the browser.");
  }
  await session.navigate(target, options.signal);
  const read = await session.readPage({ maxChars });
  const ms = now() - startedAt;
  const rung = formatRung("chromium", {
    ms,
    ...(escalatedFrom ? { escalatedFrom } : {}),
  });
  if (!read.success) {
    return {
      ok: false,
      rungUsed: "chromium",
      message: read.error ?? "The browser loaded the page but could not read it.",
      rung,
      ...(read.reason ? { reason: read.reason } : {}),
      ...(session.getLastKnownUrl() ? { url: session.getLastKnownUrl() } : {}),
      warnings: [...warnings, ...session.drainSessionNotes()],
    };
  }
  const shown = read.content?.length ?? 0;
  const total = read.total ?? shown;
  return {
    ok: true,
    rungUsed: "chromium",
    message: `Rendered ${read.title || read.url || target} in the browser.${
      total > shown
        ? ` Characters 0–${shown} of ${total}; continue with { "action": "read", "offset": ${shown} }.`
        : ""
    } Observe if you need to act on it.`,
    rung: formatRung("chromium", {
      words: wordCount(read.content ?? ""),
      ms,
      ...(escalatedFrom ? { escalatedFrom } : {}),
    }),
    ...(read.url ? { url: read.url } : {}),
    ...(read.title ? { title: read.title } : {}),
    text: read.content ?? "",
    warnings: [...warnings, ...session.drainSessionNotes()],
  };
}
