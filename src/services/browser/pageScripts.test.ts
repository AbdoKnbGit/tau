/**
 * Tests for the pure page-processing helpers of the Browser tool: payload
 * pruning (token economy on huge pages) and blocker detection (CAPTCHA/login
 * walls). The in-page script STRINGS are exercised end-to-end by the CDP smoke
 * test against a real browser; here we cover the Node-side pure functions.
 *
 * Run: bun run src/services/browser/pageScripts.test.ts
 */

import {
  classifyCoordinateStreak,
  clipBody,
  formatConsoleEntries,
  formatNetworkEntries,
  selectNetworkEntries,
  getBrowserSession,
  normalizeUrlForNavigation,
  parseChord,
  resolveClickTarget,
  type BrowserSessionService,
  type ConsoleEntry,
  type NetworkEntry,
} from "./browserSession.js";
import {
  buildStealthScript,
  stealthPlatformFromUserAgent,
  detectBlocker,
  ELEMENT_INFO_JS,
  MAX_OBSERVED_ELEMENTS,
  OBSERVE_SCRIPT,
  PAGE_TOOLS_SCRIPT,
  prunePayloadElements,
  READ_HELPERS_JS,
  type InteractiveElement,
  type ObservedState,
} from "./pageScripts.js";

let passed = 0;
let failed = 0;

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

function assert(cond: boolean, hint: string): void {
  if (!cond) throw new Error(hint);
}

function el(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    id: 0,
    tag: "div",
    text: "",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    ...over,
  };
}

function obs(over: Partial<ObservedState>): ObservedState {
  return {
    url: "https://x.test/",
    title: "",
    text_sample: "",
    interactive_elements: [],
    ...over,
  };
}

