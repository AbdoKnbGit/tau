/**
 * Standing observations.
 *
 * Everything else in the browser is request/response: the model asks, the page
 * answers. The dev loop is not shaped like that — you edit a file, the dev
 * server reloads, and *then* something breaks. Without a standing condition,
 * noticing that costs a full console read and a network read per turn, so in
 * practice nobody looks and the error is found by the user instead.
 *
 * A watch registers what matters once. Event conditions are matched against the
 * console and network rings the session already captures, so nothing new runs
 * in the background; DOM conditions are evaluated when the watch is checked.
 *
 * HONEST LIMIT: alerts surface when the tool is next called (any browser action
 * drains them, and `watch` with no arguments checks on demand). This does not
 * interrupt the model out of band.
 */

/** Structural view of a captured console line; matches the session's own type. */
export interface WatchConsoleEntry {
  ts: number;
  level: string;
  text: string;
}

/** Structural view of a captured request; matches the session's own type. */
export interface WatchNetworkEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  error?: string;
}

export type WatchKind =
  | "console.error"
  | "console.warn"
  | "console.any"
  | "request.failed"
  | "selector.appears"
  | "selector.gone"
  | "text.appears"
  | "url.matches";

export interface WatchCondition {
  kind: WatchKind;
  /** Selector, text or substring the condition is about. */
  arg?: string;
  /** The spec exactly as the caller wrote it. */
  spec: string;
}

export interface WatchAlert {
  spec: string;
  detail: string;
  ts: number;
}

const EVENT_KINDS = new Set<WatchKind>([
  "console.error",
  "console.warn",
  "console.any",
  "request.failed",
]);

const KINDS_REQUIRING_ARG = new Set<WatchKind>([
  "selector.appears",
  "selector.gone",
  "text.appears",
  "url.matches",
]);

export const WATCH_KINDS: WatchKind[] = [
  "console.error",
  "console.warn",
  "console.any",
  "request.failed",
  "selector.appears",
  "selector.gone",
  "text.appears",
  "url.matches",
];

export function isEventCondition(condition: WatchCondition): boolean {
  return EVENT_KINDS.has(condition.kind);
}

/**
 * `console.error`, `request.failed`, `selector.gone:#cart`, `text.appears:Saved`.
 * The argument may contain colons; only the first splits.
 */
export function parseWatchSpec(spec: string): WatchCondition | { error: string } {
  const trimmed = String(spec ?? "").trim();
  if (!trimmed) return { error: "Empty watch condition." };
  const separator = trimmed.indexOf(":");
  const kind = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim() as WatchKind;
  const arg = separator === -1 ? undefined : trimmed.slice(separator + 1).trim();
  if (!WATCH_KINDS.includes(kind)) {
    return {
      error: `Unknown watch condition "${kind}". Use one of: ${WATCH_KINDS.join(", ")}.`,
    };
  }
  if (KINDS_REQUIRING_ARG.has(kind) && !arg) {
    return { error: `"${kind}" needs an argument, for example ${kind}:.my-selector` };
  }
  return { kind, ...(arg ? { arg } : {}), spec: trimmed };
}

function levelMatches(entryLevel: string, want: WatchKind): boolean {
  const level = entryLevel.toLowerCase();
  if (want === "console.error") return level === "error" || level === "exception";
  if (want === "console.warn") return level === "warning" || level === "warn";
  return true;
}

/**
 * Matches event conditions against entries newer than `sinceTs`. Pure: the
 * caller owns the cursor, so a check never loses an alert it did not report.
 */
export function matchEventAlerts(
  conditions: WatchCondition[],
  events: {
    console: WatchConsoleEntry[];
    network: WatchNetworkEntry[];
    sinceTs: number;
  },
): WatchAlert[] {
  const alerts: WatchAlert[] = [];
  for (const condition of conditions) {
    if (!isEventCondition(condition)) continue;
    if (condition.kind === "request.failed") {
      for (const request of events.network) {
        if (request.ts <= events.sinceTs) continue;
        const failed = !!request.error || (request.status !== undefined && request.status >= 400);
        if (!failed) continue;
        if (condition.arg && !request.url.toLowerCase().includes(condition.arg.toLowerCase())) {
          continue;
        }
        alerts.push({
          spec: condition.spec,
          ts: request.ts,
          detail: `${request.method} ${request.status ?? request.error ?? "failed"} ${request.url}`,
        });
      }
      continue;
    }
    for (const line of events.console) {
      if (line.ts <= events.sinceTs) continue;
      if (!levelMatches(line.level, condition.kind)) continue;
      if (condition.arg && !line.text.toLowerCase().includes(condition.arg.toLowerCase())) {
        continue;
      }
      alerts.push({
        spec: condition.spec,
        ts: line.ts,
        detail: `[${line.level}] ${line.text.slice(0, 300)}`,
      });
    }
  }
  return alerts.sort((a, b) => a.ts - b.ts);
}

