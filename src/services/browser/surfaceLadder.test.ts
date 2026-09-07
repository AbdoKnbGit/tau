/**
 * The surface ladder end to end: a real HTTP request against a loopback server,
 * a fake browser, and the decision between them.
 *
 * Run: bun run src/services/browser/surfaceLadder.test.ts
 */

import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

import type { ReadResult } from "./pageScripts.js";
import { runSurfaceLadder, type LadderSessionLike } from "./surfaceLadder.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, hint: string): void {
  if (!condition) throw new Error(hint);
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

const ARTICLE = `<!doctype html><html><head><title>Catalogue</title></head><body>
<h1>Graphics cards</h1><p>${"Server-rendered prose that a plain fetch can read. ".repeat(40)}</p>
<ul><li>ZOTAC RTX 5080 — KSh 250,000</li></ul></body></html>`;

const SHELL = `<!doctype html><html><head><title>App</title></head><body>
<div id="root"></div><script src="/app.js"></script></body></html>`;

function fakeSession(options: { read?: ReadResult; running?: boolean } = {}): LadderSessionLike & {
  calls: string[];
} {
  const calls: string[] = [];
  let running = options.running ?? false;
  return {
    calls,
    isRunning: () => running,
    async ensureStarted() {
      calls.push("ensureStarted");
      running = true;
      return { launched: "spawned", note: "Launched a browser." };
    },
    async navigate(url) {
      calls.push(`navigate ${url}`);
    },
    async readPage() {
      calls.push("readPage");
      return (
        options.read ?? {
          success: true,
          url: "http://rendered.test/",
          title: "Rendered",
          content: "Rendered content the browser could see",
          total: 38,
          offset: 0,
        }
      );
    },
    getLastKnownUrl: () => "http://rendered.test/",
    drainSessionNotes: () => [],
  };
}

function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server: Server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/spa")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(SHELL);
        return;
      }
      if (path.startsWith("/blocked")) {
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<html><body>denied</body></html>");
        return;
      }
      if (path.startsWith("/gone")) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("");
        return;
      }
      if (path.startsWith("/data")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"items":[{"name":"ZOTAC RTX 5080","price":250000}]}');
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE);
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
  const server = await startServer();
  try {
    console.log("staying on the cheap rung:");

    await testAsync("a server-rendered page never starts the browser", async () => {
      const session = fakeSession();
      const result = await runSurfaceLadder(session, { url: `${server.base}/article` });
      assert(result.ok && result.rungUsed === "http", JSON.stringify(result));
      assert(result.text!.includes("ZOTAC RTX 5080"), "content must come back");
      assert(result.title === "Catalogue", String(result.title));
      assert(session.calls.length === 0, `browser was touched: ${session.calls.join(", ")}`);
      assert(result.rung.startsWith("rung=http"), result.rung);
    });

    await testAsync("JSON answers on the cheap rung too", async () => {
      const session = fakeSession();
      const result = await runSurfaceLadder(session, { url: `${server.base}/data` });
      assert(result.text!.includes('"price":250000'), result.text!);
      assert(session.calls.length === 0, "no browser for an API response");
    });

    await testAsync("long text is truncated with an honest note", async () => {
      const session = fakeSession();
      const full = await runSurfaceLadder(session, { url: `${server.base}/article` });
      // maxChars is clamped to the same 500-character floor as the read action.
      const result = await runSurfaceLadder(session, {
        url: `${server.base}/article`,
        maxChars: 500,
      });
      assert(full.text!.length > 500, `fixture is too short to truncate: ${full.text!.length}`);
      assert(result.text!.includes("more characters not shown"), result.text!.slice(-120));
      assert(result.text!.startsWith(full.text!.slice(0, 500)), "the kept slice is the head");
    });

    console.log("escalating on evidence:");

    await testAsync("an empty shell escalates and says why", async () => {
      const session = fakeSession();
      const result = await runSurfaceLadder(session, { url: `${server.base}/spa` });
      assert(result.rungUsed === "chromium", JSON.stringify(result));
      assert(result.rung.includes("escalated from http"), result.rung);
      assert(result.rung.includes("root"), result.rung);
      assert(session.calls.includes("ensureStarted"), JSON.stringify(session.calls));
      assert(
        session.calls.some(call => call.startsWith("navigate")),
        JSON.stringify(session.calls),
      );
      assert(result.text === "Rendered content the browser could see", String(result.text));
    });

    await testAsync("a 403 escalates", async () => {
      const session = fakeSession();
      const result = await runSurfaceLadder(session, { url: `${server.base}/blocked` });
      assert(result.rungUsed === "chromium", JSON.stringify(result));
      assert(result.rung.includes("403"), result.rung);
    });

    await testAsync("an already-running browser is reused, not restarted", async () => {
      const session = fakeSession({ running: true });
      await runSurfaceLadder(session, { url: `${server.base}/spa` });
      assert(!session.calls.includes("ensureStarted"), JSON.stringify(session.calls));
    });

    console.log("forced surfaces:");

    await testAsync("surface:http stays put but warns when the answer looks thin", async () => {
      const session = fakeSession();
      const result = await runSurfaceLadder(session, {
        url: `${server.base}/spa`,
        surface: "http",
      });
      assert(result.rungUsed === "http", JSON.stringify(result));
      assert(session.calls.length === 0, "must not escalate when forced");
      assert(
        result.warnings.some(warning => warning.includes("looks unreliable")),
        JSON.stringify(result.warnings),
      );
    });

    await testAsync("surface:chromium skips the fetch entirely", async () => {
      const session = fakeSession();
      const result = await runSurfaceLadder(session, {
        url: `${server.base}/article`,
        surface: "chromium",
      });
      assert(result.rungUsed === "chromium", JSON.stringify(result));
      assert(!result.rung.includes("escalated"), "not an escalation — it was asked for");
    });

    await testAsync("a file:// url goes straight to the browser", async () => {
      const session = fakeSession();
      const result = await runSurfaceLadder(session, { url: "file:///tmp/page.html" });
      assert(result.rungUsed === "chromium", JSON.stringify(result));
      assert(
        session.calls.some(call => call === "navigate file:///tmp/page.html"),
        JSON.stringify(session.calls),
      );
    });

    console.log("failures:");

    await testAsync("an empty 404 body is reported, not escalated into a lie", async () => {
      const session = fakeSession();
      const result = await runSurfaceLadder(session, {
        url: `${server.base}/gone`,
        surface: "http",
      });
      assert(!result.ok, "must not claim success");
      assert(result.message.includes("404"), result.message);
    });

    await testAsync("a browser read failure surfaces its reason", async () => {
      const session = fakeSession({
        read: { success: false, error: "no readable content", reason: "no_match" },
      });
      const result = await runSurfaceLadder(session, {
        url: `${server.base}/article`,
        surface: "chromium",
      });
      assert(!result.ok, "must not claim success");
      assert(result.reason === "no_match", String(result.reason));
    });

    await testAsync("an unreachable host escalates once and then reports honestly", async () => {
      const session = fakeSession({
        read: { success: false, error: "no page", reason: "timeout" },
      });
      const result = await runSurfaceLadder(session, {
        url: "http://127.0.0.1:1/nothing",
        timeoutMs: 2000,
      });
      assert(result.rungUsed === "chromium", "a transport failure is worth one browser try");
      assert(!result.ok, "and the failure is still reported");
    });
  } finally {
    await server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
