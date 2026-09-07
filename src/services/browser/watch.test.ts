/**
 * Standing observations: spec parsing, event matching, DOM checks.
 *
 * Run: bun run src/services/browser/watch.test.ts
 */

import {
  buildWatchDomScript,
  formatWatchReport,
  matchEventAlerts,
  parseWatchSpec,
  type WatchCondition,
  type WatchDomResult,
} from "./watch.js";

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

function condition(spec: string): WatchCondition {
  const parsed = parseWatchSpec(spec);
  if ("error" in parsed) throw new Error(`${spec}: ${parsed.error}`);
  return parsed;
}

function runDom(
  conditions: WatchCondition[],
  page: {
    url?: string;
    bodyText?: string;
    selectors?: Record<string, { width: number; height: number } | "throw" | null>;
  },
): WatchDomResult[] {
  const doc = {
    body: { innerText: page.bodyText ?? "", textContent: page.bodyText ?? "" },
    querySelector(selector: string): unknown {
      const found = page.selectors?.[selector];
      if (found === "throw") throw new Error("bad selector");
      if (!found) return null;
      return {
        getBoundingClientRect: () => ({ width: found.width, height: found.height }),
      };
    },
  };
  const run = new Function(
    "window",
    "document",
    "location",
    "getComputedStyle",
    `return ${buildWatchDomScript(conditions)};`,
  ) as (w: unknown, d: unknown, l: unknown, g: unknown) => WatchDomResult[];
  return run({}, doc, { href: page.url ?? "http://127.0.0.1:8080/" }, () => ({
    visibility: "visible",
    display: "block",
  }));
}

