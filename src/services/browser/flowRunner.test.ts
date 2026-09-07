/**
 * Recording and replay.
 *
 * The failure this guards against: a replay that keeps going after the page
 * changed, clicking whatever happens to be in the right place.
 *
 * Run: bun run src/services/browser/flowRunner.test.ts
 */

import {
  buildStepFromAction,
  replayStep,
  resolveRecordedTarget,
  type ActionOutcomeLike,
  type FlowSessionLike,
  type ObservedElementLike,
} from "./flowRunner.js";
import type { FlowStep } from "./flows.js";

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

interface Call {
  method: string;
  args: unknown[];
}

function fakeSession(options: {
  elements?: ObservedElementLike[];
  outcome?: ActionOutcomeLike;
}): FlowSessionLike & { calls: Call[] } {
  const calls: Call[] = [];
  const outcome = options.outcome ?? { ok: true };
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };
  return {
    calls,
    async navigate(url) {
      record("navigate", url);
    },
    async click(target) {
      record("click", target);
      return outcome;
    },
    async fill(ref, value) {
      record("fill", ref, value);
      return outcome;
    },
    async typeText(text, submit) {
      record("typeText", text, submit);
      return outcome;
    },
    async press(key) {
      record("press", key);
      return outcome;
    },
    async scroll(scrollOptions) {
      record("scroll", scrollOptions);
      return outcome;
    },
    async waitAction(waitOptions) {
      record("waitAction", waitOptions);
      return outcome;
    },
    async dismissOverlay() {
      record("dismissOverlay");
      return outcome;
    },
    async reload(hard) {
      record("reload", hard);
    },
    async goBack() {
      record("goBack");
    },
    async goForward() {
      record("goForward");
    },
    async observe() {
      record("observe");
      return { observation: { interactive_elements: options.elements ?? [] } };
    },
  };
}

