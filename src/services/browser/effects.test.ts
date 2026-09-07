/**
 * Proof-of-effect receipts.
 *
 * Run: bun run src/services/browser/effects.test.ts
 */

import {
  diffEffect,
  formatEffect,
  isMutatingAction,
  STATE_PROBE_SCRIPT,
  type PageStateSnapshot,
} from "./effects.js";

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

function snapshot(patch: Partial<PageStateSnapshot> = {}): PageStateSnapshot {
  return {
    docId: "d1",
    url: "https://example.test/a",
    title: "A",
    elements: 40,
    sig: "abc",
    textLen: 1000,
    scrollY: 0,
    readyState: "complete",
    ...patch,
  };
}

/**
 * Minimal DOM good enough for the probe. Deliberately hand-rolled: the point is
 * to prove the injected source parses and returns the documented shape without
 * pulling a DOM implementation into the test tree.
 */
function fakeDom(options: {
  nodes?: Array<Record<string, unknown>>;
  href?: string;
  bodyText?: string;
  throwOnQuery?: boolean;
}) {
  const nodes = options.nodes ?? [];
  const win: Record<string, unknown> = { scrollY: 12 };
  const doc = {
    title: "Fake",
    readyState: "complete",
    body: { innerText: options.bodyText ?? "hello world" },
    querySelectorAll(): unknown[] {
      if (options.throwOnQuery) throw new Error("blocked");
      return nodes;
    },
  };
  const loc = { href: options.href ?? "https://example.test/a" };
  const run = new Function(
    "window",
    "document",
    "location",
    `return ${STATE_PROBE_SCRIPT};`,
  ) as (
    w: unknown,
    d: unknown,
    l: unknown,
  ) => PageStateSnapshot | null;
  return { win, result: run(win, doc, loc) };
}

function main(): void {
  console.log("state probe script:");

  test("returns the documented shape and mints a document id", () => {
    const { win, result } = fakeDom({
      nodes: [
        { tagName: "A", id: "one", textContent: " Sign in ", value: null },
        { tagName: "BUTTON", id: "", textContent: "Buy", disabled: true },
      ],
    });
    assert(result !== null, "probe must return a sample");
    assert(result!.elements === 2, `elements should be 2, got ${result!.elements}`);
    assert(result!.url === "https://example.test/a", "url must come from location");
    assert(result!.textLen === "hello world".length, "textLen must measure body text");
    assert(result!.scrollY === 12, "scrollY must be read from the window");
    assert(/^d[a-z0-9]+$/.test(result!.docId), `docId shape: ${result!.docId}`);
    assert(win.__tauDocId === result!.docId, "docId must persist on the window");
  });

  test("same DOM hashes identically, changed label does not", () => {
    const nodes = [{ tagName: "BUTTON", id: "b", textContent: "Save" }];
    const first = fakeDom({ nodes }).result!;
    const second = fakeDom({ nodes }).result!;
    assert(first.sig === second.sig, "identical DOM must hash the same");
    const changed = fakeDom({
      nodes: [{ tagName: "BUTTON", id: "b", textContent: "Saving…" }],
    }).result!;
    assert(changed.sig !== first.sig, "a changed label must change the signature");
  });

  test("survives a page that blocks querySelectorAll", () => {
    const { result } = fakeDom({ throwOnQuery: true });
    assert(result !== null, "probe must not throw on a hostile page");
    assert(result!.elements === 0, "blocked query yields zero elements");
  });

  console.log("effect diffing:");

  test("a click that changed nothing is reported as a no-op", () => {
    const effect = diffEffect("click", snapshot(), snapshot(), 7, 90);
    assert(effect.noop, "identical before/after on a click is a no-op");
    assert(
      formatEffect(effect).includes("NO OBSERVABLE EFFECT"),
      "the receipt must say so in words",
    );
  });

  test("an observe that changed nothing is not a no-op", () => {
    const effect = diffEffect("observe", snapshot(), snapshot(), 8, 40);
    assert(!effect.noop, "read-only actions never carry a no-op verdict");
  });

  test("eval that returned a value is not a no-op", () => {
    const effect = diffEffect("eval", snapshot(), snapshot(), 9, 30, {
      producedValue: true,
    });
    assert(!effect.noop, "a returned value is itself an effect");
  });

  test("eval that returned nothing and touched nothing is a no-op", () => {
    const effect = diffEffect("eval", snapshot(), snapshot(), 10, 30, {
      producedValue: false,
    });
    assert(effect.noop, "silent eval with no DOM change must be flagged");
  });

  test("navigation reports a new document and the new url", () => {
    const effect = diffEffect(
      "navigate",
      snapshot(),
      snapshot({ docId: "d2", url: "https://example.test/b", sig: "zzz" }),
      11,
      800,
    );
    assert(effect.docChanged && effect.urlChanged, "both must be flagged");
    const text = formatEffect(effect);
    assert(text.includes("new document"), `receipt: ${text}`);
    assert(text.includes("https://example.test/b"), `receipt: ${text}`);
  });

  test("scroll alone counts as an effect for the scroll action", () => {
    const effect = diffEffect("scroll", snapshot(), snapshot({ scrollY: 400 }), 12, 20);
    assert(!effect.noop, "scrolling is what the scroll action does");
    assert(formatEffect(effect).includes("scrolled"), "receipt must mention it");
  });

  test("a click is not excused by the scroll the tool itself performed", () => {
    // Targeting scrolls the element into view, so on any long page a click
    // moves scrollY. Treating that as evidence would hide every no-op.
    const effect = diffEffect("click", snapshot(), snapshot({ scrollY: 900 }), 13, 40);
    assert(effect.noop, "a click that only moved the viewport did nothing");
    const text = formatEffect(effect);
    assert(text.includes("NO OBSERVABLE EFFECT"), text);
    assert(text.includes("scrolled only because I moved the target"), text);
  });

  test("a click that scrolled AND changed the dom is a real effect", () => {
    const effect = diffEffect("click", snapshot(), snapshot({ scrollY: 900, sig: "zzz" }), 14, 40);
    assert(!effect.noop, "the dom change is the evidence");
  });

  test("a same-url in-place re-render is still a change", () => {
    const effect = diffEffect(
      "click",
      snapshot(),
      snapshot({ sig: "def", elements: 44, textLen: 1200 }),
      13,
      120,
    );
    assert(!effect.noop, "SPA updates must not read as no-ops");
    assert(
      formatEffect(effect).includes("dom changed (40→44 interactive)"),
      formatEffect(effect),
    );
  });

  test("a missing after-sample is reported as unverified, never as success", () => {
    const effect = diffEffect("click", snapshot(), null, 14, 50);
    assert(effect.unverified !== undefined, "must be marked unverified");
    assert(!effect.noop, "unverified is not the same as no-op");
    assert(formatEffect(effect).includes("unverified"), "receipt must say so");
  });

  test("a missing before-sample does not claim anything changed", () => {
    const effect = diffEffect("navigate", null, snapshot(), 1, 500);
    assert(effect.unverified !== undefined, "no baseline to compare against");
    assert(!effect.urlChanged && !effect.domChanged, "nothing may be claimed");
  });

  test("mutating classification covers acting and excludes looking", () => {
    for (const action of ["click", "fill", "eval", "navigate", "dismiss", "get"]) {
      assert(isMutatingAction(action), `${action} must be mutating`);
    }
    for (const action of ["observe", "read", "screenshot", "console", "tabs", "measure"]) {
      assert(!isMutatingAction(action), `${action} must not be mutating`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
