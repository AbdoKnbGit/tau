/**
 * Recording and replay: the two halves that make a flow worth saving.
 *
 * Kept out of the tool so both can be exercised without a browser. The replay
 * side takes the session through a narrow interface for the same reason — the
 * interesting failures here are "the label moved", "the label is now
 * ambiguous", "the step was never replayable", and none of them need Chromium
 * to reproduce.
 *
 * The rule that makes replay honest: never fall back to a positional guess. A
 * replay that clicks the third button because the second one vanished is worse
 * than one that stops and says which step no longer matches.
 */

import { targetFromElement, type FlowStep } from "./flows.js";

/** The element shape the observation cache hands back. */
export interface ObservedElementLike {
  id: number;
  text?: string;
  aria?: string;
  placeholder?: string;
  tag?: string;
  role?: string;
}

export interface ActionOutcomeLike {
  ok: boolean;
  error?: string;
  reason?: string;
}

/** The slice of the browser session a replay needs. */
export interface FlowSessionLike {
  navigate(url: string, signal?: AbortSignal): Promise<void>;
  click(
    target: { ref?: number; text?: string; nth?: number },
    signal?: AbortSignal,
  ): Promise<ActionOutcomeLike>;
  fill(ref: number, value: string, signal?: AbortSignal): Promise<ActionOutcomeLike>;
  typeText(text: string, submit: boolean, signal?: AbortSignal): Promise<ActionOutcomeLike>;
  press(key: string, signal?: AbortSignal): Promise<ActionOutcomeLike>;
  scroll(
    options: { direction?: string; amount?: number; ref?: number },
    signal?: AbortSignal,
  ): Promise<ActionOutcomeLike>;
  waitAction(
    options: { ms?: number; selector?: string; text?: string; gone?: boolean },
    signal?: AbortSignal,
  ): Promise<ActionOutcomeLike>;
  dismissOverlay(signal?: AbortSignal): Promise<ActionOutcomeLike>;
  reload(hard: boolean, signal?: AbortSignal): Promise<void>;
  goBack(signal?: AbortSignal): Promise<void>;
  goForward(signal?: AbortSignal): Promise<void>;
  observe(
    signal?: AbortSignal,
  ): Promise<{ observation: { interactive_elements: ObservedElementLike[] } }>;
}

/** The action shape the tool records from, structurally typed to avoid coupling. */
export interface RecordableAction {
  action: string;
  ref?: number;
  text?: string;
  url?: string;
  value?: string;
  key?: string;
  submit?: boolean;
  direction?: string;
  amount?: number;
  ms?: number;
  selector?: string;
  gone?: boolean;
}

/** Actions worth writing into a replayable flow. */
export const RECORDABLE_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "fill",
  "type",
  "press",
  "scroll",
  "dismiss",
  "wait",
  "reload",
  "back",
  "forward",
]);

/**
 * Turns a successful action into a step that can run again later. A ref is an
 * id from one observation of one page, so it is resolved to the label it stood
 * for; with no label the step is recorded as explicitly unreplayable rather
 * than as a guess.
 */
export function buildStepFromAction(
  input: RecordableAction,
  element: ObservedElementLike | undefined,
  /** The observation the ref came from, so a repeated label keeps its ordinal. */
  siblings?: ObservedElementLike[],
): FlowStep | null {
  if (!RECORDABLE_ACTIONS.has(input.action)) return null;
  const action = input.action as FlowStep["action"];
  if (input.ref !== undefined) {
    if (!element) {
      return {
        action,
        unreplayable: `@${input.ref} could not be resolved to a label when it was recorded`,
      };
    }
    const resolved = targetFromElement(element, siblings);
    if (resolved.unreplayable) {
      return { action, unreplayable: resolved.unreplayable };
    }
    return {
      action,
      target: resolved.target,
      ...(input.value !== undefined ? { value: input.value } : {}),
    };
  }
  return {
    action,
    ...(input.text && (action === "click" || action === "wait" || action === "type")
      ? action === "click"
        ? { target: { text: input.text } }
        : { text: input.text }
      : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.key ? { key: input.key } : {}),
    ...(input.submit ? { submit: true } : {}),
    ...(input.direction ? { direction: input.direction } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.ms !== undefined ? { ms: input.ms } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.gone ? { gone: true } : {}),
  };
}

/**
 * Finds the element a recorded step refers to. Exact label first, then a single
 * unambiguous contained match — never a positional guess.
 */