async function main(): Promise<void> {
  console.log("prunePayloadElements:");

  test("caps very long text with an ellipsis", () => {
    const [out] = prunePayloadElements([el({ text: "a".repeat(200) })]);
    assert(
      !!out && out.text.length <= 70,
      `capped length was ${out?.text.length}`,
    );
    assert(!!out && out.text.endsWith("…"), "should end with ellipsis");
  });

  test("collapses a run of >=6 identical elements", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      el({ id: i, tag: "a", text: "Item", x: i, y: 0 }),
    );
    const out = prunePayloadElements(many);
    assert(
      out.length < many.length,
      `expected fewer than ${many.length}, got ${out.length}`,
    );
    assert(
      out.some((e) => (e.repeatNote ?? 0) > 0),
      "a representative should carry repeatNote",
    );
  });

  test("keeps distinct adjacent list items (no over-merge)", () => {
    const items = [
      el({ id: 0, tag: "a", text: "Apple", x: 0, y: 0 }),
      el({ id: 1, tag: "a", text: "Banana", x: 0, y: 20 }),
      el({ id: 2, tag: "a", text: "Cherry", x: 0, y: 40 }),
    ];
    const out = prunePayloadElements(items);
    assert(out.length === 3, `distinct items must survive, got ${out.length}`);
  });

  test("merges parent/child duplicate at the same exact point", () => {
    const dup = [
      el({ id: 0, tag: "div", text: "Sign in", x: 100, y: 50 }),
      el({ id: 1, tag: "button", text: "Sign in", x: 100, y: 50 }),
    ];
    const out = prunePayloadElements(dup);
    assert(
      out.length === 1,
      `same-point duplicate should merge, got ${out.length}`,
    );
  });

  test("preserves ref ids (no renumber) so gaps are intentional", () => {
    const items = [
      el({ id: 5, tag: "a", text: "X", x: 0, y: 0 }),
      el({ id: 9, tag: "a", text: "Y", x: 0, y: 20 }),
    ];
    const out = prunePayloadElements(items);
    assert(out[0]?.id === 5 && out[1]?.id === 9, "ids must be preserved");
  });

  console.log("detectBlocker:");

  test("detects a CAPTCHA wall", () => {
    const b = detectBlocker(
      obs({ text_sample: "Please verify you are human to continue" }),
    );
    assert(b?.kind === "captcha", "should detect captcha");
  });

  test('detects "I am not a robot"', () => {
    const b = detectBlocker(obs({ text_sample: "confirm you're not a robot" }));
    assert(b?.kind === "captcha", "should detect captcha");
  });

  test("detects a login wall", () => {
    const b = detectBlocker(
      obs({ text_sample: "You must be logged in to view this page" }),
    );
    assert(b?.kind === "login", "should detect login");
  });

  test("does not false-positive on ordinary pages", () => {
    const b = detectBlocker(
      obs({
        title: "Dashboard",
        text_sample: "Welcome back, here are your stats",
      }),
    );
    assert(b === null, "ordinary page should not be flagged");
  });

  console.log("buildStealthScript:");

  test("masks navigator.webdriver", () => {
    const s = buildStealthScript(131);
    assert(s.includes("'webdriver'"), "should override webdriver");
    assert(
      s.includes("=> undefined"),
      "webdriver getter should return undefined",
    );
  });

  test("bakes the given Chrome major into userAgentData brands", () => {
    const s = buildStealthScript(140);
    assert(s.includes("version: '140'"), "should use the provided major");
  });

  test("falls back to a default major for bad input", () => {
    const s = buildStealthScript(NaN);
    assert(s.includes("version: '131'"), "NaN major should default");
  });

  test("platform identity follows the browser's own user agent", () => {
    const mac = stealthPlatformFromUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0",
      "darwin",
      "arm64",
    );
    assert(mac.navigator === "MacIntel", mac.navigator);
    assert(mac.uaData === "macOS", mac.uaData);
    assert(mac.version === "10.15.7", mac.version);
    assert(mac.architecture === "arm", mac.architecture);

    const windows = stealthPlatformFromUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0",
      "win32",
      "x64",
    );
    assert(windows.navigator === "Win32", windows.navigator);
    assert(windows.version === "10.0.0", windows.version);
    assert(windows.bitness === "64", windows.bitness);

    const linux = stealthPlatformFromUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0",
      "linux",
      "x64",
    );
    assert(linux.navigator === "Linux x86_64", linux.navigator);
    assert(linux.uaData === "Linux", linux.uaData);
  });

  test("with no user agent it follows the host instead of pinning Windows", () => {
    assert(stealthPlatformFromUserAgent(undefined, "darwin", "arm64").uaData === "macOS", "mac host");
    assert(stealthPlatformFromUserAgent(undefined, "win32", "x64").uaData === "Windows", "windows host");
    assert(stealthPlatformFromUserAgent(undefined, "linux", "x64").uaData === "Linux", "linux host");
  });

  test("the injected script carries the derived platform, not a fixed one", () => {
    const mac = buildStealthScript(
      131,
      stealthPlatformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "darwin", "arm64"),
    );
    assert(mac.includes("platform: 'macOS'"), "userAgentData platform must be macOS");
    assert(mac.includes("platformVersion: '10.15.7'"), "platform version must match");
    assert(!mac.includes("'Windows'"), "no Windows must survive on a Mac");
  });

  console.log("observation cap:");

  test("MAX_OBSERVED_ELEMENTS defaults into a sane range", () => {
    assert(
      MAX_OBSERVED_ELEMENTS >= 20 && MAX_OBSERVED_ELEMENTS <= 500,
      `cap out of range: ${MAX_OBSERVED_ELEMENTS}`,
    );
  });

  test("OBSERVE_SCRIPT caps collection at MAX_OBSERVED_ELEMENTS", () => {
    assert(
      OBSERVE_SCRIPT.includes(`const MAX = ${MAX_OBSERVED_ELEMENTS}`),
      "observe script should bake in the cap constant",
    );
    assert(
      OBSERVE_SCRIPT.includes("elements.length >= MAX"),
      "collector must stop at the cap",
    );
  });

  test("OBSERVE_SCRIPT recurses same-origin iframes with offsets", () => {
    assert(OBSERVE_SCRIPT.includes("contentDocument"), "must traverse iframes");
    assert(
      OBSERVE_SCRIPT.includes("crossFrames"),
      "must count cross-origin frames",
    );
  });

  test("page tools expose the in-page helpers the actions rely on", () => {
    for (const helper of [
      "dismissTopOverlay",
      "absRect",
      "readPage",
      "annotate",
      "clearAnnotations",
      "resolveFileInput",
      "syntheticDrag",
      "waitForCondition",
      "scrollToRef",
      "rectOfRefNoScroll",
    ]) {
      assert(
        PAGE_TOOLS_SCRIPT.includes(helper),
        `PAGE_TOOLS_SCRIPT must define ${helper}`,
      );
    }
  });

  test("page tools distinguish missing, unknown, and detached refs", () => {
    type RefResult = {
      success: boolean;
      reason?: string;
      staleKind?: string;
    };
    type TestPageTools = { prepareRef(ref: number): RefResult };
    const fakeDocument = {};
    const load = new Function(
      "window",
      "document",
      `${PAGE_TOOLS_SCRIPT}\nreturn window.__tauPageTools;`,
    ) as (
      window: Record<string, unknown>,
      document: Record<string, unknown>,
    ) => TestPageTools;
    const registry = (entries: Array<[number, object]>) => ({
      __tauPageConfig: { sessionKey: "test-session" },
      __tauRefState: {
        version: 2,
        sessionKey: "test-session",
        document: fakeDocument,
        elementToId: new WeakMap(),
        idToElement: new Map(entries),
        lastObservedIds: entries.map(([id]) => id),
      },
    });

    const missing = load(
      { __tauPageConfig: { sessionKey: "test-session" } },
      fakeDocument,
    ).prepareRef(7);
    assert(
      missing.reason === "stale_ref" &&
        missing.staleKind === "registry_missing",
      `missing registry kind: ${JSON.stringify(missing)}`,
    );

    const unknown = load(registry([]), fakeDocument).prepareRef(7);
    assert(
      unknown.reason === "stale_ref" && unknown.staleKind === "unknown_ref",
      `unknown ref kind: ${JSON.stringify(unknown)}`,
    );

    const detached = load(
      registry([
        [
          7,
          {
            isConnected: false,
            ownerDocument: fakeDocument,
          },
        ],
      ]),
      fakeDocument,
    ).prepareRef(7);
    assert(
      detached.reason === "stale_ref" && detached.staleKind === "detached",
      `detached ref kind: ${JSON.stringify(detached)}`,
    );
  });

  test("page helper injection hot-upgrades methods already present in a page", () => {
    const fakeDocument = {};
    const pageWindow = {
      __tauPageTools: { version: 1, label: () => "old implementation" },
    };
    const load = new Function(
      "window",
      "document",
      `${PAGE_TOOLS_SCRIPT}\nreturn window.__tauPageTools;`,
    ) as (
      window: Record<string, unknown>,
      document: Record<string, unknown>,
    ) => { version: number; label(el: object): string };
    const tools = load(pageWindow, fakeDocument);
    const node = {
      innerText: "fresh implementation",
      getAttribute: () => null,
    };
    assert(tools.version === 2, `helper version stayed ${tools.version}`);
    assert(
      tools.label(node) === "fresh implementation",
      "old helper was not replaced",
    );
  });

  test("never rebinds an observed ref to a different DOM element", () => {
    type AnyRecord = Record<string, any>;
    const pageWindow: AnyRecord = {
      innerWidth: 1280,
      innerHeight: 720,
      scrollY: 0,
      getComputedStyle: (node: AnyRecord) => node.style,
    };
    const fakeDocument: AnyRecord = {
      defaultView: pageWindow,
      title: "Ref identity fixture",
      documentElement: { scrollHeight: 720 },
      body: { innerText: "" },
      interactive: [] as AnyRecord[],
      querySelectorAll(selector: string) {
        return selector === "iframe,frame" ? [] : this.interactive;
      },
    };
    const makeElement = (
      tag: string,
      text: string,
      iconClass?: string,
    ): AnyRecord => {
      const icon = iconClass
        ? {
            getAttribute: (name: string) =>
              name === "class" ? iconClass : null,
          }
        : null;
      const node: AnyRecord = {
        tagName: tag.toUpperCase(),
        innerText: text,
        textContent: "",
        value: "",
        type: tag === "input" ? "text" : "button",
        checked: false,
        disabled: false,
        isConnected: true,
        ownerDocument: fakeDocument,
        style: {
          visibility: "visible",
          display: "block",
          pointerEvents: "auto",
          opacity: "1",
        },
        getBoundingClientRect: () => {
          const width = iconClass ? 32 : 120;
          return {
            left: 10,
            top: 10,
            right: 10 + width,
            bottom: 42,
            width,
            height: 32,
          };
        },
        getAttribute: (name: string) =>
          name === "placeholder" && tag === "input" ? "Search" : null,
        matches: () => false,
        querySelectorAll: () => (icon ? [icon] : []),
      };
      return node;
    };
    const runObserve = new Function(
      "window",
      "document",
      "location",
      "innerHeight",
      "innerWidth",
      "return (" + OBSERVE_SCRIPT + ")",
    ) as (
      window: AnyRecord,
      document: AnyRecord,
      location: { href: string },
      innerHeight: number,
      innerWidth: number,
    ) => ObservedState;
    const observe = (base: number, nodes: AnyRecord[]) => {
      pageWindow.__tauObserveConfig = {
        sessionKey: "identity-test",
        base,
      };
      fakeDocument.interactive = nodes;
      return runObserve(
        pageWindow,
        fakeDocument,
        { href: "https://fixture.test/" },
        720,
        1280,
      );
    };

    const input = makeElement("input", "");
    const first = observe(100, [input]);
    const inputId = first.interactive_elements[0]?.id;
    assert(inputId === 100, `first ref was @${inputId}`);

    const close = makeElement("button", "", "lucide lucide-x h-4 w-4");
    const reordered = observe(100 + MAX_OBSERVED_ELEMENTS, [close, input]);
    const survivingInput = reordered.interactive_elements.find(
      (el) => el.tag === "input",
    );
    const closeSummary = reordered.interactive_elements.find(
      (el) => el.tag === "button",
    );
    assert(
      survivingInput?.id === inputId,
      "surviving input changed ref after reorder",
    );
    assert(closeSummary?.id !== inputId, "new button reused the input ref");
    assert(
      closeSummary?.text === "Close",
      `icon button label was "${closeSummary?.text}"`,
    );

    input.isConnected = false;
    const replacement = makeElement("button", "Replacement");
    const third = observe(100 + MAX_OBSERVED_ELEMENTS * 2, [replacement]);
    const replacementId = third.interactive_elements[0]?.id;
    assert(
      replacementId !== inputId,
      "replacement node recycled the detached ref",
    );

    pageWindow.__tauPageConfig = { sessionKey: "identity-test" };
    const loadTools = new Function(
      "window",
      "document",
      `${PAGE_TOOLS_SCRIPT}\nreturn window.__tauPageTools;`,
    ) as (
      window: AnyRecord,
      document: AnyRecord,
    ) => {
      fillRef(
        ref: number,
        value: string,
      ): {
        success: boolean;
        reason?: string;
        staleKind?: string;
      };
    };
    const fillOldRef = loadTools(pageWindow, fakeDocument).fillRef(
      inputId!,
      "amlou",
    );
    assert(
      !fillOldRef.success && fillOldRef.reason === "stale_ref",
      `old input ref became ${fillOldRef.reason}: ${JSON.stringify(fillOldRef)}`,
    );
    assert(
      replacement.value === "",
      "stale fill mutated the replacement button",
    );
  });

  test("detects and dismisses a neutral full-screen layer with an SVG X", () => {
    type AnyRecord = Record<string, any>;
    let bodyElements: AnyRecord[] = [];
    let activations = 0;
    let syntheticClickEvents = 0;
    class FakeMouseEvent {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    }
    const pageWindow: AnyRecord = {
      innerWidth: 1200,
      innerHeight: 800,
      scrollY: 0,
      __tauPageConfig: { sessionKey: "overlay-test" },
      getComputedStyle: (node: AnyRecord) => node.style,
    };
    const fakeDocument: AnyRecord = {
      defaultView: pageWindow,
      body: {},
      documentElement: {},
      querySelectorAll(selector: string) {
        if (selector === "body *") return bodyElements;
        return [];
      },
      elementsFromPoint: () => bodyElements.slice().reverse(),
      elementFromPoint: () => bodyElements[0] || null,
    };
    const makeNode = (
      tag: string,
      rect: AnyRecord,
      style: AnyRecord,
      text = "",
    ): AnyRecord => ({
      tagName: tag.toUpperCase(),
      className: "",
      id: "",
      innerText: text,
      textContent: "",
      disabled: false,
      isConnected: true,
      ownerDocument: fakeDocument,
      parentElement: null,
      style,
      getBoundingClientRect: () => rect,
      getAttribute: () => null,
      matches: () => false,
      contains(node: AnyRecord) {
        let current = node;
        while (current) {
          if (current === this) return true;
          current = current.parentElement;
        }
        return false;
      },
      compareDocumentPosition: () => 0,
      querySelectorAll: () => [],
      querySelector: () => null,
      scrollIntoView: () => undefined,
      dispatchEvent(event: FakeMouseEvent) {
        if (event.type === "click") syntheticClickEvents++;
        return true;
      },
    });
    const backdrop = makeNode(
      "div",
      { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 },
      {
        position: "fixed",
        zIndex: "50",
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        visibility: "visible",
        display: "block",
        pointerEvents: "auto",
        opacity: "1",
      },
      "Your Cart",
    );
    const icon = {
      getAttribute: (name: string) =>
        name === "class" ? "lucide lucide-x h-4 w-4" : null,
    };
    const close = makeNode(
      "button",
      { left: 1148, top: 20, right: 1180, bottom: 52, width: 32, height: 32 },
      {
        position: "static",
        zIndex: "auto",
        backgroundColor: "transparent",
        visibility: "visible",
        display: "block",
        pointerEvents: "auto",
        opacity: "1",
      },
    );
    close.parentElement = backdrop;
    close.querySelectorAll = (selector: string) =>
      selector.includes("svg") ? [icon] : [];
    close.querySelector = (selector: string) =>
      selector.includes("svg") ? icon : null;
    close.click = () => {
      activations++;
      backdrop.isConnected = false;
    };
    backdrop.querySelectorAll = (selector: string) =>
      selector.includes("button,a[role") ? [close] : [];
    bodyElements = [backdrop, close];

    const target = makeNode(
      "button",
      { left: 100, top: 100, right: 240, bottom: 140, width: 140, height: 40 },
      {
        position: "static",
        zIndex: "auto",
        backgroundColor: "transparent",
        visibility: "visible",
        display: "block",
        pointerEvents: "auto",
        opacity: "1",
      },
      "ADD TO CART",
    );
    pageWindow.__tauRefState = {
      version: 2,
      sessionKey: "overlay-test",
      document: fakeDocument,
      elementToId: new WeakMap([[target, 19]]),
      idToElement: new Map([[19, target]]),
      lastObservedIds: [19],
    };
    const loadTools = new Function(
      "window",
      "document",
      "innerWidth",
      "innerHeight",
      "getComputedStyle",
      "MouseEvent",
      `${PAGE_TOOLS_SCRIPT}\nreturn window.__tauPageTools;`,
    ) as (
      window: AnyRecord,
      document: AnyRecord,
      innerWidth: number,
      innerHeight: number,
      getComputedStyle: (node: AnyRecord) => AnyRecord,
      MouseEvent: typeof FakeMouseEvent,
    ) => {
      prepareRef(ref: number): {
        success: boolean;
        reason?: string;
        covering?: string;
        suggestedAction?: string;
        error?: string;
      };
      dismissTopOverlay(): {
        success: boolean;
        reason?: string;
        info?: { closed?: string };
      };
    };
    const tools = loadTools(
      pageWindow,
      fakeDocument,
      1200,
      800,
      pageWindow.getComputedStyle,
      FakeMouseEvent,
    );
    const covered = tools.prepareRef(19);
    assert(
      covered.reason === "element_covered",
      `coverage result: ${JSON.stringify(covered)}`,
    );
    assert(
      covered.suggestedAction === "dismiss",
      "covered layer did not suggest dismiss",
    );
    assert(
      covered.covering !== "div" &&
        covered.error?.includes("Use the dismiss action") === true,
      `blocker context was not actionable: ${JSON.stringify(covered)}`,
    );

    const dismissed = tools.dismissTopOverlay();
    assert(dismissed.success, `dismiss failed: ${JSON.stringify(dismissed)}`);
    assert(
      dismissed.info?.closed === "Close",
      `close label: ${dismissed.info?.closed}`,
    );
    assert(activations === 1, `close control activated ${activations} times`);
    assert(
      syntheticClickEvents === 0,
      "fireClick emitted a duplicate click event",
    );
  });

  test("does not treat a fixed header or small floating widget as an overlay", () => {
    type AnyRecord = Record<string, any>;
    const pageWindow: AnyRecord = {
      innerWidth: 1200,
      innerHeight: 800,
      __tauPageConfig: { sessionKey: "negative-overlay-test" },
      getComputedStyle: (node: AnyRecord) => node.style,
    };
    const fixedNode = (rect: AnyRecord): AnyRecord => ({
      tagName: "DIV",
      className: "",
      id: "",
      innerText: "",
      textContent: "",
      isConnected: true,
      ownerDocument: fakeDocument,
      parentElement: null,
      style: {
        position: "fixed",
        zIndex: "100",
        backgroundColor: "rgb(255, 255, 255)",
        visibility: "visible",
        display: "block",
        pointerEvents: "auto",
        opacity: "1",
      },
      getBoundingClientRect: () => rect,
      getAttribute: () => null,
      matches: () => false,
      contains: () => false,
      compareDocumentPosition: () => 0,
      querySelectorAll: () => [],
    });
    let bodyElements: AnyRecord[] = [];
    const fakeDocument: AnyRecord = {
      defaultView: pageWindow,
      body: {},
      documentElement: {},
      querySelectorAll(selector: string) {
        return selector === "body *" ? bodyElements : [];
      },
      elementsFromPoint: () => bodyElements,
    };
    bodyElements = [
      fixedNode({
        left: 0,
        top: 0,
        right: 1200,
        bottom: 72,
        width: 1200,
        height: 72,
      }),
      fixedNode({
        left: 1120,
        top: 700,
        right: 1180,
        bottom: 760,
        width: 60,
        height: 60,
      }),
    ];
    const loadTools = new Function(
      "window",
      "document",
      "innerWidth",
      "innerHeight",
      "getComputedStyle",
      `${PAGE_TOOLS_SCRIPT}\nreturn window.__tauPageTools;`,
    ) as (
      window: AnyRecord,
      document: AnyRecord,
      innerWidth: number,
      innerHeight: number,
      getComputedStyle: (node: AnyRecord) => AnyRecord,
    ) => { dismissTopOverlay(): { success: boolean; reason?: string } };
    const result = loadTools(
      pageWindow,
      fakeDocument,
      1200,
      800,
      pageWindow.getComputedStyle,
    ).dismissTopOverlay();
    assert(
      !result.success && result.reason === "no_overlay",
      `false positive: ${JSON.stringify(result)}`,
    );
  });

  console.log("resolveClickTarget:");

  test("prefers a ref over accidental coordinates", () => {
    const selected = resolveClickTarget({ ref: 110, x: 1, y: 1 });
    assert(
      selected?.kind === "ref" && selected.ref === 110,
      `expected ref target, got ${JSON.stringify(selected)}`,
    );
  });

  test("prefers text over accidental coordinates", () => {
    const selected = resolveClickTarget({
      text: "Actualiser",
      nth: 2,
      x: 1,
      y: 1,
    });
    assert(
      selected?.kind === "text" &&
        selected.text === "Actualiser" &&
        selected.nth === 2,
      `expected text target, got ${JSON.stringify(selected)}`,
    );
  });

  test("keeps ref 0 valid and gives it priority over text", () => {
    const selected = resolveClickTarget({ ref: 0, text: "wrong target" });
    assert(
      selected?.kind === "ref" && selected.ref === 0,
      `expected ref 0, got ${JSON.stringify(selected)}`,
    );
  });

  test("still allows coordinate-only clicks", () => {
    const selected = resolveClickTarget({ x: 20, y: 30 });
    assert(
      selected?.kind === "coordinates" &&
        selected.x === 20 &&
        selected.y === 30,
      `expected coordinates, got ${JSON.stringify(selected)}`,
    );
  });

  test("rejects incomplete coordinates and lets blank text fall through", () => {
    assert(resolveClickTarget({ x: 20 }) === null, "lone x must be invalid");
    const selected = resolveClickTarget({ text: "  ", x: 20, y: 30 });
    assert(
      selected?.kind === "coordinates",
      `blank text should not hide coordinates: ${JSON.stringify(selected)}`,
    );
  });

  console.log("classifyCoordinateStreak:");

  test("allows the first blind coordinate click", () => {
    assert(
      classifyCoordinateStreak([], 100, 100) === null,
      "first click is fine",
    );
  });

  test("blocks a repeat of the same spot (did nothing)", () => {
    const verdict = classifyCoordinateStreak([{ x: 100, y: 100 }], 110, 105);
    assert(verdict === "repeat", `expected repeat, got ${verdict}`);
  });

  test("allows a genuinely different second spot", () => {
    const verdict = classifyCoordinateStreak([{ x: 100, y: 100 }], 800, 600);
    assert(verdict === null, `expected allow, got ${verdict}`);
  });

  test("blocks the third blind click in a row (streak)", () => {
    const verdict = classifyCoordinateStreak(
      [
        { x: 100, y: 100 },
        { x: 800, y: 600 },
      ],
      400,
      300,
    );
    assert(verdict === "streak", `expected streak, got ${verdict}`);
  });

  console.log("parseChord:");

  test("parses a bare named key", () => {
    const p = parseChord("Enter");
    assert(
      !("error" in p) &&
        p.entry.key === "Enter" &&
        p.modifiers === 0 &&
        p.named === true,
      "Enter should parse as named",
    );
  });

  test("parses a bare character with text (typed, not named)", () => {
    const p = parseChord("a");
    assert(
      !("error" in p) && p.entry.text === "a" && !p.named,
      "bare char should carry text",
    );
  });

  test("parses Control+a with selectAll command and no text", () => {
    const p = parseChord("Control+a");
    assert(!("error" in p), "chord should parse");
    if ("error" in p) return;
    assert(p.modifiers === 2, `ctrl bit expected, got ${p.modifiers}`);
    assert(p.entry.text === undefined, "ctrl chord must not type text");
    assert(p.commands?.[0] === "selectAll", "ctrl+a should map to selectAll");
    assert(
      p.entry.code === "KeyA" && p.entry.vk === 65,
      "code/vk for letter a",
    );
  });

  test("parses Ctrl+Shift+ArrowRight", () => {
    const p = parseChord("Ctrl+Shift+ArrowRight");
    assert(!("error" in p), "chord should parse");
    if ("error" in p) return;
    assert(p.modifiers === 10, `ctrl|shift expected 10, got ${p.modifiers}`);
    assert(
      p.entry.key === "ArrowRight",
      "main key resolves to the named arrow",
    );
  });

  test("parses F5 and function keys", () => {
    const p = parseChord("F5");
    assert(!("error" in p) && p.entry.vk === 116, "F5 vk should be 116");
  });

  test("uppercases a shifted letter", () => {
    const p = parseChord("Shift+b");
    assert(!("error" in p) && p.entry.key === "B", "shift+b should present B");
  });

  test("rejects modifier-only and multi-main specs", () => {
    assert("error" in parseChord("Control"), "modifier-only must error");
    assert("error" in parseChord("a+b"), "two main keys must error");
    assert("error" in parseChord("NotAKey"), "unknown named key must error");
  });

  console.log("normalizeUrlForNavigation:");

  const noFile = () => false;
  test("passes through absolute http(s) and about:blank", () => {
    assert(
      normalizeUrlForNavigation("https://x.test/a", noFile) ===
        "https://x.test/a",
      "https passthrough",
    );
    assert(
      normalizeUrlForNavigation("about:blank", noFile) === "about:blank",
      "about passthrough",
    );
  });

  test("bare domains get https", () => {
    assert(
      normalizeUrlForNavigation("example.com/x", noFile) ===
        "https://example.com/x",
      "https default",
    );
  });

  test("local dev hosts get http, not https", () => {
    assert(
      normalizeUrlForNavigation("localhost:3000", noFile) ===
        "http://localhost:3000",
      "localhost",
    );
    assert(
      normalizeUrlForNavigation("127.0.0.1:8080/app", noFile) ===
        "http://127.0.0.1:8080/app",
      "loopback ip",
    );
    assert(
      normalizeUrlForNavigation("[::1]:5173", noFile) === "http://[::1]:5173",
      "ipv6 loopback",
    );
  });

  test("an existing local file path becomes a file:// URL", () => {
    const out = normalizeUrlForNavigation("C:\\site\\index.html", () => true);
    assert(out.startsWith("file:///"), `expected file URL, got ${out}`);
    assert(out.toLowerCase().includes("index.html"), "file name preserved");
  });

  test("a non-existent path is not treated as a file", () => {
    const out = normalizeUrlForNavigation("./missing.html", noFile);
    assert(out.startsWith("https://"), "missing file falls through to https");
  });

  console.log("formatConsoleEntries:");

  const centry = (over: Partial<ConsoleEntry>): ConsoleEntry => ({
    ts: 1700000000000,
    level: "log",
    text: "hello",
    ...over,
  });

  test("filters by error level including exceptions", () => {
    const text = formatConsoleEntries(
      [
        centry({ level: "log", text: "noise" }),
        centry({ level: "error", text: "boom" }),
        centry({ level: "exception", text: "Uncaught TypeError" }),
      ],
      { level: "error" },
    );
    assert(!text.includes("noise"), "log entries filtered out");
    assert(
      text.includes("boom") && text.includes("Uncaught TypeError"),
      "errors + exceptions kept",
    );
  });

  test("substring filter and omitted counter work", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      centry({ text: `api call ${i}` }),
    );
    const text = formatConsoleEntries(entries, { filter: "api", limit: 5 });
    assert(text.includes("api call 39"), "newest entries win");
    assert(
      text.includes("35 earlier matching"),
      `should count omissions: ${text.split("\n")[0]}`,
    );
  });

  console.log("formatNetworkEntries:");

  const nentry = (over: Partial<NetworkEntry>): NetworkEntry => ({
    ts: 1700000000000,
    requestId: "r1",
    method: "GET",
    url: "https://api.test/data",
    ...over,
  });

  test("failedOnly keeps errors and 4xx/5xx only", () => {
    const text = formatNetworkEntries(
      [
        nentry({ status: 200, finished: true }),
        nentry({
          requestId: "r2",
          status: 500,
          finished: true,
          url: "https://api.test/broken",
        }),
        nentry({
          requestId: "r3",
          error: "net::ERR_CONNECTION_REFUSED",
          url: "https://api.test/dead",
        }),
      ],
      { failedOnly: true },
    );
    assert(!text.includes("/data"), "200 filtered out");
    assert(text.includes("500") && text.includes("FAILED"), "failures kept");
  });

  test("pending requests are labeled", () => {
    const text = formatNetworkEntries([nentry({})], {});
    assert(text.includes("pending"), "unfinished request shows pending");
  });

  type SessionHarness = {
    click: BrowserSessionService["click"];
    fill: BrowserSessionService["fill"];
    drag: BrowserSessionService["drag"];
    callPageTools<T>(invocation: string): Promise<T>;
    observe: BrowserSessionService["observe"];
    realClick(
      x: number,
      y: number,
      signal?: AbortSignal,
      clickCount?: number,
    ): Promise<void>;
    evaluate<T>(expression: string): Promise<T>;
    pageFingerprint(): Promise<{ url: string; elementCount: number } | null>;
    realDrag(
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      signal?: AbortSignal,
    ): Promise<void>;
    waitForSettle(signal?: AbortSignal): Promise<void>;
  };
  const SessionCtor = getBrowserSession()
    .constructor as unknown as new () => BrowserSessionService;
  const freshSession = () => new SessionCtor() as unknown as SessionHarness;

  console.log("stale ref recovery:");

  await testAsync(
    "refreshes stale refs without dispatching the old click",
    async () => {
      const session = freshSession();
      let pageToolCalls = 0;
      let clickDispatched = false;
      session.callPageTools = async <T>(): Promise<T> => {
        pageToolCalls++;
        return {
          success: false,
          reason: "stale_ref",
          staleKind: "registry_missing",
          error: "No observation registry on this page.",
        } as T;
      };
      session.observe = async () => ({
        observation: obs({
          url: "https://www.amazon.test/",
          interactive_elements: [
            el({ id: 8, tag: "button", text: "Actualiser" }),
          ],
        }),
        warnings: ["fresh registry"],
      });
      session.realClick = async () => {
        clickDispatched = true;
      };

      const outcome = await session.click({ ref: 110 });
      assert(!outcome.ok && outcome.reason === "stale_ref", "must stay failed");
      assert(pageToolCalls === 1, "old numeric ref must not be retried");
      assert(!clickDispatched, "must not dispatch a click with a stale ref");
      assert(
        outcome.observation?.interactive_elements[0]?.id === 8,
        "failure should carry the refreshed refs",
      );
      assert(
        outcome.error?.includes("refreshed the observation") === true,
        `recovery guidance missing: ${outcome.error}`,
      );
    },
  );

  await testAsync(
    "refreshes context after covered and not-editable failures",
    async () => {
      const freshObservation = obs({
        interactive_elements: [
          el({ id: 41, tag: "button", text: "Close" }),
          el({ id: 42, tag: "input", text: "", placeholder: "Search" }),
        ],
      });

      const coveredSession = freshSession();
      let coveredObserves = 0;
      coveredSession.callPageTools = async <T>(): Promise<T> =>
        ({
          success: false,
          reason: "element_covered",
          covering: 'div ["Your Cart"]',
          suggestedAction: "dismiss",
          error: "Target is covered by the cart layer.",
        }) as T;
      coveredSession.observe = async () => {
        coveredObserves++;
        return { observation: freshObservation, warnings: [] };
      };
      coveredSession.realClick = async () => {
        throw new Error("covered target must not receive a click");
      };
      const covered = await coveredSession.click({ ref: 19 });
      assert(
        !covered.ok && covered.reason === "element_covered",
        "covered reason changed",
      );
      assert(
        coveredObserves === 1,
        `covered failure observed ${coveredObserves} times`,
      );
      assert(
        covered.observation?.interactive_elements[0]?.text === "Close" &&
          covered.error?.includes("use dismiss once") === true,
        `covered recovery lacked fresh close context: ${JSON.stringify(covered)}`,
      );

      const fillSession = freshSession();
      let fillObserves = 0;
      fillSession.callPageTools = async <T>(): Promise<T> =>
        ({
          success: false,
          reason: "not_editable",
          error: 'Element @9 (button "Close") is not an editable field.',
        }) as T;
      fillSession.observe = async () => {
        fillObserves++;
        return { observation: freshObservation, warnings: [] };
      };
      const filled = await fillSession.fill(9, "amlou");
      assert(
        !filled.ok && filled.reason === "not_editable",
        "fill reason changed",
      );
      assert(fillObserves === 1, `fill failure observed ${fillObserves} times`);
      assert(
        filled.observation?.interactive_elements[1]?.id === 42 &&
          filled.error?.includes("Fill only an input") === true,
        `fill recovery lacked the current input ref: ${JSON.stringify(filled)}`,
      );
    },
  );

  console.log("drag outcome:");

  await testAsync(
    "reports the actual drag source without throwing",
    async () => {
      const session = freshSession();
      let dragged = false;
      let fingerprints = 0;
      session.callPageTools = async <T>(invocation: string): Promise<T> => {
        if (invocation.startsWith("prepareRef(")) {
          return {
            success: true,
            x: 100,
            y: 120,
            label: "Source card",
            tag: "button",
          } as T;
        }
        if (invocation.startsWith("rectOfRefNoScroll(")) {
          return {
            success: true,
            info: { x: 400, y: 300, w: 80, h: 40 },
          } as T;
        }
        throw new Error(`unexpected page tool call: ${invocation}`);
      };
      session.evaluate = async <T>(): Promise<T> => ({ w: 1000, h: 800 }) as T;
      session.pageFingerprint = async () => ({
        url: "https://x.test/",
        elementCount: ++fingerprints,
      });
      session.realDrag = async () => {
        dragged = true;
      };
      session.waitForSettle = async () => undefined;
      session.observe = async () => ({ observation: obs({}), warnings: [] });

      const outcome = await session.drag(4, 9);
      assert(dragged, "real drag should be dispatched");
      assert(outcome.ok, `drag should succeed: ${outcome.error}`);
      assert(
        outcome.detail?.dragged === "Source card" &&
          outcome.detail?.method === "mouse",
        `unexpected drag detail: ${JSON.stringify(outcome.detail)}`,
      );
    },
  );

  console.log("element names and state (ELEMENT_INFO_JS):");

  type AnyNode = Record<string, unknown>;
  type ElementInfo = {
    tauFieldName(el: AnyNode): string;
    tauShownValue(el: AnyNode): string | undefined;
    tauStateOf(el: AnyNode): Record<string, unknown>;
  };
  const info = new Function(
    `${ELEMENT_INFO_JS}\nreturn { tauFieldName, tauShownValue, tauStateOf };`,
  )() as ElementInfo;
  const textNode = (value: string): AnyNode => ({ nodeType: 3, nodeValue: value });
  const node = (
    tagName: string,
    over: AnyNode & { attrs?: Record<string, string> } = {},
  ): AnyNode => {
    const attrs = over.attrs ?? {};
    return {
      nodeType: 1,
      tagName,
      childNodes: [],
      getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
      ...over,
    };
  };

  test("a checkbox inside its label is named by the label, not by its value", () => {
    const box = node("INPUT", { type: "checkbox", value: "on" });
    box.labels = [node("LABEL", { childNodes: [box, textNode(" Prime eligible")] })];
    assert(info.tauFieldName(box) === "Prime eligible", `named ${info.tauFieldName(box)}`);
    assert(info.tauShownValue(box) === undefined, "a checkbox value is not shown");
  });

  test("a select is named by its label and shows the chosen option", () => {
    const select = node("SELECT", {
      selectedOptions: [{ label: "2", text: "2", value: "2" }],
      labels: [node("LABEL", { childNodes: [textNode("Quantity")] })],
    });
    assert(info.tauFieldName(select) === "Quantity", `named ${info.tauFieldName(select)}`);
    assert(info.tauShownValue(select) === "2", `shows ${info.tauShownValue(select)}`);
  });

  test("aria-labelledby names a field", () => {
    const owner = {
      getElementById: (id: string) =>
        id === "cn" ? node("SPAN", { childNodes: [textNode("Name on card")] }) : null,
    };
    const input = node("INPUT", {
      type: "text",
      value: "",
      ownerDocument: owner,
      attrs: { "aria-labelledby": "cn" },
    });
    assert(info.tauFieldName(input) === "Name on card", `named ${info.tauFieldName(input)}`);
  });

  test("label text leaves out aria-hidden marks and a nested field's content", () => {
    const select = node("SELECT", {
      childNodes: [node("OPTION", { childNodes: [textNode("1")] })],
    });
    const input = node("INPUT", { type: "email", value: "" });
    input.labels = [
      node("LABEL", {
        childNodes: [
          textNode("Email"),
          node("SPAN", { attrs: { "aria-hidden": "true" }, childNodes: [textNode("*")] }),
          select,
        ],
      }),
    ];
    assert(info.tauFieldName(input) === "Email", `named ${info.tauFieldName(input)}`);
  });

  test("unlabelled fields fall back to title, then placeholder; buttons to their value", () => {
    const search = node("INPUT", { type: "text", value: "", attrs: { placeholder: "Search" } });
    assert(info.tauFieldName(search) === "Search", "placeholder fallback");
    const send = node("INPUT", { type: "submit", value: "Send" });
    assert(info.tauFieldName(send) === "Send", "submit named by its value");
    assert(info.tauShownValue(send) === undefined, "a button's value is its label, not shown again");
  });

  test("password values are never shown; text values are", () => {
    assert(
      info.tauShownValue(node("INPUT", { type: "password", value: "hunter2" })) === undefined,
      "password leaked",
    );
    assert(info.tauShownValue(node("INPUT", { type: "text", value: "hello" })) === "hello", "text value");
  });

  test("state carries expanded, selected, current, required and invalid", () => {
    const state = info.tauStateOf(
      node("INPUT", {
        required: true,
        attrs: { "aria-expanded": "false", "aria-current": "page", "aria-invalid": "true", "aria-selected": "true" },
      }),
    );
    assert(
      state.expanded === false &&
        state.current === "page" &&
        state.invalid === true &&
        state.required === true &&
        state.selected === true,
      JSON.stringify(state),
    );
    const summary = node("SUMMARY", { parentElement: { tagName: "DETAILS", open: true } });
    assert(info.tauStateOf(summary).expanded === true, "an open <details> reads as expanded");
    assert(
      Object.keys(info.tauStateOf(node("BUTTON", { attrs: { "aria-invalid": "false" } }))).length === 0,
      "false flags are left out",
    );
  });

  console.log("read paging (READ_HELPERS_JS):");

  type ReadHelpers = {
    readCut(text: string, start: number, budget: number): number;
    findAnchor(text: string, offset: number, anchor: string, radius: number): number;
  };
  const reader = new Function(`return {${READ_HELPERS_JS}};`)() as ReadHelpers;

  test("the rest of the page comes whole when it fits", () => {
    assert(reader.readCut("short text", 0, 100) === 10, "should take everything");
  });

  test("a paragraph break past half the budget ends the page", () => {
    const text = `${"a".repeat(60)}\n\n${"b".repeat(100)}`;
    assert(reader.readCut(text, 0, 100) === 62, `cut at ${reader.readCut(text, 0, 100)}`);
  });

  test("otherwise the page ends after a sentence, closing quotes included", () => {
    const text = 'He said "stop." Then the next sentence runs well past the budget given';
    const cut = reader.readCut(text, 0, 40);
    assert(text.slice(0, cut) === 'He said "stop." ', `cut to ${JSON.stringify(text.slice(0, cut))}`);
  });

  test("a CJK full stop ends a sentence without a space", () => {
    const text = `${"x".repeat(30)}${String.fromCharCode(0x3002)}${"y".repeat(100)}`;
    assert(reader.readCut(text, 0, 50) === 31, `cut at ${reader.readCut(text, 0, 50)}`);
  });

  test("with no boundary at all the page is cut at the budget", () => {
    assert(reader.readCut("x".repeat(200), 0, 50) === 50, "hard cut");
  });

  test("the anchor is found where it was, and where the page moved it", () => {
    const text = "intro words, then the part already read, then more text to come";
    const offset = text.indexOf(", then more");
    const anchor = text.slice(offset - 12, offset);
    assert(reader.findAnchor(text, offset, anchor, 4000) === offset, "unchanged page");
    const shifted = `A new banner line. ${text}`;
    assert(reader.findAnchor(shifted, offset, anchor, 4000) === offset + 19, "shifted page");
    assert(reader.findAnchor("a different page entirely", offset, anchor, 4000) === -1, "rewritten page");
  });

  test("of several copies of the anchor, the one nearest the old offset wins", () => {
    // Copies end at 3, 11 and 19; an old offset of 18 is nearest the last.
    const text = "END one END two END three";
    assert(reader.findAnchor(text, 18, "END", 4000) === 19, `got ${reader.findAnchor(text, 18, "END", 4000)}`);
  });

  console.log("picked elements:");

  test("pruning never folds the picked element into a run of look-alikes", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      el({ id: i, tag: "button", text: "Add to cart", x: 10, y: 10 + i * 40, ...(i === 4 ? { picked: true } : {}) }),
    );
    const out = prunePayloadElements(rows);
    assert(out.some((row) => row.picked && row.id === 4), "picked element was pruned away");
  });

  console.log("shadow DOM helpers:");

  type ShadowTools = {
    composedContains(outer: unknown, inner: unknown): boolean;
    pointHitsTarget(el: unknown, hit: unknown): boolean;
    deepAll(selector: string): unknown[];
    deepActive(): unknown;
    shadowText(): string;
  };
  // A light-DOM node whose contains() stops at shadow boundaries, like the real one.
  const lightNode = (tagName: string, parentNode: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
    const node: Record<string, unknown> = { nodeType: 1, tagName, parentNode, ...extra };
    node.contains = (other: Record<string, unknown> | null) => {
      for (let n = other; n; n = n.parentNode as Record<string, unknown> | null) if (n === node) return true;
      return false;
    };
    return node;
  };
  const shadowFixture = () => {
    const doc: Record<string, unknown> = { nodeType: 9, parentNode: null };
    const host = lightNode("MY-CARD", doc);
    const root: Record<string, unknown> = { nodeType: 11, host, parentNode: null };
    const inner = lightNode("BUTTON", root, { innerText: "Buy now" });
    host.shadowRoot = root;
    root.querySelectorAll = (selector: string) => (selector === "*" ? [inner] : selector === "button" ? [inner] : []);
    root.children = [inner];
    const light = lightNode("BUTTON", doc, { innerText: "Light" });
    doc.querySelectorAll = (selector: string) => (selector === "*" ? [host, light] : selector === "button" ? [light] : []);
    doc.activeElement = host;
    root.activeElement = inner;
    const tools = new Function("window", "document", `${PAGE_TOOLS_SCRIPT}\nreturn window.__tauPageTools;`)(
      {},
      doc,
    ) as ShadowTools;
    return { doc, host, root, inner, light, tools };
  };

  test("containment crosses a shadow boundary; plain contains() does not", () => {
    const { host, inner, tools } = shadowFixture();
    assert(!(host.contains as (n: unknown) => boolean)(inner), "fixture: contains must stop at the shadow root");
    assert(tools.composedContains(host, inner), "host should contain its shadow content");
    assert(!tools.composedContains(inner, host), "the inside does not contain its host");
  });

  test("a hit on the host counts as a hit on an element inside it", () => {
    const { host, inner, light, tools } = shadowFixture();
    assert(tools.pointHitsTarget(inner, host), "the retargeted host hit must count");
    assert(!tools.pointHitsTarget(inner, light), "an unrelated element must not count");
  });

  test("deepAll finds matches inside open shadow roots, the document's first", () => {
    const { inner, light, tools } = shadowFixture();
    const found = tools.deepAll("button");
    assert(found.length === 2 && found[0] === light && found[1] === inner, `found ${found.length}`);
  });

  test("deepActive follows focus into a shadow root", () => {
    const { inner, tools } = shadowFixture();
    assert(tools.deepActive() === inner, "focus inside the shadow root was not followed");
  });

  test("shadowText reads text that body.innerText leaves out", () => {
    const { tools } = shadowFixture();
    assert(tools.shadowText().includes("Buy now"), "shadow text missing");
  });

  console.log("network bodies:");

  test("clipBody masks credentials and compacts JSON", () => {
    const text = clipBody('{\n  "user": "bob",\n  "token": "abc123def456ghi789"\n}', 200);
    assert(text === '{"user":"bob","token":"[masked token]"}', text);
  });

  test("clipBody collapses whitespace in plain text", () => {
    const text = clipBody("line one\n\n   line two\tand three", 200);
    assert(text === "line one line two and three", text);
  });

  test("clipBody cuts long bodies and says how long they were", () => {
    const text = clipBody("word ".repeat(1000), 50);
    assert(text.length < 100 && text.includes("(5000 characters in all)"), text);
  });

  test("selectNetworkEntries returns exactly the rows the listing shows", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      nentry({ requestId: `r${i}`, url: `https://api.test/${i % 2 ? "orders" : "items"}/${i}`, status: 200 }),
    );
    const { shown, omitted } = selectNetworkEntries(rows, { filter: "orders", limit: 5 });
    assert(shown.length === 5 && omitted === 15, `shown ${shown.length}, omitted ${omitted}`);
    assert(shown.every((row) => row.url.includes("orders")), "filter applied");
    const listed = formatNetworkEntries(rows, { filter: "orders", limit: 5 });
    assert(shown.every((row) => listed.includes(row.url)), "listing and selection agree");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
