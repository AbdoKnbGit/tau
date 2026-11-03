import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStepFromAction, replayStep, type FlowSessionLike } from "./flowRunner.js";
import {
  describeStep, flowsDir, formatFlow, listFlows, loadFlow, parameterizeFlow,
  prepareFlowReplay, saveFlow, type Flow, type FlowStep,
} from "./flows.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "tau-flow-parameters-"));
  directories.push(path);
  return path;
};
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

const flow = (steps: FlowStep[], parameters?: string[]): Flow => ({
  version: 1, name: "test", createdAt: "2026-11-02T10:00:00Z", steps,
  ...(parameters ? { parameters } : {}),
});

describe("safe recording and persistence", () => {
  test("records sensitive fields without their contents or labels", () => {
    for (const metadata of [
      { type: "password" }, { autocomplete: "one-time-code" }, { name: "authToken" },
      { autocomplete: "cc-number" }, { text: "Security code" }, { sensitive: true },
    ]) {
      const step = buildStepFromAction({ action: "fill", ref: 1, value: "private-value-42" }, { id: 1, text: "Field", ...metadata });
      expect(step?.unreplayable).toBeDefined();
      expect(step?.value).toBeUndefined();
      expect(JSON.stringify(step)).not.toContain("private-value-42");
    }
  });

  test("typing uses metadata captured before the action", () => {
    const step = buildStepFromAction({ action: "type", text: "908172", submit: true }, undefined, undefined, { autocomplete: "one-time-code" });
    expect(step?.text).toBeUndefined();
    expect(step?.unreplayable).toBeDefined();
    expect(JSON.stringify(step)).not.toContain("908172");
    const unknown = buildStepFromAction({ action: "type", text: "do-not-record-without-field-metadata" }, undefined);
    expect(unknown?.unreplayable).toBeDefined();
    expect(unknown?.text).toBeUndefined();
  });

  test("printable presses cannot record a sensitive value one character at a time", () => {
    for (const key of ["p", "7", "!", "Space", "Shift+a", "Shift+Space"]) {
      const step = buildStepFromAction({ action: "press", key }, undefined, undefined, { type: "password" });
      expect(step?.unreplayable).toBeDefined();
      expect(step?.key).toBeUndefined();
    }
    expect(buildStepFromAction({ action: "press", key: "a" }, undefined)?.key).toBeUndefined();
    expect(buildStepFromAction({ action: "press", key: "a" }, undefined, undefined, { type: "text" })?.key).toBe("a");
  });

  test("navigation keys and shortcuts remain replayable without recording printable input", () => {
    for (const key of ["Enter", "Tab", "Escape", "Shift+Tab", "Control+a", "Alt+x", "Meta+v", "Cmd+c", "Option+a", "Win+r"]) {
      const step = buildStepFromAction({ action: "press", key }, undefined, undefined, { type: "password" });
      expect(step?.key).toBe(key);
      expect(step?.unreplayable).toBeUndefined();
    }
  });

  test("recognizable credentials are excluded even without field labels", () => {
    const token = "ghp_" + "a".repeat(36);
    const step = buildStepFromAction({ action: "type", text: token }, undefined);
    expect(step?.unreplayable).toBeDefined();
    expect(JSON.stringify(step)).not.toContain(token);
    expect(() => saveFlow(directory(), flow([{ action: "type", text: token }]))).toThrow("credential literal");
  });

  test("save validates direct callers before creating a file", () => {
    const root = directory();
    expect(() => saveFlow(root, flow([{ action: "fill", target: { label: "Password" }, value: "hunter2" }]))).toThrow("sensitive field literal");
    expect(existsSync(join(flowsDir(root), "test.json"))).toBe(false);
  });

  test("legacy sensitive literals are refused on load without exposing their values", () => {
    const root = directory();
    mkdirSync(flowsDir(root), { recursive: true });
    writeFileSync(join(flowsDir(root), "test.json"), JSON.stringify(flow([{ action: "fill", target: { label: "OTP" }, value: "908172" }])));
    const result = loadFlow(root, "test");
    expect(result).toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain("908172");
    expect(listFlows(root)[0]?.problem).toBeDefined();
  });

  test("parse errors never echo malformed secret-bearing JSON", () => {
    const root = directory();
    mkdirSync(flowsDir(root), { recursive: true });
    writeFileSync(join(flowsDir(root), "test.json"), '{"password":"never-echo-this"');
    expect(JSON.stringify(loadFlow(root, "test"))).not.toContain("never-echo-this");
  });

  test("ordinary v1 flows preserve exact whitespace through storage and replay preparation", () => {
    const original = flow([{ action: "type", text: "  first\n\nsecond\t end  " }]);
    const root = directory();
    saveFlow(root, original);
    const loaded = loadFlow(root, "test");
    expect(loaded).toEqual(original);
    const prepared = prepareFlowReplay(loaded as Flow);
    expect(prepared.ok && prepared.steps[0]?.text).toBe(original.steps[0]?.text);
  });
});

