/**
 * Tests for the pick action's page script and its rendering. Picking itself
 * needs a person and a browser; the live harness covers that end to end.
 *
 * Run: bun run src/services/browser/pick.test.ts
 */

import { buildPickScript, CANCEL_PICK_SCRIPT, formatPicked } from "./pick.js";

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

function assert(cond: boolean, hint: string): void {
  if (!cond) throw new Error(hint);
}

console.log("pick script:");

test("compiles whatever the hint holds", () => {
  for (const hint of [
    "",
    'Point at the "price" you mean',
    "back\\slash and 'quotes'",
    "line one\nline two",
    "${globalThis.boom} </script>",
  ]) {
    // Parsing only: running it needs a DOM and a person.
    new Function(`return ${buildPickScript(hint, 5000)}`);
  }
});

test("the hint is one line of at most 120 characters", () => {
  const script = buildPickScript(`  ${"x".repeat(300)}\n\n  `, 5000);
  assert(script.includes(`Tau: ${"x".repeat(120)}   (Esc`), "hint not trimmed to one line of 120");
  assert(!script.includes("x".repeat(121)), "hint longer than 120 kept");
});

test("an empty hint still tells the user what to do", () => {
  assert(buildPickScript("   ", 5000).includes("Click the element you mean"), "no default prompt");
});

test("the cancel script compiles", () => {
  new Function(`return ${CANCEL_PICK_SCRIPT}`);
});

console.log("formatPicked:");

test("renders tag, selector, box and text", () => {
  const text = formatPicked({
    tag: "button",
    openTag: '<button class="btn primary" data-testid="add">',
    selector: "div#cart > button:nth-of-type(2)",
    text: "Add to cart",
    textLength: 11,
    box: { x: 640, y: 410, w: 120, h: 32 },
  });
  assert(text.includes('tag: <button class="btn primary" data-testid="add">'), text);
  assert(text.includes("selector: div#cart > button:nth-of-type(2)"), text);
  assert(text.includes("box: 120x32 at (640, 410)"), text);
  assert(text.includes('text: "Add to cart"') && !text.includes("first "), text);
});

test("says when the text was cut and when the element sits in a frame", () => {
  const text = formatPicked({
    tag: "p",
    openTag: "<p>",
    selector: "main > p",
    text: "a".repeat(300),
    textLength: 900,
    box: { x: 0, y: 0, w: 10, h: 10 },
    inFrame: "iframe#editor",
  });
  assert(text.includes("(first 300 of 900 characters)"), text);
  assert(text.includes("(inside the frame iframe#editor)"), text);
});

test("a cross-origin frame is reported as unreadable", () => {
  const text = formatPicked({
    tag: "iframe",
    openTag: '<iframe src="https://pay.example/">',
    selector: "iframe",
    text: "",
    textLength: 0,
    box: { x: 0, y: 0, w: 300, h: 200 },
    crossOrigin: true,
    src: "https://pay.example/",
  });
  assert(text.includes("cross-origin frame (https://pay.example/)"), text);
  assert(!text.includes("text:"), "an empty text line was printed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
