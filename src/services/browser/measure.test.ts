/**
 * Measured-facts page script and its colour maths.
 *
 * Run: bun run src/services/browser/measure.test.ts
 */

import {
  formatMeasure,
  getColorHelpers,
  MEASURE_SCRIPT,
  type MeasureResult,
} from "./measure.js";

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

interface FakeStyle {
  display?: string;
  visibility?: string;
  backgroundColor?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  position?: string;
}

interface FakeElement {
  tagName: string;
  id?: string;
  className?: string;
  style: FakeStyle;
  rect: { x: number; y: number; width: number; height: number };
  text?: string;
  parentElement?: FakeElement | null;
}

function element(el: FakeElement): Record<string, unknown> {
  const node = {
    tagName: el.tagName,
    id: el.id ?? "",
    className: el.className ?? "",
    textContent: el.text ?? "",
    childNodes: el.text ? [{ nodeType: 3, nodeValue: el.text }] : [],
    parentElement: null as unknown,
    __style: {
      display: "block",
      visibility: "visible",
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: "rgb(0, 0, 0)",
      fontFamily: "Inter, sans-serif",
      fontSize: "16px",
      fontWeight: "400",
      position: "static",
      ...el.style,
    },
    getBoundingClientRect() {
      return {
        x: el.rect.x,
        y: el.rect.y,
        width: el.rect.width,
        height: el.rect.height,
        left: el.rect.x,
        top: el.rect.y,
        right: el.rect.x + el.rect.width,
        bottom: el.rect.y + el.rect.height,
      };
    },
  };
  return node;
}

/**
 * Canvas text metrics good enough to exercise the availability probe: a family
 * the machine "has" measures wider than the generic baselines; one it lacks
 * measures exactly like them, which is what a real fallback does.
 */
function fakeCanvas(availableFonts: string[]): Record<string, unknown> {
  const baselines: Record<string, number> = {
    monospace: 50,
    "sans-serif": 60,
    serif: 70,
  };
  const context = {
    font: "",
    measureText(): { width: number } {
      const spec = String(context.font);
      const known = availableFonts.some(family => spec.includes(`"${family}"`));
      if (known) return { width: 137 };
      for (const [generic, width] of Object.entries(baselines)) {
        if (spec.endsWith(generic)) return { width };
      }
      return { width: 60 };
    },
  };
  return { getContext: () => context };
}

function runMeasure(options: {
  elements: Record<string, unknown>[];
  images?: Record<string, unknown>[];
  landmarks?: Record<string, unknown>[];
  animations?: number;
  availableFonts?: string[];
  noCanvas?: boolean;
  pageBackground?: string;
  viewportWidth?: number;
}): MeasureResult {
  const vw = options.viewportWidth ?? 1280;
  const doc = {
    title: "Ajddigue Cooperative",
    characterSet: "UTF-8",
    documentElement: {
      lang: "fr",
      scrollHeight: 4200,
      __style: { backgroundColor: "rgba(0, 0, 0, 0)" },
    },
    images: options.images ?? [],
    createElement: () =>
      options.noCanvas ? {} : fakeCanvas(options.availableFonts ?? ["Inter"]),
    getAnimations: () =>
      Array.from({ length: options.animations ?? 0 }, (_, index) => ({
        animationName: `pulse-${index % 2}`,
      })),
    body: {
      querySelectorAll: () => options.elements,
      __style: { backgroundColor: options.pageBackground ?? "rgba(0, 0, 0, 0)" },
    },
    querySelectorAll: () => options.landmarks ?? [],
  };
  const win = { innerWidth: vw, innerHeight: 800, devicePixelRatio: 1, scrollY: 0 };
  const loc = { href: "http://127.0.0.1:8080/" };
  const getComputedStyle = (node: { __style?: FakeStyle }) => node.__style ?? {};
  const run = new Function(
    "window",
    "document",
    "location",
    "getComputedStyle",
    `return ${MEASURE_SCRIPT};`,
  ) as (w: unknown, d: unknown, l: unknown, g: unknown) => MeasureResult;
  return run(win, doc, loc, getComputedStyle);
}

