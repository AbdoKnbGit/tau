/**
 * Flows: record once, replay for free.
 *
 * The expensive part of browser work is not the click, it is the fifteen
 * observations that found the click. Logging into an app, dismissing its
 * consent wall and reaching the page that actually matters costs the same
 * tokens every single session, for a sequence that has not changed in weeks.
 *
 * A flow is that sequence, written down in a form that survives: never `@14`
 * (an id from one observation of one page) but the label, text or selector the
 * ref stood for. Replay walks it without the model in the loop and stops at the
 * first step that no longer matches, which is also the cheapest possible
 * regression test for someone else's UI.
 *
 * Storage is project-local (`.tau/flows`), because a flow is about one app.
 * Paths are composed, never spelled out, and names are sanitised for the
 * strictest filesystem in play rather than the host's own.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

export const FLOW_FORMAT_VERSION = 1;

/** How a step finds its element again on a later run. */
export interface FlowTarget {
  /** Visible text — the most durable handle across releases. */
  text?: string;
  /** CSS selector, when the caller gave one. */
  selector?: string;
  /** Accessible name, when the element had no text (icon buttons). */
  label?: string;
  tag?: string;
  role?: string;
  /**
   * 1-based position among elements sharing this label, recorded when the page
   * had more than one. Without it a repeated label ("Add to cart") is refused
   * at replay rather than resolved to whichever one happens to come first.
   */
  nth?: number;
}

export interface FlowStep {
  action:
    | "navigate"
    | "click"
    | "fill"
    | "type"
    | "press"
    | "scroll"
    | "dismiss"
    | "wait"
    | "reload"
    | "back"
    | "forward";
  target?: FlowTarget;
  url?: string;
  value?: string;
  key?: string;
  text?: string;
  direction?: string;
  amount?: number;
  ms?: number;
  selector?: string;
  gone?: boolean;
  submit?: boolean;
  /** Set when the recorded action cannot be replayed as-is, with the reason. */
  unreplayable?: string;
}

export interface Flow {
  version: number;
  name: string;
  /** UTC ISO-8601; no locale formatting anywhere in this file. */
  createdAt: string;
  startUrl?: string;
  steps: FlowStep[];
}

export interface FlowSummary {
  name: string;
  steps: number;
  createdAt: string;
  startUrl?: string;
  /** Set when the file exists but could not be read as a flow. */
  problem?: string;
}

/** Device names Windows refuses as filenames, with or without an extension. */
const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 10 }, (_, index) => `com${index}`),
  ...Array.from({ length: 10 }, (_, index) => `lpt${index}`),
]);

/**
 * Reduces a caller-supplied name to something safe on every filesystem: lower
 * case, no separators, no traversal, no device names, no trailing dot or space.
 * Returns null when nothing usable is left.
 */
export function sanitizeFlowName(name: string): string | null {
  const cleaned = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, 64)
    .replace(/[-._]+$/, "");
  if (!cleaned) return null;
  if (RESERVED_NAMES.has(cleaned)) return null;
  return cleaned;
}

/** Project-local flow directory. Composed from the caller's cwd, never absolute. */
export function flowsDir(cwd: string): string {
  return join(cwd, ".tau", "flows");
}

function flowPath(cwd: string, safeName: string): string {
  return join(flowsDir(cwd), `${safeName}.json`);
}