async function main(): Promise<void> {
  console.log("recording:");

  test("a ref click is recorded by the label it stood for, never by the id", () => {
    const step = buildStepFromAction(
      { action: "click", ref: 14 },
      { id: 14, text: "Sign in", tag: "button", role: "button" },
      [{ id: 14, text: "Sign in" }],
    );
    assert(step?.target?.text === "Sign in", JSON.stringify(step));
    assert(!JSON.stringify(step).includes("14"), "the ref must not survive into the flow");
  });

  test("an icon-only control falls back to its accessible name", () => {
    const step = buildStepFromAction(
      { action: "click", ref: 3 },
      { id: 3, text: "", aria: "Close dialog", tag: "button" },
    );
    assert(step?.target?.label === "Close dialog", JSON.stringify(step));
  });

  test("an unlabelled element is recorded as unreplayable, not guessed", () => {
    const step = buildStepFromAction({ action: "click", ref: 9 }, { id: 9, tag: "div" });
    assert(step?.unreplayable !== undefined, JSON.stringify(step));
    assert(step?.target === undefined, "no target may be invented");
  });

  test("a ref with no cached element is recorded as unreplayable", () => {
    const step = buildStepFromAction({ action: "fill", ref: 21, value: "x" }, undefined);
    assert(step?.unreplayable?.includes("@21") === true, JSON.stringify(step));
  });

  test("a fill keeps its value alongside the label", () => {
    const step = buildStepFromAction(
      { action: "fill", ref: 5, value: "a@b.test" },
      { id: 5, text: "", placeholder: "Email", tag: "input" },
    );
    assert(step?.value === "a@b.test", JSON.stringify(step));
    assert(step?.target?.label === "Email", JSON.stringify(step));
  });

  test("text-targeted and parameter-only actions record without a ref", () => {
    assert(
      buildStepFromAction({ action: "click", text: "Buy now" }, undefined)?.target?.text ===
        "Buy now",
      "click by text",
    );
    assert(
      buildStepFromAction({ action: "navigate", url: "http://x/" }, undefined)?.url ===
        "http://x/",
      "navigate",
    );
    assert(
      buildStepFromAction({ action: "press", key: "Enter" }, undefined)?.key === "Enter",
      "press",
    );
    assert(
      buildStepFromAction({ action: "type", text: "hello", submit: true }, undefined)
        ?.submit === true,
      "type with submit",
    );
    assert(
      buildStepFromAction({ action: "wait", selector: ".done", gone: true }, undefined)
        ?.gone === true,
      "wait",
    );
  });

  test("a repeated label records its position among the identical ones", () => {
    const rows: ObservedElementLike[] = [
      { id: 1, text: "Add to cart" },
      { id: 2, text: "Add to cart" },
      { id: 3, text: "Add to cart" },
    ];
    const step = buildStepFromAction({ action: "click", ref: 2 }, rows[1], rows);
    assert(step?.target?.nth === 2, JSON.stringify(step));
  });

  test("a unique label records no ordinal", () => {
    const rows: ObservedElementLike[] = [
      { id: 1, text: "Sign in" },
      { id: 2, text: "Register" },
    ];
    const step = buildStepFromAction({ action: "click", ref: 1 }, rows[0], rows);
    assert(step?.target?.nth === undefined, JSON.stringify(step));
  });

  test("actions that are not part of a flow are not recorded", () => {
    for (const action of ["observe", "screenshot", "console", "network", "eval", "measure", "extract", "watch", "flow", "open", "close"]) {
      assert(buildStepFromAction({ action }, undefined) === null, `${action} must not record`);
    }
  });

  console.log("target resolution:");

  await testAsync("resolves an exact label", async () => {
    const session = fakeSession({
      elements: [
        { id: 1, text: "Email" },
        { id: 2, text: "Password" },
      ],
    });
    const resolved = await resolveRecordedTarget(session, {
      action: "fill",
      target: { text: "Password" },
    });
    assert("ref" in resolved && resolved.ref === 2, JSON.stringify(resolved));
  });

  await testAsync("resolves a single contained match", async () => {
    const session = fakeSession({ elements: [{ id: 7, text: "Sign in with email" }] });
    const resolved = await resolveRecordedTarget(session, {
      action: "click",
      target: { text: "Sign in" },
    });
    assert("ref" in resolved && resolved.ref === 7, JSON.stringify(resolved));
  });

  await testAsync("refuses to guess when the label became ambiguous", async () => {
    const session = fakeSession({
      elements: [
        { id: 1, text: "Add to cart" },
        { id: 2, text: "Add to cart" },
      ],
    });
    const resolved = await resolveRecordedTarget(session, {
      action: "click",
      target: { text: "Add to cart" },
    });
    assert("error" in resolved && resolved.error.includes("ambiguous"), JSON.stringify(resolved));
  });

  await testAsync("uses the recorded ordinal to pick among identical labels", async () => {
    const session = fakeSession({
      elements: [
        { id: 1, text: "Add to cart" },
        { id: 2, text: "Add to cart" },
        { id: 3, text: "Add to cart" },
      ],
    });
    const resolved = await resolveRecordedTarget(session, {
      action: "click",
      target: { text: "Add to cart", nth: 3 },
    });
    assert("ref" in resolved && resolved.ref === 3, JSON.stringify(resolved));
  });

  await testAsync("says so when the recorded ordinal no longer exists", async () => {
    const session = fakeSession({ elements: [{ id: 1, text: "Add to cart" }] });
    const resolved = await resolveRecordedTarget(session, {
      action: "click",
      target: { text: "Add to cart", nth: 3 },
    });
    assert(
      "error" in resolved && resolved.error.includes("only 1 now match"),
      JSON.stringify(resolved),
    );
  });

  await testAsync("says what it looked for when nothing matches", async () => {
    const session = fakeSession({ elements: [{ id: 1, text: "Se connecter" }] });
    const resolved = await resolveRecordedTarget(session, {
      action: "click",
      target: { text: "Sign in" },
    });
    assert(
      "error" in resolved && resolved.error.includes('nothing on the page matches "Sign in"'),
      JSON.stringify(resolved),
    );
  });

  await testAsync("matches on aria and placeholder too", async () => {
    const session = fakeSession({
      elements: [
        { id: 4, text: "", aria: "Close dialog" },
        { id: 5, text: "", placeholder: "Search products" },
      ],
    });
    const byAria = await resolveRecordedTarget(session, {
      action: "click",
      target: { label: "Close dialog" },
    });
    assert("ref" in byAria && byAria.ref === 4, JSON.stringify(byAria));
    const byPlaceholder = await resolveRecordedTarget(session, {
      action: "fill",
      target: { text: "Search products" },
    });
    assert("ref" in byPlaceholder && byPlaceholder.ref === 5, JSON.stringify(byPlaceholder));
  });

  console.log("replay:");

  await testAsync("a click resolves through an observation instead of taking the first text match", async () => {
    const session = fakeSession({ elements: [{ id: 8, text: "Sign in" }] });
    const outcome = await replayStep(session, {
      action: "click",
      target: { text: "Sign in" },
    });
    assert(outcome.ok, JSON.stringify(outcome));
    assert(session.calls[0]!.method === "observe", "must look before clicking");
    assert(session.calls[1]!.method === "click", JSON.stringify(session.calls));
    assert(
      JSON.stringify(session.calls[1]!.args[0]) === JSON.stringify({ ref: 8 }),
      JSON.stringify(session.calls[1]),
    );
  });

  await testAsync("a click whose label is now ambiguous stops the replay", async () => {
    const session = fakeSession({
      elements: [
        { id: 1, text: "Add to cart" },
        { id: 2, text: "Add to cart" },
      ],
    });
    const outcome = await replayStep(session, {
      action: "click",
      target: { text: "Add to cart" },
    });
    assert(!outcome.ok, "must refuse rather than click the first one");
    assert(
      session.calls.every(call => call.method !== "click"),
      JSON.stringify(session.calls),
    );
  });

  await testAsync("a fill re-observes and fills the resolved ref", async () => {
    const session = fakeSession({ elements: [{ id: 11, text: "Email" }] });
    const outcome = await replayStep(session, {
      action: "fill",
      target: { text: "Email" },
      value: "a@b.test",
    });
    assert(outcome.ok, JSON.stringify(outcome));
    assert(session.calls[0]!.method === "observe", "must look before filling");
    assert(session.calls[1]!.method === "fill", JSON.stringify(session.calls));
    assert(session.calls[1]!.args[0] === 11, "fills the resolved ref");
    assert(session.calls[1]!.args[1] === "a@b.test", "with the recorded value");
  });

  await testAsync("a failed action stops the replay with the reason", async () => {
    const session = fakeSession({
      elements: [{ id: 1, text: "Buy" }],
      outcome: { ok: false, reason: "element_covered", error: "an overlay is on top" },
    });
    const outcome = await replayStep(session, { action: "click", target: { text: "Buy" } });
    assert(!outcome.ok, "must not claim success");
    assert(
      !outcome.ok && outcome.error === "an overlay is on top",
      JSON.stringify(outcome),
    );
  });

  await testAsync("a step recorded as unreplayable never runs", async () => {
    const session = fakeSession({});
    const outcome = await replayStep(session, {
      action: "click",
      unreplayable: "no visible text",
    });
    assert(!outcome.ok, "must refuse");
    assert(session.calls.length === 0, "and must not touch the page");
  });

  await testAsync("every recorded action kind has a replay path", async () => {
    const steps: FlowStep[] = [
      { action: "navigate", url: "http://x/" },
      { action: "click", target: { text: "Go" } },
      { action: "type", text: "hi", submit: true },
      { action: "press", key: "Enter" },
      { action: "scroll", direction: "down", amount: 600 },
      { action: "wait", ms: 10 },
      { action: "dismiss" },
      { action: "reload" },
      { action: "back" },
      { action: "forward" },
    ];
    for (const step of steps) {
      const session = fakeSession({ elements: [{ id: 1, text: "Go" }] });
      const outcome = await replayStep(session, step);
      assert(outcome.ok, `${step.action}: ${JSON.stringify(outcome)}`);
      assert(session.calls.length > 0, `${step.action} must call the session`);
    }
  });

  await testAsync("a step missing its own data fails loudly", async () => {
    const session = fakeSession({});
    const noUrl = await replayStep(session, { action: "navigate" });
    assert(!noUrl.ok && noUrl.error.includes("no url"), JSON.stringify(noUrl));
    const noLabel = await replayStep(session, { action: "click" });
    assert(!noLabel.ok && noLabel.error.includes("no clickable label"), JSON.stringify(noLabel));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
