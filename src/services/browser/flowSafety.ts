import { findSecrets } from "./secrets.js";
import type { Flow, FlowStep } from "./flows.js";

/** Metadata only: field contents must never be supplied here. */
export interface FlowFieldMetadata {
  type?: string;
  name?: string;
  id?: string | number;
  autocomplete?: string;
  text?: string;
  aria?: string;
  placeholder?: string;
  sensitive?: boolean;
}

const SENSITIVE_WORD = /(?:^|[^a-z])(?:pass(?:word|phrase|code)?|passwd|pwd|otp|pin|cvv|cvc|ssn|secret|token|credential|authorization|bearer|2fa|mfa|card(?:number)?|cc[ _-]?(?:number|num|exp)|session[ _-]?(?:id|key)|api[ _-]?key|private[ _-]?key|one[ _-]?time[ _-]?(?:code|password)|verification[ _-]?code|security[ _-]?code)(?:$|[^a-z])/i;
const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:cc-\S+|current-password|new-password|one-time-code)(?:$|\s)/i;
const PARAMETER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_PARAMETERS = new Set(["constructor", "prototype", "__proto__"]);
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
const ACTIONS = new Set(["navigate", "click", "fill", "type", "press", "scroll", "dismiss", "wait", "reload", "back", "forward", "frame"]);
const INPUT_KEYS = new Set(["value", "text"]);
const STEP_KEYS = new Set(["action", "target", "url", "value", "key", "text", "direction", "amount", "ms", "selector", "gone", "submit", "unreplayable"]);
const TARGET_KEYS = new Set(["text", "selector", "label", "tag", "role", "nth"]);
const FLOW_KEYS = new Set(["version", "name", "createdAt", "startUrl", "steps", "parameters"]);
const MAX_STRING = 32_768;
const preparedSteps = new WeakSet<object>();

export function isSensitiveFlowField(field: FlowFieldMetadata | undefined): boolean {
  if (!field) return false;
  if (field.sensitive || /^(?:password|hidden)$/i.test(field.type ?? "")) return true;
  if (SENSITIVE_AUTOCOMPLETE.test(field.autocomplete ?? "")) return true;
  return [field.name, field.id, field.text, field.aria, field.placeholder].some(
    value => typeof value === "string" && SENSITIVE_WORD.test(value.replace(/([a-z])([A-Z])/g, "$1 $2")),
  );
}

export function containsFlowSecret(value: string): boolean {
  return findSecrets(value).length > 0;
}

function dataObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor);
}

export function validFlowParameter(name: string): boolean {
  return PARAMETER.test(name) && !FORBIDDEN_PARAMETERS.has(name);
}

/** Reads own string values only; rejects accessors and inherited records. */
export function flowFieldEntries(value: unknown): [string, string][] | { error: string } {
  if (!dataObject(value)) return { error: "Flow fields must be an object of own string values." };
  const entries: [string, string][] = [];
  for (const [name, field] of Object.entries(value)) {
    if (!validFlowParameter(name) || typeof field !== "string" || field.length > MAX_STRING) {
      return { error: "Flow fields contain an invalid parameter name or value." };
    }
    entries.push([name, field]);
  }
  if (entries.length > 64) return { error: "A flow can use at most 64 parameters." };
  return entries;
}

export function flowPlaceholders(value: string): string[] | { error: string } {
  const matches = [...value.matchAll(PLACEHOLDER)];
  if (value.replace(PLACEHOLDER, "").includes("{{") || value.replace(PLACEHOLDER, "").includes("}}")) {
    return { error: "A flow contains an invalid parameter placeholder." };
  }
  const names = matches.map(match => match[1]!);
  if (names.some(name => !validFlowParameter(name))) return { error: "A flow contains an invalid parameter name." };
  return names;
}

export function replaceFlowPlaceholders(value: string, fields: Map<string, string>): string {
  return value.replace(PLACEHOLDER, (_match, name: string) => fields.get(name)!);
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_STRING;
}

