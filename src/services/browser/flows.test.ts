/**
 * Flow storage: name safety, round-tripping, and replay-readiness.
 *
 * Everything runs in an OS temp directory built with path.join — no absolute
 * paths, no assumptions about the host filesystem beyond what Node guarantees.
 *
 * Run: bun run src/services/browser/flows.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";

import {
  deleteFlow,
  describeStep,
  FLOW_FORMAT_VERSION,
  flowsDir,
  formatFlow,
  listFlows,
  loadFlow,
  sanitizeFlowName,
  saveFlow,
  targetFromElement,
  type Flow,
} from "./flows.js";

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

function sampleFlow(name = "login"): Flow {
  return {
    version: FLOW_FORMAT_VERSION,
    name,
    createdAt: "2026-09-07T10:00:00.000Z",
    startUrl: "http://127.0.0.1:8080/",
    steps: [
      { action: "navigate", url: "http://127.0.0.1:8080/login" },
      { action: "fill", target: { text: "Email", tag: "input" }, value: "a@b.test" },
      { action: "fill", target: { label: "Password", tag: "input" }, value: "secret" },
      { action: "click", target: { text: "Sign in", tag: "button" } },
      { action: "wait", selector: "[data-testid=dashboard]" },
    ],
  };
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), "tau-flows-"));

  try {
    console.log("name safety:");

    test("normalises ordinary names", () => {
      assert(sanitizeFlowName("Login Flow") === "login-flow", String(sanitizeFlowName("Login Flow")));
      assert(sanitizeFlowName("checkout_v2") === "checkout_v2", String(sanitizeFlowName("checkout_v2")));
    });

    test("refuses path traversal and separators on every platform", () => {
      for (const attempt of ["../../etc/passwd", "..\\..\\windows", "/abs/path", "C:\\temp\\x", "..", "."]) {
        const safe = sanitizeFlowName(attempt);
        assert(
          safe === null || (!safe.includes("/") && !safe.includes("\\") && !safe.includes("..")),
          `${attempt} → ${safe}`,
        );
      }
    });

    test("refuses Windows device names", () => {
      for (const reserved of ["CON", "nul", "com1", "LPT9", "aux"]) {
        assert(sanitizeFlowName(reserved) === null, `${reserved} must be refused`);
      }
      assert(sanitizeFlowName("console") === "console", "a real word starting with con is fine");
    });

    test("never leaves a trailing dot or space, which Windows silently strips", () => {
      const safe = sanitizeFlowName("report.  ")!;
      assert(!safe.endsWith(".") && !safe.endsWith(" "), safe);
      assert(sanitizeFlowName("   ") === null, "whitespace only");
      assert(sanitizeFlowName("") === null, "empty");
      assert(sanitizeFlowName("!!!") === null, "punctuation only");
    });

    test("caps long names", () => {
      const safe = sanitizeFlowName("x".repeat(200))!;
      assert(safe.length <= 64, String(safe.length));
    });

    console.log("storage:");

    test("saves under .tau/flows using composed paths", () => {
      const target = saveFlow(root, sampleFlow());
      assert(target === join(flowsDir(root), "login.json"), target);
      assert(existsSync(target), "file must exist");
      assert(target.includes(`${sep}.tau${sep}flows${sep}`), target);
    });

    test("writes newline-terminated pretty JSON", () => {
      saveFlow(root, sampleFlow("formatting"));
      const raw = readFileSync(join(flowsDir(root), "formatting.json"), "utf8");
      assert(raw.endsWith("\n"), "must end with a newline");
      assert(raw.includes("\n  \"version\""), "must be pretty-printed");
    });

    test("round-trips every field", () => {
      saveFlow(root, sampleFlow("roundtrip"));
      const loaded = loadFlow(root, "roundtrip");
      assert(!("error" in loaded), JSON.stringify(loaded));
      const flow = loaded as Flow;
      assert(flow.steps.length === 5, String(flow.steps.length));
      assert(flow.steps[1]!.value === "a@b.test", JSON.stringify(flow.steps[1]));
      assert(flow.startUrl === "http://127.0.0.1:8080/", String(flow.startUrl));
    });

    test("stores the sanitised name, not the one that was asked for", () => {
      saveFlow(root, { ...sampleFlow(), name: "Add To Cart!" });
      const loaded = loadFlow(root, "add-to-cart") as Flow;
      assert(!("error" in loaded), JSON.stringify(loaded));
      assert(loaded.name === "add-to-cart", loaded.name);
    });

    test("a missing flow names the ones that exist", () => {
      const result = loadFlow(root, "nope") as { error: string };
      assert(result.error.includes('No flow named "nope"'), result.error);
      assert(result.error.includes("login"), result.error);
    });

    test("a corrupt file is reported, not thrown", () => {
      mkdirSync(flowsDir(root), { recursive: true });
      writeFileSync(join(flowsDir(root), "broken.json"), "{ not json", "utf8");
      const result = loadFlow(root, "broken") as { error: string };
      assert(result.error.includes("could not be parsed"), result.error);
      const listed = listFlows(root).find(flow => flow.name === "broken");
      assert(listed?.problem === "unreadable", JSON.stringify(listed));
    });

    test("a future format version is refused instead of misread", () => {
      writeFileSync(
        join(flowsDir(root), "future.json"),
        JSON.stringify({ version: 99, name: "future", createdAt: "", steps: [] }),
        "utf8",
      );
      const result = loadFlow(root, "future") as { error: string };
      assert(result.error.includes("format v99"), result.error);
    });

    test("lists flows sorted, with step counts", () => {
      const listed = listFlows(root);
      assert(listed.length >= 3, JSON.stringify(listed.map(flow => flow.name)));
      const names = listed.map(flow => flow.name);
      assert(
        names.every((name, index) => index === 0 || name >= names[index - 1]!),
        JSON.stringify(names),
      );
      assert(listed.find(flow => flow.name === "login")!.steps === 5, "step count");
    });

    test("deleting removes the file and is idempotent", () => {
      saveFlow(root, sampleFlow("temporary"));
      assert(deleteFlow(root, "temporary"), "first delete reports success");
      assert(!existsSync(join(flowsDir(root), "temporary.json")), "file is gone");
      assert(!deleteFlow(root, "temporary"), "second delete reports nothing to do");
    });

    test("listing an empty project is empty, not an error", () => {
      const empty = mkdtempSync(join(tmpdir(), "tau-flows-empty-"));
      try {
        assert(listFlows(empty).length === 0, "no flows");
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    console.log("replay readiness:");

    test("prefers visible text as the durable handle", () => {
      const result = targetFromElement({ text: "Sign in", tag: "button", role: "button" });
      assert(result.target?.text === "Sign in", JSON.stringify(result));
      assert(result.unreplayable === undefined, "replayable");
    });

    test("falls back to the accessible name for icon-only controls", () => {
      const result = targetFromElement({ text: "", aria: "Close dialog", tag: "button" });
      assert(result.target?.label === "Close dialog", JSON.stringify(result));
    });

    test("says so when an element cannot be found again", () => {
      const result = targetFromElement({ text: "  ", tag: "div" });
      assert(result.target === undefined, "no target");
      assert(result.unreplayable!.includes("no visible text"), result.unreplayable!);
    });

    test("records an ordinal only when the label is repeated on screen", () => {
      const rows = [
        { text: "Add to cart" },
        { text: "Add to cart" },
        { text: "Buy now" },
      ];
      const repeated = targetFromElement(rows[1]!, rows);
      assert(repeated.target?.nth === 2, JSON.stringify(repeated));
      const unique = targetFromElement(rows[2]!, rows);
      assert(unique.target?.nth === undefined, JSON.stringify(unique));
      const noContext = targetFromElement({ text: "Add to cart" });
      assert(noContext.target?.nth === undefined, "no siblings, no ordinal");
    });

    test("long labels are capped so a flow file stays small", () => {
      const result = targetFromElement({ text: "y".repeat(500), tag: "button" });
      assert(result.target!.text!.length === 80, String(result.target!.text!.length));
    });

    console.log("rendering:");

    test("describes each kind of step", () => {
      assert(describeStep({ action: "navigate", url: "http://x/" }) === "navigate http://x/", "navigate");
      assert(describeStep({ action: "click", target: { text: "Buy" } }) === 'click "Buy"', "click");
      assert(describeStep({ action: "press", key: "Enter" }) === "press Enter", "press");
      assert(
        describeStep({ action: "wait", selector: ".x", gone: true }) === "wait for .x to go",
        "wait",
      );
      assert(describeStep({ action: "dismiss" }) === "dismiss overlay", "dismiss");
    });

    test("flags unreplayable steps in the rendered flow", () => {
      const flow: Flow = {
        ...sampleFlow("mixed"),
        steps: [
          { action: "click", target: { text: "Buy" } },
          { action: "click", unreplayable: "the element had no visible text or accessible name" },
        ],
      };
      const text = formatFlow(flow);
      assert(text.includes("⚠"), text);
      assert(text.includes("1 step(s) cannot be replayed"), text);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