/**
 * Builds one expression evaluating every DOM condition. Arguments travel as
 * JSON data, never as concatenated code.
 */
export function buildWatchDomScript(conditions: WatchCondition[]): string {
  const payload = JSON.stringify(
    conditions
      .filter(condition => !isEventCondition(condition))
      .map(condition => ({ kind: condition.kind, arg: condition.arg ?? "", spec: condition.spec })),
  );
  return `(function(){
  var conditions = ${payload};
  var results = [];
  for (var i = 0; i < conditions.length; i++) {
    var condition = conditions[i];
    var hit = false;
    var detail = '';
    try {
      if (condition.kind === 'selector.appears' || condition.kind === 'selector.gone') {
        var found = null;
        try { found = document.querySelector(condition.arg); } catch (e) {
          results.push({ spec: condition.spec, hit: false, detail: 'invalid selector: ' + (e && e.message ? e.message : String(e)), invalid: true });
          continue;
        }
        var visible = false;
        if (found) {
          try {
            var rect = found.getBoundingClientRect();
            var style = getComputedStyle(found);
            visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          } catch (e) { visible = true; }
        }
        hit = condition.kind === 'selector.appears' ? visible : !visible;
        detail = condition.kind === 'selector.appears'
          ? (hit ? 'now present and visible' : 'not present')
          : (hit ? 'no longer visible' : 'still visible');
      } else if (condition.kind === 'text.appears') {
        var body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
        hit = body.toLowerCase().indexOf(String(condition.arg).toLowerCase()) >= 0;
        detail = hit ? 'text is on the page' : 'text is not on the page';
      } else if (condition.kind === 'url.matches') {
        hit = location.href.toLowerCase().indexOf(String(condition.arg).toLowerCase()) >= 0;
        detail = location.href;
      }
    } catch (e) {
      detail = 'check failed: ' + (e && e.message ? e.message : String(e));
    }
    results.push({ spec: condition.spec, hit: hit, detail: detail });
  }
  return results;
})()`;
}

export interface WatchDomResult {
  spec: string;
  hit: boolean;
  detail: string;
  invalid?: boolean;
}

/** Renders a check for the model. States plainly when nothing fired. */
export function formatWatchReport(input: {
  conditions: WatchCondition[];
  alerts: WatchAlert[];
  dom: WatchDomResult[];
  droppedHint?: string;
}): string {
  const lines: string[] = [];
  if (input.conditions.length === 0) {
    return "No watch conditions are registered. Add some with { \"action\": \"watch\", \"conditions\": [\"console.error\", \"request.failed\"] }.";
  }
  lines.push(
    `Watching ${input.conditions.length} condition(s): ${input.conditions.map(c => c.spec).join(", ")}`,
  );
  if (input.alerts.length > 0) {
    lines.push("", `${input.alerts.length} new event(s) since the last check:`);
    for (const alert of input.alerts.slice(0, 40)) {
      lines.push(`  [${alert.spec}] ${alert.detail}`);
    }
    if (input.alerts.length > 40) {
      lines.push(`  … and ${input.alerts.length - 40} more`);
    }
  }
  const fired = input.dom.filter(result => result.hit);
  const quiet = input.dom.filter(result => !result.hit && !result.invalid);
  const invalid = input.dom.filter(result => result.invalid);
  if (fired.length > 0) {
    lines.push("", "Page conditions met:");
    for (const result of fired) lines.push(`  [${result.spec}] ${result.detail}`);
  }
  if (quiet.length > 0) {
    lines.push("", "Page conditions not met:");
    for (const result of quiet) lines.push(`  [${result.spec}] ${result.detail}`);
  }
  if (invalid.length > 0) {
    lines.push("", "Broken conditions:");
    for (const result of invalid) lines.push(`  [${result.spec}] ${result.detail}`);
  }
  if (input.alerts.length === 0 && fired.length === 0) {
    lines.push("", "Nothing fired since the last check.");
  }
  if (input.droppedHint) lines.push("", input.droppedHint);
  return lines.join("\n");
}