/** Validates the full persisted step before data is used or rendered. */
export function validateFlowStep(step: unknown, allowRuntimeValues = false): string | undefined {
  if (!dataObject(step) || !ACTIONS.has(String(step.action))) return "The flow contains an unsupported or malformed step.";
  for (const [key, value] of Object.entries(step)) {
    if (!STEP_KEYS.has(key)) return "A flow step contains an unsupported field.";
    if (value === undefined) continue;
    if (key === "target") {
      if (!dataObject(value)) return "A flow target must be an object.";
      for (const [targetKey, targetValue] of Object.entries(value)) {
        if (!TARGET_KEYS.has(targetKey)) return "A flow target contains an unsupported field.";
        if (targetValue === undefined) continue;
        if (targetKey === "nth") {
          if (!Number.isSafeInteger(targetValue) || (targetValue as number) < 1) return "A flow target has an invalid ordinal.";
        } else if (!validString(targetValue) || containsFlowSecret(targetValue) || targetValue.includes("{{") || targetValue.includes("}}")) {
          return "A flow target contains unsafe or invalid text.";
        }
      }
    } else if (key === "ms" || key === "amount") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "A flow step has an invalid duration or amount.";
    } else if (key === "gone" || key === "submit") {
      if (typeof value !== "boolean") return "A flow step has an invalid flag.";
    } else if (!validString(value)) {
      return "A flow step contains an invalid text value.";
    } else {
      const parameterInput = INPUT_KEYS.has(key) && (step.action === "fill" || step.action === "type");
      if (!allowRuntimeValues || !parameterInput) {
        if (containsFlowSecret(value)) return "A flow step contains a credential literal; re-record it without sensitive input.";
        if (!parameterInput && (value.includes("{{") || value.includes("}}"))) return "Flow parameters are supported only in fill and type input values.";
      }
    }
  }
  if (!allowRuntimeValues && (step.action === "fill" || step.action === "type")) {
    const target = step.target as Record<string, unknown> | undefined;
    const sensitive = isSensitiveFlowField({ text: target?.text as string | undefined, aria: target?.label as string | undefined });
    const input = step.action === "fill" ? step.value : step.text;
    if (sensitive && typeof input === "string" && input.replace(PLACEHOLDER, "") !== "") {
      return "A flow step contains a sensitive field literal; re-record it without sensitive input.";
    }
  }
  return undefined;
}

/** No browser side effects. Ordinary v1 flows remain valid. */
export function validateStoredFlow(flow: unknown): string | undefined {
  if (!dataObject(flow) || !Array.isArray(flow.steps) || flow.steps.length > 300) return "The flow has invalid steps (maximum 300).";
  if (Object.keys(flow).some(key => !FLOW_KEYS.has(key))) return "The flow contains an unsupported field.";
  if (flow.version !== 1 || !validString(flow.name) || !validString(flow.createdAt)) return "The flow has invalid metadata.";
  for (const value of [flow.name, flow.createdAt, flow.startUrl]) {
    if (value !== undefined && (!validString(value) || containsFlowSecret(value) || value.includes("{{") || value.includes("}}"))) {
      return "The flow metadata contains unsafe or invalid text.";
    }
  }
  if (flow.startUrl !== undefined && !validWebUrl(flow.startUrl as string)) return "The flow has an invalid starting URL.";
  const parameters = flow.parameters ?? [];
  if (!Array.isArray(parameters) || parameters.length > 64 || parameters.some(name => typeof name !== "string" || !validFlowParameter(name)) || new Set(parameters).size !== parameters.length) {
    return "The flow has invalid parameter declarations.";
  }
  const declared = new Set(parameters);
  const used = new Set<string>();
  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index];
    const problem = validateFlowStep(step);
    if (problem) return `Step ${index + 1}: ${problem}`;
    for (const key of ["value", "text"] as const) {
      const value = step[key];
      if (typeof value !== "string" || (step.action !== "fill" && step.action !== "type")) continue;
      const names = flowPlaceholders(value);
      if ("error" in names) return `Step ${index + 1}: ${names.error}`;
      for (const name of names) {
        if (!declared.has(name)) return `Step ${index + 1}: a parameter placeholder has no declaration.`;
        used.add(name);
      }
    }
  }
  if (parameters.some(name => !used.has(name))) return "The flow declares an unused parameter.";
  return undefined;
}

export function validWebUrl(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Prepared input values are ephemeral: saving still validates them as literals. */
export function markPreparedFlowStep(step: FlowStep): void {
  preparedSteps.add(step);
}

export function isPreparedFlowStep(step: FlowStep): boolean {
  return preparedSteps.has(step);
}

export function cloneFlow(flow: Flow): Flow {
  return JSON.parse(JSON.stringify(flow)) as Flow;
}