function main(): void {
  console.log("spec parsing:");

  test("parses bare kinds and kinds with arguments", () => {
    assert(condition("console.error").kind === "console.error", "bare");
    assert(condition("selector.gone:#cart").arg === "#cart", "argument");
    assert(condition("text.appears:Order placed").arg === "Order placed", "spaces kept");
    assert(condition("url.matches:/checkout?step=2").arg === "/checkout?step=2", "colons in arg");
  });

  test("rejects unknown kinds and missing arguments with a usable message", () => {
    const unknown = parseWatchSpec("console.everything");
    assert("error" in unknown && unknown.error.includes("Unknown watch condition"), JSON.stringify(unknown));
    const missing = parseWatchSpec("selector.gone");
    assert("error" in missing && missing.error.includes("needs an argument"), JSON.stringify(missing));
    assert("error" in parseWatchSpec("   "), "empty rejected");
  });

  console.log("event matching:");

  const consoleEntries = [
    { ts: 100, level: "log", text: "hydrated" },
    { ts: 200, level: "error", text: "Cannot read properties of undefined (reading 'map')" },
    { ts: 300, level: "warning", text: "deprecated prop" },
    { ts: 400, level: "exception", text: "TypeError: x is not a function" },
  ];
  const networkEntries = [
    { ts: 150, method: "GET", url: "http://127.0.0.1:8080/api/products", status: 200 },
    { ts: 250, method: "GET", url: "http://127.0.0.1:8080/api/cart", status: 500 },
    { ts: 350, method: "POST", url: "http://127.0.0.1:8080/api/order", error: "net::ERR_CONNECTION_REFUSED" },
  ];

  test("console.error catches errors and uncaught exceptions, not logs", () => {
    const alerts = matchEventAlerts([condition("console.error")], {
      console: consoleEntries,
      network: [],
      sinceTs: 0,
    });
    assert(alerts.length === 2, JSON.stringify(alerts));
    assert(alerts[0]!.detail.includes("reading 'map'"), alerts[0]!.detail);
    assert(alerts[1]!.detail.includes("TypeError"), alerts[1]!.detail);
  });

  test("the cursor prevents re-reporting what was already delivered", () => {
    const alerts = matchEventAlerts([condition("console.error")], {
      console: consoleEntries,
      network: [],
      sinceTs: 200,
    });
    assert(alerts.length === 1, JSON.stringify(alerts));
    assert(alerts[0]!.ts === 400, String(alerts[0]!.ts));
  });

  test("request.failed catches 4xx/5xx and transport errors, not successes", () => {
    const alerts = matchEventAlerts([condition("request.failed")], {
      console: [],
      network: networkEntries,
      sinceTs: 0,
    });
    assert(alerts.length === 2, JSON.stringify(alerts));
    assert(alerts[0]!.detail.includes("500"), alerts[0]!.detail);
    assert(alerts[1]!.detail.includes("ERR_CONNECTION_REFUSED"), alerts[1]!.detail);
  });

  test("an argument narrows a condition to matching text or urls", () => {
    const narrowed = matchEventAlerts([condition("request.failed:/api/cart")], {
      console: [],
      network: networkEntries,
      sinceTs: 0,
    });
    assert(narrowed.length === 1, JSON.stringify(narrowed));
    const consoleNarrowed = matchEventAlerts([condition("console.any:deprecated")], {
      console: consoleEntries,
      network: [],
      sinceTs: 0,
    });
    assert(consoleNarrowed.length === 1, JSON.stringify(consoleNarrowed));
  });

  test("alerts from several conditions come back in time order", () => {
    const alerts = matchEventAlerts(
      [condition("console.error"), condition("request.failed")],
      { console: consoleEntries, network: networkEntries, sinceTs: 0 },
    );
    const stamps = alerts.map(alert => alert.ts);
    assert(
      stamps.every((value, index) => index === 0 || value >= stamps[index - 1]!),
      JSON.stringify(stamps),
    );
  });

  test("dom conditions are not matched as events", () => {
    const alerts = matchEventAlerts([condition("selector.gone:#cart")], {
      console: consoleEntries,
      network: networkEntries,
      sinceTs: 0,
    });
    assert(alerts.length === 0, "dom conditions belong to the page check");
  });

  console.log("dom checks:");

  test("selector.appears fires only for a visible element", () => {
    const results = runDom([condition("selector.appears:#cart")], {
      selectors: { "#cart": { width: 100, height: 40 } },
    });
    assert(results[0]!.hit, JSON.stringify(results));
    const zeroSize = runDom([condition("selector.appears:#cart")], {
      selectors: { "#cart": { width: 0, height: 0 } },
    });
    assert(!zeroSize[0]!.hit, "a zero-size element is not visible");
  });

  test("selector.gone fires when the element is missing", () => {
    const missing = runDom([condition("selector.gone:.spinner")], { selectors: {} });
    assert(missing[0]!.hit && missing[0]!.detail.includes("no longer visible"), JSON.stringify(missing));
    const present = runDom([condition("selector.gone:.spinner")], {
      selectors: { ".spinner": { width: 20, height: 20 } },
    });
    assert(!present[0]!.hit, "still visible");
  });

  test("text.appears and url.matches read the live page", () => {
    const results = runDom(
      [condition("text.appears:Commande confirmée"), condition("url.matches:/checkout")],
      { bodyText: "Merci — Commande confirmée", url: "http://127.0.0.1:8080/checkout?step=3" },
    );
    assert(results[0]!.hit, "text");
    assert(results[1]!.hit, "url");
  });

  test("an invalid selector is reported, not swallowed", () => {
    const results = runDom([condition("selector.appears:div[")], { selectors: { "div[": "throw" } });
    assert(results[0]!.invalid === true, JSON.stringify(results));
    assert(!results[0]!.hit, "must not count as a hit");
  });

  console.log("reporting:");

  test("says plainly when nothing fired", () => {
    const text = formatWatchReport({
      conditions: [condition("console.error")],
      alerts: [],
      dom: [],
    });
    assert(text.includes("Nothing fired since the last check."), text);
  });

  test("separates events, met conditions and broken conditions", () => {
    const text = formatWatchReport({
      conditions: [condition("console.error"), condition("selector.gone:.spinner")],
      alerts: [{ spec: "console.error", detail: "[error] boom", ts: 1 }],
      dom: [
        { spec: "selector.gone:.spinner", hit: true, detail: "no longer visible" },
        { spec: "selector.appears:#x", hit: false, detail: "invalid selector: bad", invalid: true },
      ],
    });
    assert(text.includes("new event(s)"), text);
    assert(text.includes("Page conditions met:"), text);
    assert(text.includes("Broken conditions:"), text);
  });

  test("with no conditions it explains how to add them", () => {
    const text = formatWatchReport({ conditions: [], alerts: [], dom: [] });
    assert(text.includes("No watch conditions are registered"), text);
    assert(text.includes("console.error"), "must show an example");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