describe("parameter templates and complete preflight", () => {
  test("parameterizes exact whole inputs, keeps names only, and preserves supplied whitespace", () => {
    const original = flow([
      { action: "fill", target: { label: "Email" }, value: "original@example.test" },
      { action: "type", text: "original@example.test" },
      { action: "type", text: "prefix original@example.test" },
    ]);
    const template = parameterizeFlow(original, { email: "original@example.test" });
    expect(template).not.toHaveProperty("error");
    expect((template as Flow).parameters).toEqual(["email"]);
    expect((template as Flow).steps[0]?.value).toBe("{{email}}");
    expect((template as Flow).steps[2]?.text).toBe("prefix original@example.test");
    expect(original.steps[0]?.value).toBe("original@example.test");
    const prepared = prepareFlowReplay(template as Flow, { email: "  fresh\nvalue  " });
    expect(prepared.ok && prepared.steps[0]?.value).toBe("  fresh\nvalue  ");
    const root = directory();
    const saved = saveFlow(root, template as Flow);
    expect(readFileSync(saved, "utf8")).not.toContain("fresh");
  });

  test("rejects unmatched and ambiguous parameter mappings", () => {
    const template = flow([{ action: "type", text: "value" }]);
    expect(parameterizeFlow(template, { a: "missing" })).toHaveProperty("error");
    expect(parameterizeFlow(template, { a: "value", b: "value" })).toHaveProperty("error");
    expect(parameterizeFlow(template, { constructor: "value" })).toHaveProperty("error");
  });

  test("requires every declared parameter and refuses unknown fields", () => {
    const template = flow([{ action: "type", text: "{{note}}" }], ["note"]);
    expect(prepareFlowReplay(template).ok).toBe(false);
    expect(prepareFlowReplay(template, { note: "ok", extra: "not used" }).ok).toBe(false);
    expect(prepareFlowReplay(template, { note: "" }).ok).toBe(true);
    expect(prepareFlowReplay(template, { note: "{{literal text}}" }).ok).toBe(true);
  });

  test("rejects undeclared or malformed placeholders before any replay can start", () => {
    for (const text of ["{{missing}}", "{{constructor}}", "{{bad-name}}", "{{", "}}"] ) {
      expect(prepareFlowReplay(flow([{ action: "navigate", url: "https://example.test" }, { action: "type", text }])).ok).toBe(false);
    }
  });

  test("validates the final step as well as the first before returning a plan", () => {
    const steps: FlowStep[] = [{ action: "navigate", url: "https://example.test" }, { action: "fill", value: "value" }];
    expect(prepareFlowReplay(flow(steps))).toEqual({ ok: false, error: "Step 2: the step has no target label." });
    expect(prepareFlowReplay(flow([{ action: "navigate", url: "javascript:alert(1)" }])).ok).toBe(false);
    expect(prepareFlowReplay(flow([{ action: "press", key: "" }])).ok).toBe(false);
  });

  test("retains local-file and blank-page navigation and uses the existing URL/key validators", () => {
    for (const url of ["file:///C:/project/index.html", "about:blank", "https://example.test/"]) {
      expect(prepareFlowReplay(flow([{ action: "navigate", url }])).ok).toBe(true);
    }
    for (const url of ["javascript:alert(1)", "data:text/html,bad", "https://user:password@example.test/"]) {
      expect(prepareFlowReplay(flow([{ action: "navigate", url }])).ok).toBe(false);
    }
    const prepared = prepareFlowReplay(flow([{ action: "navigate", url: "local.html" }, { action: "press", key: "Control+a" }]), {}, {
      normalizeUrl: () => "file:///C:/project/local.html",
      validateKey: key => key === "Control+a",
    });
    expect(prepared.ok && prepared.steps[0]?.url).toBe("file:///C:/project/local.html");
    expect(prepareFlowReplay(flow([{ action: "navigate", url: "about:blank" }, { action: "press", key: "InvalidKey" }]), {}, { validateKey: () => false }).ok).toBe(false);
  });

  test("preflights scroll direction, amount, and wait duration for every step", () => {
    for (const step of [
      { action: "scroll", direction: "diagonal" }, { action: "scroll", amount: 0 },
      { action: "scroll", amount: 20_001 }, { action: "wait", ms: 30_001 },
      { action: "wait", ms: 1.5 },
    ] as FlowStep[]) {
      expect(prepareFlowReplay(flow([{ action: "navigate", url: "about:blank" }, step])).ok).toBe(false);
    }
    expect(prepareFlowReplay(flow([{ action: "scroll", direction: "bottom" }, { action: "wait", ms: 30_000 }])).ok).toBe(true);
  });

  test("rejects inherited values, getters, nonstrings and prototype keys safely", () => {
    const template = flow([{ action: "type", text: "{{value}}" }], ["value"]);
    let getterCalled = false;
    const getter = Object.defineProperty({}, "value", { enumerable: true, get() { getterCalled = true; return "bad"; } });
    const cases: unknown[] = [Object.create({ value: "inherited" }), getter, { value: 42 }, { value: null }, JSON.parse('{"__proto__":"bad"}')];
    for (const values of cases) expect(prepareFlowReplay(template, values as Record<string, string>).ok).toBe(false);
    expect(getterCalled).toBe(false);
    expect(prepareFlowReplay(template, Object.assign(Object.create(null), { value: "own" })).ok).toBe(true);
  });

  test("runtime secrets remain ephemeral and are omitted from descriptions and errors", async () => {
    const template = flow([{ action: "fill", target: { label: "Password" }, value: "{{password}}" }], ["password"]);
    const prepared = prepareFlowReplay(template, { password: "runtime-private-value" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const step = prepared.steps[0]!;
    expect(describeStep(step)).not.toContain("runtime-private-value");
    expect(formatFlow({ ...template, steps: prepared.steps })).not.toContain("runtime-private-value");
    expect(() => saveFlow(directory(), { ...template, steps: prepared.steps })).toThrow();
    const session = {
      observe: async () => ({ observation: { interactive_elements: [{ id: 1, text: "Password" }] } }),
      fill: async () => ({ ok: false, error: "cannot fill runtime-private-value" }),
    } as unknown as FlowSessionLike;
    expect(await replayStep(session, step)).toEqual({ ok: false, error: "the fill action did not succeed" });
    expect(await replayStep(session, template.steps[0]!)).toHaveProperty("ok", false);
  });
});

describe("recording frame boundaries", () => {
  test("records frame selection by durable label and top-frame return explicitly", () => {
    expect(buildStepFromAction({ action: "frame", ref: 3 }, { id: 3, text: "Checkout", tag: "iframe" })?.target).toEqual({ text: "Checkout", tag: "iframe" });
    expect(buildStepFromAction({ action: "frame" }, undefined)).toEqual({ action: "frame" });
  });

  test("frame replay observes again and cannot silently skip an unsupported boundary", async () => {
    const calls: (number | undefined)[] = [];
    const session = {
      observe: async () => ({ observation: { interactive_elements: [{ id: 27, text: "Checkout" }] } }),
      switchFrame: async (ref?: number) => { calls.push(ref); return { ok: true }; },
    } as unknown as FlowSessionLike;
    expect(await replayStep(session, { action: "frame", target: { text: "Checkout" } })).toEqual({ ok: true });
    expect(await replayStep(session, { action: "frame" })).toEqual({ ok: true });
    expect(calls).toEqual([27, undefined]);
    expect((await replayStep({} as FlowSessionLike, { action: "frame" })).ok).toBe(false);
  });
});