export function saveFlow(cwd: string, flow: Flow): string {
  const safeName = sanitizeFlowName(flow.name);
  if (!safeName) throw new Error(`"${flow.name}" is not a usable flow name.`);
  const directory = flowsDir(cwd);
  mkdirSync(directory, { recursive: true });
  const target = flowPath(cwd, safeName);
  const payload: Flow = { ...flow, name: safeName, version: FLOW_FORMAT_VERSION };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

export function loadFlow(cwd: string, name: string): Flow | { error: string } {
  const safeName = sanitizeFlowName(name);
  if (!safeName) return { error: `"${name}" is not a usable flow name.` };
  const target = flowPath(cwd, safeName);
  if (!existsSync(target)) {
    const known = listFlows(cwd)
      .map(flow => flow.name)
      .join(", ");
    return {
      error: `No flow named "${safeName}".${known ? ` Saved flows: ${known}.` : " No flows have been saved in this project yet."}`,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Flow;
    if (!parsed || !Array.isArray(parsed.steps)) {
      return { error: `Flow "${safeName}" is not readable (no steps).` };
    }
    if (parsed.version !== FLOW_FORMAT_VERSION) {
      return {
        error: `Flow "${safeName}" was written in format v${parsed.version}; this build reads v${FLOW_FORMAT_VERSION}.`,
      };
    }
    return parsed;
  } catch (error: unknown) {
    return {
      error: `Flow "${safeName}" could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function listFlows(cwd: string): FlowSummary[] {
  const directory = flowsDir(cwd);
  if (!existsSync(directory)) return [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const summaries: FlowSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(readFileSync(join(directory, entry), "utf8")) as Flow;
      summaries.push({
        name,
        steps: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
        createdAt: parsed.createdAt ?? "",
        ...(parsed.startUrl ? { startUrl: parsed.startUrl } : {}),
      });
    } catch {
      summaries.push({ name, steps: 0, createdAt: "", problem: "unreadable" });
    }
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteFlow(cwd: string, name: string): boolean {
  const safeName = sanitizeFlowName(name);
  if (!safeName) return false;
  const target = flowPath(cwd, safeName);
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}

/**
 * Chooses the durable handle for an element that was acted on by ref. Text
 * first (survives redesigns), then accessible name, then nothing — and
 * "nothing" is recorded as such rather than guessed at.
 */
export function targetFromElement(
  element: {
    text?: string;
    aria?: string;
    placeholder?: string;
    tag?: string;
    role?: string;
  },
  /** Everything visible when the action happened, for the ordinal. */
  siblings?: Array<{ text?: string; aria?: string; placeholder?: string }>,
): { target?: FlowTarget; unreplayable?: string } {
  const text = element.text?.trim();
  const label = element.aria?.trim() || element.placeholder?.trim();
  const handle = text || label;
  if (!handle) {
    return {
      unreplayable:
        "the element had no visible text or accessible name, so it cannot be found again by label",
    };
  }
  const matches = (candidate: { text?: string; aria?: string; placeholder?: string }) =>
    (candidate.text?.trim() || candidate.aria?.trim() || candidate.placeholder?.trim()) ===
    handle;
  let nth: number | undefined;
  if (siblings && siblings.length > 0) {
    const sameLabel = siblings.filter(matches);
    if (sameLabel.length > 1) {
      const index = sameLabel.indexOf(element);
      nth = index >= 0 ? index + 1 : 1;
    }
  }
  return {
    target: {
      ...(text ? { text: handle.slice(0, 80) } : { label: handle.slice(0, 80) }),
      ...(element.tag ? { tag: element.tag } : {}),
      ...(element.role ? { role: element.role } : {}),
      ...(nth ? { nth } : {}),
    },
  };
}

/** Human-readable one-liner for a step, used by save/list/run output. */
export function describeStep(step: FlowStep): string {
  const ordinal = step.target?.nth ? ` #${step.target.nth}` : "";
  const target = step.target?.text
    ? `"${step.target.text}"${ordinal}`
    : step.target?.label
      ? `[${step.target.label}]${ordinal}`
      : step.target?.selector
        ? step.target.selector
        : "";
  switch (step.action) {
    case "navigate":
      return `navigate ${step.url ?? ""}`;
    case "click":
      return `click ${target}`;
    case "fill":
      return `fill ${target} = ${JSON.stringify(step.value ?? "")}`;
    case "type":
      return `type ${JSON.stringify(step.text ?? "")}${step.submit ? " + Enter" : ""}`;
    case "press":
      return `press ${step.key ?? ""}`;
    case "scroll":
      return `scroll ${step.direction ?? ""}${step.amount ? ` ${step.amount}` : ""}`;
    case "wait":
      return step.selector
        ? `wait for ${step.selector}${step.gone ? " to go" : ""}`
        : step.text
          ? `wait for "${step.text}"${step.gone ? " to go" : ""}`
          : `wait ${step.ms ?? 0}ms`;
    case "dismiss":
      return "dismiss overlay";
    case "reload":
      return "reload";
    case "back":
      return "back";
    case "forward":
      return "forward";
    default:
      return step.action;
  }
}

/** Renders a saved flow for the model, flagging steps that will not replay. */
export function formatFlow(flow: Flow): string {
  const lines = [
    `Flow "${flow.name}" · ${flow.steps.length} step(s) · recorded ${flow.createdAt}`,
  ];
  if (flow.startUrl) lines.push(`Starts at ${flow.startUrl}`);
  flow.steps.forEach((step, index) => {
    lines.push(
      `  ${index + 1}. ${describeStep(step)}${step.unreplayable ? `  ⚠ ${step.unreplayable}` : ""}`,
    );
  });
  const broken = flow.steps.filter(step => step.unreplayable).length;
  if (broken > 0) {
    lines.push(
      `${broken} step(s) cannot be replayed as recorded; re-record them by acting on an element with visible text.`,
    );
  }
  return lines.join("\n");
}