function main(): void {
  console.log("colour maths (the same source the page runs):");
  const { parseCssColor, contrastRatio, contrastThreshold } = getColorHelpers();

  test("parses rgb, rgba, hex, shorthand hex and transparent", () => {
    assert(String(parseCssColor("rgb(255, 0, 0)")) === "255,0,0,1", "rgb");
    assert(String(parseCssColor("rgba(0, 0, 0, 0.5)")) === "0,0,0,0.5", "rgba");
    assert(String(parseCssColor("#ffffff")) === "255,255,255,1", "hex");
    assert(String(parseCssColor("#fff")) === "255,255,255,1", "short hex");
    assert(parseCssColor("transparent")![3] === 0, "transparent");
    assert(parseCssColor("rebeccapurple") === null, "unknown keyword yields null");
    assert(parseCssColor("") === null, "empty yields null");
  });

  test("parses the space-separated modern rgb syntax", () => {
    assert(String(parseCssColor("rgb(12 34 56 / 0.4)")) === "12,34,56,0.4", "modern");
  });

  test("black on white is 21:1 and white on white is 1:1", () => {
    const black = [0, 0, 0, 1];
    const white = [255, 255, 255, 1];
    assert(Math.round(contrastRatio(black, white)) === 21, String(contrastRatio(black, white)));
    assert(Math.round(contrastRatio(white, white)) === 1, String(contrastRatio(white, white)));
  });

  test("a translucent foreground is blended before measuring", () => {
    const faint = [0, 0, 0, 0.1];
    const white = [255, 255, 255, 1];
    const ratio = contrastRatio(faint, white);
    assert(ratio > 1 && ratio < 2, `faint text should read as low contrast, got ${ratio}`);
  });

  test("large text uses the 3:1 threshold, body text 4.5:1", () => {
    assert(contrastThreshold(16, 400) === 4.5, "body");
    assert(contrastThreshold(24, 400) === 3, "large by size");
    assert(contrastThreshold(19, 700) === 3, "large by weight");
    assert(contrastThreshold(19, 400) === 4.5, "not large without weight");
  });

  console.log("measurement script:");

  test("reports viewport, document and element counts", () => {
    const result = runMeasure({
      elements: [
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 1280, height: 600 }, style: { backgroundColor: "rgb(255, 255, 255)" } }),
      ],
    });
    assert(result.viewport.width === 1280, "viewport width");
    assert(result.viewport.pageHeight === 4200, "page height");
    assert(result.document.title === "Ajddigue Cooperative", result.document.title);
    assert(result.document.lang === "fr", result.document.lang);
    assert(result.elements.visible === 1, String(result.elements.visible));
  });

  test("skips hidden and zero-size elements", () => {
    const result = runMeasure({
      elements: [
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 0, height: 0 }, style: {} }),
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 10, height: 10 }, style: { display: "none" } }),
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 10, height: 10 }, style: { visibility: "hidden" } }),
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 10, height: 10 }, style: {} }),
      ],
    });
    assert(result.elements.visible === 1, `only the painted one counts, got ${result.elements.visible}`);
  });

  test("ranks painted background colours by area", () => {
    const result = runMeasure({
      elements: [
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 1000, height: 500 }, style: { backgroundColor: "rgb(250, 245, 235)" } }),
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 100, height: 50 }, style: { backgroundColor: "rgb(10, 10, 10)" } }),
      ],
    });
    assert(result.colors.backgrounds[0]!.color === "rgb(250, 245, 235)", JSON.stringify(result.colors.backgrounds));
    assert(result.colors.backgrounds[0]!.share > 0.9, "the large area dominates");
  });

  test("finds low-contrast text with the measured ratio", () => {
    const result = runMeasure({
      elements: [
        element({
          tagName: "P",
          rect: { x: 0, y: 0, width: 400, height: 20 },
          style: { color: "rgb(200, 200, 200)", backgroundColor: "rgb(255, 255, 255)" },
          text: "Prix sur demande",
        }),
      ],
    });
    assert(result.contrast.checked === 1, `checked ${result.contrast.checked}`);
    assert(result.contrast.failures.length === 1, JSON.stringify(result.contrast.failures));
    const failure = result.contrast.failures[0]!;
    assert(failure.ratio < 2, `ratio ${failure.ratio}`);
    assert(failure.text === "Prix sur demande", failure.text);
  });

  test("passes readable text without a finding", () => {
    const result = runMeasure({
      elements: [
        element({
          tagName: "P",
          rect: { x: 0, y: 0, width: 400, height: 20 },
          style: { color: "rgb(20, 20, 20)", backgroundColor: "rgb(255, 255, 255)" },
          text: "Readable body copy",
        }),
      ],
    });
    assert(result.contrast.failures.length === 0, JSON.stringify(result.contrast.failures));
  });

  test("reports the page background, which is not inside body's descendants", () => {
    const result = runMeasure({
      elements: [element({ tagName: "DIV", rect: { x: 0, y: 0, width: 100, height: 100 }, style: { backgroundColor: "rgb(200, 0, 0)" } })],
      pageBackground: "rgb(250, 245, 235)",
    });
    assert(result.colors.page === "rgb(250, 245, 235)", String(result.colors.page));
    assert(formatMeasure(result).includes("Page background: rgb(250, 245, 235)"), formatMeasure(result));
  });

  test("a font that never resolved is reported as a fallback", () => {
    const result = runMeasure({
      elements: [element({ tagName: "P", rect: { x: 0, y: 0, width: 100, height: 20 }, style: {}, text: "hi" })],
      availableFonts: [],
    });
    assert(result.fonts[0]!.family === "Inter", JSON.stringify(result.fonts));
    assert(result.fonts[0]!.available === false, "must flag the fallback");
    assert(formatMeasure(result).includes("NOT AVAILABLE"), formatMeasure(result));
  });

  test("a font that did resolve is not flagged", () => {
    const result = runMeasure({
      elements: [element({ tagName: "P", rect: { x: 0, y: 0, width: 100, height: 20 }, style: {}, text: "hi" })],
      availableFonts: ["Inter"],
    });
    assert(result.fonts[0]!.available === true, JSON.stringify(result.fonts));
    assert(!formatMeasure(result).includes("NOT AVAILABLE"), formatMeasure(result));
  });

  test("generic families are never flagged as missing", () => {
    const result = runMeasure({
      elements: [
        element({
          tagName: "P",
          rect: { x: 0, y: 0, width: 100, height: 20 },
          style: { fontFamily: "monospace" },
          text: "code",
        }),
      ],
      availableFonts: [],
    });
    assert(result.fonts[0]!.family === "monospace", JSON.stringify(result.fonts));
    assert(result.fonts[0]!.available === true, "a generic family always resolves");
  });

  test("without canvas metrics it does not cry wolf", () => {
    const result = runMeasure({
      elements: [element({ tagName: "P", rect: { x: 0, y: 0, width: 100, height: 20 }, style: {}, text: "hi" })],
      noCanvas: true,
    });
    assert(result.fonts[0]!.available === true, "unmeasurable must not read as missing");
  });

  test("catches horizontal overflow but ignores fixed and sticky elements", () => {
    const result = runMeasure({
      elements: [
        element({ tagName: "SECTION", id: "hero", rect: { x: 0, y: 0, width: 1320, height: 400 }, style: {} }),
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 1400, height: 40 }, style: { position: "fixed" } }),
        element({ tagName: "DIV", rect: { x: 0, y: 0, width: 1400, height: 40 }, style: { position: "sticky" } }),
      ],
    });
    assert(result.overflow.length === 1, JSON.stringify(result.overflow));
    assert(result.overflow[0]!.element === "section#hero", result.overflow[0]!.element);
    assert(result.overflow[0]!.overflowPx === 40, String(result.overflow[0]!.overflowPx));
  });

  test("separates broken images from oversized ones", () => {
    const result = runMeasure({
      elements: [],
      images: [
        {
          complete: true,
          naturalWidth: 0,
          naturalHeight: 0,
          src: "http://127.0.0.1:8080/assets/missing.png",
          alt: "Argan oil",
          getBoundingClientRect: () => ({ width: 0, height: 0 }),
        },
        {
          complete: true,
          naturalWidth: 2000,
          naturalHeight: 1500,
          src: "http://127.0.0.1:8080/assets/hero.jpg",
          alt: "",
          getBoundingClientRect: () => ({ width: 200, height: 150 }),
        },
      ],
    });
    assert(result.images.broken.length === 1, JSON.stringify(result.images.broken));
    assert(result.images.broken[0]!.alt === "Argan oil", result.images.broken[0]!.alt);
    assert(result.images.oversized.length === 1, JSON.stringify(result.images.oversized));
    assert(result.images.oversized[0]!.natural === "2000×1500", result.images.oversized[0]!.natural);
  });

  test("truncates data: URIs instead of dumping them", () => {
    const result = runMeasure({
      elements: [],
      images: [
        {
          complete: true,
          naturalWidth: 0,
          naturalHeight: 0,
          src: `data:image/png;base64,${"A".repeat(5000)}`,
          alt: "",
          getBoundingClientRect: () => ({ width: 0, height: 0 }),
        },
      ],
    });
    assert(result.images.broken[0]!.src.length < 40, result.images.broken[0]!.src);
  });

  test("counts running animations and de-duplicates their names", () => {
    const result = runMeasure({ elements: [], animations: 7 });
    assert(result.animations.running === 7, String(result.animations.running));
    assert(result.animations.names.length === 2, JSON.stringify(result.animations.names));
  });

  test("a hostile element does not abort the measurement", () => {
    const hostile = {
      tagName: "DIV",
      get __style(): never {
        throw new Error("blocked");
      },
      getBoundingClientRect: () => ({ width: 10, height: 10, right: 10 }),
      childNodes: [],
    };
    const result = runMeasure({
      elements: [
        hostile as unknown as Record<string, unknown>,
        element({ tagName: "P", rect: { x: 0, y: 0, width: 100, height: 20 }, style: {}, text: "survivor" }),
      ],
    });
    assert(result.elements.visible === 1, "the good element is still measured");
  });

  test("formats only the sections that have findings", () => {
    const clean = runMeasure({
      elements: [element({ tagName: "P", rect: { x: 0, y: 0, width: 100, height: 20 }, style: {}, text: "hi" })],
    });
    const text = formatMeasure(clean);
    assert(text.includes("Viewport 1280×800"), text);
    assert(!text.includes("Broken images"), "no broken images section when there are none");
    assert(!text.includes("Horizontal overflow"), "no overflow section when there is none");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