export async function resolveRecordedTarget(
  session: FlowSessionLike,
  step: FlowStep,
  signal?: AbortSignal,
): Promise<{ ref: number } | { error: string }> {
  const label = (step.target?.text ?? step.target?.label ?? "").trim();
  if (!label) return { error: "the step has no text or label to search for" };
  const wanted = label.toLowerCase();
  const { observation } = await session.observe(signal);
  const elements = observation.interactive_elements;
  const normalize = (value?: string) => (value ?? "").trim().toLowerCase();
  const nth = step.target?.nth;
  /**
   * Strict on purpose. Falling back to "the first one" is how a replay clicks
   * the wrong row and reports success; the ordinal recorded at capture time is
   * the only sanctioned way to pick among identical labels.
   */
  const pick = (matches: ObservedElementLike[], kind: string) => {
    // An ordinal was recorded because the label was repeated. If the page no
    // longer has that many, the page changed — say so instead of clicking the
    // survivor as though nothing happened.
    if (nth) {
      if (matches[nth - 1]) return { ref: matches[nth - 1]!.id };
      return {
        error: `"${label}" was recorded as ${kind} #${nth} but only ${matches.length} now match`,
      };
    }
    if (matches.length === 1) return { ref: matches[0]!.id };
    return {
      error: `"${label}" now matches ${matches.length} elements, so the step is ambiguous`,
    };
  };
  const exact = elements.filter(
    element =>
      normalize(element.text) === wanted ||
      normalize(element.aria) === wanted ||
      normalize(element.placeholder) === wanted,
  );
  if (exact.length > 0) return pick(exact, "match");
  const partial = elements.filter(
    element =>
      normalize(element.text).includes(wanted) ||
      normalize(element.aria).includes(wanted) ||
      normalize(element.placeholder).includes(wanted),
  );
  if (partial.length > 0) return pick(partial, "partial match");
  return { error: `nothing on the page matches "${label}"` };
}

export type ReplayOutcome = { ok: true } | { ok: false; error: string };

/** Replays one recorded step, or explains precisely why it no longer applies. */
export async function replayStep(
  session: FlowSessionLike,
  step: FlowStep,
  signal?: AbortSignal,
): Promise<ReplayOutcome> {
  if (step.unreplayable) {
    return { ok: false, error: `recorded as unreplayable: ${step.unreplayable}` };
  }
  const fail = (outcome: ActionOutcomeLike): ReplayOutcome => ({
    ok: false,
    error: outcome.error ?? outcome.reason ?? "the action did not succeed",
  });
  switch (step.action) {
    case "navigate": {
      if (!step.url) return { ok: false, error: "the step has no url" };
      await session.navigate(step.url, signal);
      return { ok: true };
    }
    case "click": {
      if (!step.target?.text && !step.target?.label) {
        return { ok: false, error: "the step has no clickable label" };
      }
      // Resolved through an observation rather than clicked by text directly:
      // an in-page text click silently takes the first match, which is the one
      // thing a replay must never do.
      const resolved = await resolveRecordedTarget(session, step, signal);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const outcome = await session.click({ ref: resolved.ref }, signal);
      return outcome.ok ? { ok: true } : fail(outcome);
    }
    case "fill": {
      const resolved = await resolveRecordedTarget(session, step, signal);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const outcome = await session.fill(resolved.ref, step.value ?? "", signal);
      return outcome.ok ? { ok: true } : fail(outcome);
    }
    case "type": {
      const outcome = await session.typeText(step.text ?? "", step.submit ?? false, signal);
      return outcome.ok ? { ok: true } : fail(outcome);
    }
    case "press": {
      const outcome = await session.press(step.key ?? "Enter", signal);
      return outcome.ok ? { ok: true } : fail(outcome);
    }
    case "scroll": {
      const outcome = await session.scroll(
        {
          ...(step.direction ? { direction: step.direction } : {}),
          ...(step.amount !== undefined ? { amount: step.amount } : {}),
        },
        signal,
      );
      return outcome.ok ? { ok: true } : fail(outcome);
    }
    case "wait": {
      const outcome = await session.waitAction(
        {
          ...(step.ms !== undefined ? { ms: step.ms } : {}),
          ...(step.selector ? { selector: step.selector } : {}),
          ...(step.text ? { text: step.text } : {}),
          ...(step.gone ? { gone: true } : {}),
        },
        signal,
      );
      return outcome.ok ? { ok: true } : fail(outcome);
    }
    case "dismiss": {
      const outcome = await session.dismissOverlay(signal);
      return outcome.ok ? { ok: true } : fail(outcome);
    }
    case "reload":
      await session.reload(false, signal);
      return { ok: true };
    case "back":
      await session.goBack(signal);
      return { ok: true };
    case "forward":
      await session.goForward(signal);
      return { ok: true };
    default:
      return { ok: false, error: `no replay support for "${step.action}"` };
  }
}
