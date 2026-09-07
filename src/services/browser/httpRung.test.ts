/**
 * The http rung and its escalation decision.
 *
 * Runs against a loopback server on an OS-assigned port — no network, no fixed
 * port, nothing host-specific.
 *
 * Run: bun run src/services/browser/httpRung.test.ts
 */

import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

import {
  buildRequestHeaders,
  decodeEntities,
  extractTitle,
  fetchHttpRung,
  formatRung,
  hostPlatformTokens,
  htmlToReadableText,
  shouldEscalate,
} from "./httpRung.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, hint: string): void {
  if (!condition) throw new Error(hint);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error: unknown) {
    failed++;
    console.log(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error: unknown) {
    failed++;
    console.log(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const ARTICLE_HTML = `<!doctype html><html><head><title>Prices &amp; Stock</title>
<style>.x{color:red}</style></head><body>
<h1>Graphics cards</h1><p>First paragraph with enough words to look like a real article body.</p>
<ul><li>ZOTAC RTX 5080 — 250,000</li><li>PNY RTX 5080 — 268,000</li></ul>
<p>${"More prose. ".repeat(20)}</p>
<script>window.__DATA__={a:1}</script></body></html>`;

const SPA_HTML = `<!doctype html><html><head><title>App</title></head><body>
<div id="root"></div>
<script src="/assets/index-4f2a.js"></script></body></html>`;

function startServer(
  handler: (path: string) => {
    status?: number;
    type?: string;
    body?: string | Buffer;
    delayMs?: number;
  },
): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server: Server = createServer((req, res) => {
      const reply = handler(req.url ?? "/");
      const send = () => {
        res.writeHead(reply.status ?? 200, {
          "content-type": reply.type ?? "text/html; charset=utf-8",
        });
        res.end(reply.body ?? "");
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>(done => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function main(): Promise<void> {
  console.log("host-derived headers:");

  test("platform tokens follow the host, never a pinned OS", () => {
    assert(hostPlatformTokens("win32").uaPlatform.includes("Windows NT"), "win32");
    assert(hostPlatformTokens("darwin").uaPlatform.includes("Mac OS X"), "darwin");
    assert(hostPlatformTokens("linux").uaPlatform.includes("Linux"), "linux");
    assert(hostPlatformTokens("freebsd").clientHintPlatform === '"Linux"', "fallback");
  });

  test("user-agent and client hints agree with each other", () => {
    for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
      const headers = buildRequestHeaders(platform);
      const { uaPlatform, clientHintPlatform } = hostPlatformTokens(platform);
      assert(headers["User-Agent"]!.includes(uaPlatform), `${platform} ua`);
      assert(
        headers["Sec-CH-UA-Platform"] === clientHintPlatform,
        `${platform} client hint`,
      );
    }
  });

  console.log("text extraction:");

  test("decodes named, decimal and hex entities and leaves unknown ones", () => {
    assert(decodeEntities("a&amp;b") === "a&b", "named");
    assert(decodeEntities("&#39;q&#39;") === "'q'", "decimal");
    assert(decodeEntities("&#x2014;") === "—", "hex");
    assert(decodeEntities("&notarealentity;") === "&notarealentity;", "unknown");
    assert(decodeEntities("50&nbsp;000") === "50 000", "nbsp");
  });

  test("reads and decodes the title", () => {
    assert(extractTitle(ARTICLE_HTML) === "Prices & Stock", extractTitle(ARTICLE_HTML) ?? "");
    assert(extractTitle("<html><body>no title</body></html>") === undefined, "absent");
  });

  test("strips scripts and styles, keeps block structure", () => {
    const text = htmlToReadableText(ARTICLE_HTML);
    assert(!text.includes("__DATA__"), "script content must be gone");
    assert(!text.includes("color:red"), "style content must be gone");
    assert(text.includes("Graphics cards"), "heading kept");
    assert(text.includes("ZOTAC RTX 5080 — 250,000"), "list item kept and decoded");
    assert(text.split("\n").length > 3, "block tags must produce line breaks");
  });

  test("an empty shell extracts to almost nothing", () => {
    assert(htmlToReadableText(SPA_HTML).length < 20, htmlToReadableText(SPA_HTML));
  });

  console.log("escalation decision:");

  test("a server-rendered page answers at the http rung", () => {
    const reason = shouldEscalate({
      status: 200,
      contentType: "text/html",
      html: ARTICLE_HTML,
      text: htmlToReadableText(ARTICLE_HTML),
    });
    assert(reason === null, `must not escalate, got: ${reason}`);
  });

  test("a client-rendered shell escalates with the evidence", () => {
    const reason = shouldEscalate({
      status: 200,
      contentType: "text/html",
      html: SPA_HTML,
      text: htmlToReadableText(SPA_HTML),
    });
    assert(reason !== null, "must escalate");
    assert(reason!.includes('id="root"'), reason!);
  });

  test("a bot wall escalates even when it has plenty of text", () => {
    const wall = `<html><body><h1>Just a moment...</h1>${"padding text ".repeat(60)}</body></html>`;
    const reason = shouldEscalate({
      status: 200,
      contentType: "text/html",
      html: wall,
      text: htmlToReadableText(wall),
    });
    assert(reason !== null && reason.includes("Cloudflare"), String(reason));
  });

  test("401/403/429/503 escalate; 404 does not", () => {
    for (const status of [401, 403, 429, 503]) {
      assert(
        shouldEscalate({ status, contentType: "text/html", html: "", text: "" }) !== null,
        `status ${status} must escalate`,
      );
    }
    assert(
      shouldEscalate({
        status: 404,
        contentType: "text/html",
        html: "<html><body>Not found</body></html>",
        text: "Not found",
      }) === null,
      "a 404 is an answer; a browser will not invent a page",
    );
  });

  test("a small page with no script to run is not a shell", () => {
    const small = `<!doctype html><html><head><title>Ping</title></head><body>
      <h1>Status</h1><p>All systems normal.</p></body></html>`;
    assert(
      shouldEscalate({
        status: 200,
        contentType: "text/html",
        html: small,
        text: htmlToReadableText(small),
      }) === null,
      "no scripts means a browser changes nothing",
    );
  });

  test("a short but real page with one script stays on the http rung", () => {
    // The failure this guards: 154 chars of genuine content behind one
    // analytics tag used to escalate purely for being short.
    const short = `<!doctype html><html><head><title>Cards</title></head><body>
      <h1>Graphics cards</h1><p>Prix sur demande</p>
      <article><span>ZOTAC RTX 5080</span><span>KSh 250,000</span></article>
      <script>window.analytics=1</script></body></html>`;
    const text = htmlToReadableText(short);
    assert(text.length < 200, `fixture should be thin: ${text.length}`);
    assert(
      shouldEscalate({ status: 200, contentType: "text/html", html: short, text }) === null,
      "content that is a real share of the markup is real content",
    );
  });

  test("a frame-based page escalates so the browser can read the frames", () => {
    const framed = `<html><head><title>Docs</title></head><frameset><frame src="/body.html"></frameset></html>`;
    const reason = shouldEscalate({
      status: 200,
      contentType: "text/html",
      html: framed,
      text: htmlToReadableText(framed),
    });
    assert(reason !== null && reason.includes("frames"), String(reason));
  });

  test("JSON is never treated as a shell", () => {
    const body = '{"ok":true}';
    assert(
      shouldEscalate({
        status: 200,
        contentType: "application/json",
        html: body,
        text: body,
      }) === null,
      "json must answer at the http rung",
    );
  });

  console.log("live fetch over loopback:");

  const server = await startServer(path => {
    if (path.startsWith("/spa")) return { body: SPA_HTML };
    if (path.startsWith("/json")) {
      return { type: "application/json", body: '{"items":[{"price":250000}]}' };
    }
    if (path.startsWith("/png")) {
      return { type: "image/png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) };
    }
    if (path.startsWith("/403")) return { status: 403, body: "<html>denied</html>" };
    if (path.startsWith("/slow")) return { body: ARTICLE_HTML, delayMs: 500 };
    return { body: ARTICLE_HTML };
  });

  try {
    await testAsync("reads a server-rendered page without escalating", async () => {
      const result = await fetchHttpRung(`${server.base}/article`);
      assert(result.ok && result.status === 200, `status ${result.status}`);
      assert(!result.escalate, `must not escalate: ${result.escalateReason}`);
      assert(result.title === "Prices & Stock", String(result.title));
      assert(result.text.includes("ZOTAC RTX 5080"), "content must be extracted");
    });

    await testAsync("flags a client-rendered page for escalation", async () => {
      const result = await fetchHttpRung(`${server.base}/spa`);
      assert(result.escalate, "shell must escalate");
      assert(result.escalateReason!.includes("root"), result.escalateReason!);
    });

    await testAsync("returns JSON verbatim at the http rung", async () => {
      const result = await fetchHttpRung(`${server.base}/json`);
      assert(!result.escalate, "json must not escalate");
      assert(result.text.includes('"price":250000'), result.text);
      assert(result.title === undefined, "json has no title");
    });

    await testAsync("reports binary bodies instead of decoding them", async () => {
      const result = await fetchHttpRung(`${server.base}/png`);
      assert(result.binary === true, "must be flagged binary");
      assert(result.text === "", "binary must not be decoded into text");
      assert(!result.escalate, "a browser reads a PNG no better");
    });

    await testAsync("a 403 escalates with the status as evidence", async () => {
      const result = await fetchHttpRung(`${server.base}/403`);
      assert(result.escalate && result.escalateReason!.includes("403"), String(result.escalateReason));
    });

    await testAsync("a timeout is a result, not a throw", async () => {
      const result = await fetchHttpRung(`${server.base}/slow`, { timeoutMs: 60 });
      assert(!result.ok, "must not report success");
      assert(result.escalate, "a timeout is worth one browser attempt");
      assert(result.error!.includes("Timed out"), result.error!);
    });

    await testAsync("a caller abort is honored and reported", async () => {
      const controller = new AbortController();
      const pending = fetchHttpRung(`${server.base}/slow`, { signal: controller.signal });
      controller.abort();
      const result = await pending;
      assert(!result.ok, "aborted request must not claim success");
    });

    await testAsync("a dead port fails cleanly", async () => {
      const result = await fetchHttpRung("http://127.0.0.1:1/nothing", { timeoutMs: 2000 });
      assert(!result.ok, "must fail");
      assert(result.error !== undefined, "must carry an error");
    });
  } finally {
    await server.close();
  }

  console.log("rung reporting:");

  test("the rung line names the surface and the reason", () => {
    assert(formatRung("http", { bytes: 120814, words: 4102, ms: 900 }).startsWith("rung=http"), "http");
    const line = formatRung("chromium", { ms: 2100, escalatedFrom: 'empty <div id="root">' });
    assert(line.includes("rung=chromium") && line.includes("escalated from http"), line);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
