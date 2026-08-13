import type { ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve as resolvePath } from "path";
import { pathToFileURL } from "url";

import { isEnvTruthy } from "../../utils/envUtils.js";
import { CdpClient } from "./cdp.js";
import {
  getBrowserProfileDir,
  launchBrowser,
  resolveExistingBrowser,
} from "./chromeLauncher.js";
import {
  buildStealthScript,
  detectBlocker,
  MAX_OBSERVED_ELEMENTS,
  NUDGE_SCRIPT,
  OBSERVE_SCRIPT,
  OVERLAY_DISMISS_SCRIPT,
  PAGE_TOOLS_SCRIPT,
  prunePayloadElements,
  type ClickPrepareResult,
  type InteractiveElement,
  type ObservedState,
  type PageActionResult,
  type ReadResult,
} from "./pageScripts.js";

export interface TabInfo {
  index: number;
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserActionOutcome {
  ok: boolean;
  error?: string;
  /** Machine-readable failure category when ok is false. */
  reason?: string;
  /** Action-specific details (navigatedTo, verified, selected, newTab, ...). */
  detail?: Record<string, unknown>;
  observation?: ObservedState;
  warnings: string[];
}

export interface ClickTarget {
  ref?: number;
  text?: string;
  nth?: number;
  x?: number;
  y?: number;
}

export type ResolvedClickTarget =
  | { kind: "ref"; ref: number }
  | { kind: "text"; text: string; nth: number }
  | { kind: "coordinates"; x: number; y: number };

/**
 * Chooses exactly one click target. Semantic targets always win over incidental
 * coordinates so a mixed payload cannot turn an approved @ref/text click into
 * a blind coordinate click.
 */
export function resolveClickTarget(
  target: ClickTarget,
): ResolvedClickTarget | null {
  if (target.ref !== undefined) {
    return { kind: "ref", ref: Number(target.ref) };
  }
  if (target.text?.trim()) {
    return {
      kind: "text",
      text: target.text,
      nth: Number(target.nth ?? 1),
    };
  }
  if (target.x !== undefined && target.y !== undefined) {
    return {
      kind: "coordinates",
      x: Number(target.x),
      y: Number(target.y),
    };
  }
  return null;
}

export interface ConsoleEntry {
  ts: number;
  /** log | info | warning | error | debug | exception */
  level: string;
  text: string;
  source?: string;
}

export interface NetworkEntry {
  ts: number;
  requestId: string;
  method: string;
  url: string;
  /** CDP resource type: Document, XHR, Fetch, Script, ... */
  type?: string;
  status?: number;
  mime?: string;
  error?: string;
  finished?: boolean;
}

/** Ring-buffer cap per tab for console and network capture. */
const EVENT_BUFFER_CAP = 300;

export function formatConsoleEntries(
  entries: ConsoleEntry[],
  options: { level?: string; filter?: string; limit?: number },
): string {
  const levelWant = (options.level ?? "all").toLowerCase();
  const filter = options.filter?.toLowerCase();
  const matchLevel = (level: string) => {
    if (levelWant === "all") return true;
    if (levelWant === "error")
      return level === "error" || level === "exception" || level === "assert";
    if (levelWant === "warn") return level === "warning" || level === "warn";
    return level === levelWant;
  };
  const picked = entries.filter(
    (e) =>
      matchLevel(e.level) && (!filter || e.text.toLowerCase().includes(filter)),
  );
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const shown = picked.slice(-limit);
  const lines = shown.map((e) => {
    const time = new Date(e.ts).toTimeString().slice(0, 8);
    const src = e.source ? `  (${e.source})` : "";
    return `[${time}] ${e.level}: ${e.text.slice(0, 400)}${src}`;
  });
  const omitted = picked.length - shown.length;
  if (omitted > 0)
    lines.unshift(`(...${omitted} earlier matching message(s) omitted)`);
  return lines.join("\n");
}

export function formatNetworkEntries(
  entries: NetworkEntry[],
  options: { filter?: string; failedOnly?: boolean; limit?: number },
): string {
  const filter = options.filter?.toLowerCase();
  const picked = entries.filter((e) => {
    if (filter && !e.url.toLowerCase().includes(filter)) return false;
    if (options.failedOnly) {
      return !!e.error || (e.status !== undefined && e.status >= 400);
    }
    return true;
  });
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const shown = picked.slice(-limit);
  const lines = shown.map((e) => {
    const status = e.error
      ? `FAILED(${e.error.slice(0, 60)})`
      : e.status !== undefined
        ? String(e.status)
        : e.finished
          ? "done"
          : "pending";
    const type = e.type ? ` [${e.type.toLowerCase()}]` : "";
    return `${e.method} ${status} ${e.url.slice(0, 200)}${type}`;
  });
  const omitted = picked.length - shown.length;
  if (omitted > 0)
    lines.unshift(`(...${omitted} earlier matching request(s) omitted)`);
  return lines.join("\n");
}

interface EvaluateResult {
  result?: { type?: string; value?: unknown; description?: string };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface TabActivityProbe {
  focused: boolean;
  visible: boolean;
  url?: string;
  title?: string;
}

interface KeyEntry {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

const KEY_MAP: Record<string, KeyEntry> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
};
for (let f = 1; f <= 12; f++) {
  KEY_MAP[`f${f}`] = { key: `F${f}`, code: `F${f}`, vk: 111 + f };
}

export const SUPPORTED_KEYS = Object.keys(KEY_MAP);

/** CDP Input modifier bits. */
const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  shift: 8,
};

export interface ParsedChord {
  entry: KeyEntry;
  modifiers: number;
  /** True when the main key was a named key (Enter, Space, F5, ...). */
  named?: boolean;
  /** Renderer editing command (selectAll/copy/paste/cut) for reliability. */
  commands?: string[];
}

/**
 * Parses a key spec like "Enter", "a", "Control+a", "Ctrl+Shift+ArrowRight"
 * into a CDP key event plan. Pure so it can be unit-tested. Returns an error
 * string for unsupported specs instead of throwing.
 */
export function parseChord(spec: string): ParsedChord | { error: string } {
  const parts = String(spec)
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { error: "Empty key." };
  let modifiers = 0;
  const rest: string[] = [];
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (
      bit !== undefined &&
      (rest.length === 0 || part !== parts[parts.length - 1])
    ) {
      modifiers |= bit;
    } else {
      rest.push(part);
    }
  }
  if (rest.length !== 1) {
    return {
      error:
        rest.length === 0
          ? `"${spec}" is only modifiers. Add a main key, e.g. "Control+a".`
          : `"${spec}" has multiple main keys. Use one main key per press.`,
    };
  }
  const main = rest[0]!;
  const named = KEY_MAP[main.toLowerCase()];
  let entry: KeyEntry;
  let wasNamed = false;
  if (named) {
    entry = named;
    wasNamed = true;
  } else if (main.length === 1) {
    const ch = main;
    const upper = ch.toUpperCase();
    const isLetter = /[a-z]/i.test(ch);
    const isDigit = /[0-9]/.test(ch);
    entry = {
      key: modifiers & 8 && isLetter ? upper : ch,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : "",
      vk: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      // Ctrl/Alt/Meta chords are shortcuts, not text entry.
      ...(modifiers & ~8 ? {} : { text: ch }),
    };
  } else {
    return {
      error: `Unsupported key "${main}". Use a named key (${SUPPORTED_KEYS.slice(0, 12).join(", ")}, ...), a single character, or a chord like Control+a.`,
    };
  }
  const commands: string[] = [];
  if (modifiers & 2 || modifiers & 4) {
    const cmd = { a: "selectAll", c: "copy", v: "paste", x: "cut" }[
      main.toLowerCase()
    ];
    if (cmd) commands.push(cmd);
  }
  return {
    entry,
    modifiers,
    ...(wasNamed ? { named: true } : {}),
    ...(commands.length ? { commands } : {}),
  };
}

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function safeJson(value: unknown, cap = 300): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined
      ? String(value)
      : s.length > cap
        ? `${s.slice(0, cap)}…`
        : s;
  } catch {
    return String(value);
  }
}

function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** Two coordinate clicks are "the same spot" within this pixel radius. */
export const COORD_REPEAT_RADIUS_PX = 70;
/** Blind coordinate clicks in a row (with no look between) before we block. */
export const COORD_STREAK_LIMIT = 3;

/**
 * Decides whether a new blind coordinate click at (x, y) should be blocked,
 * given the coordinate clicks already made since the last explicit look.
 * Pure so the guard can be unit-tested without a live browser.
 *
 *  - 'repeat' — lands on a spot already clicked that did nothing; repeating it
 *    cannot help.
 *  - 'streak' — the model has clicked blind coordinates COORD_STREAK_LIMIT times
 *    without observing/screenshotting; it is guessing.
 *  - null — allow.
 */
export function classifyCoordinateStreak(
  previous: ReadonlyArray<{ x: number; y: number }>,
  x: number,
  y: number,
): "repeat" | "streak" | null {
  const near = previous.some(
    (c) => Math.hypot(c.x - x, c.y - y) < COORD_REPEAT_RADIUS_PX,
  );
  const countIncludingThis = previous.length + 1;
  if (near && countIncludingThis >= 2) return "repeat";
  if (countIncludingThis >= COORD_STREAK_LIMIT) return "streak";
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Turns what the model passed into a navigable URL. Scheme-less input gets
 * https://, except: local dev hosts (localhost, 127.0.0.1, [::1], 0.0.0.0)
 * get http:// because dev servers rarely speak TLS, and an existing local
 * file path becomes a file:// URL so freshly written HTML can be opened
 * directly. Pure: file existence is injected for testability.
 */
export function normalizeUrlForNavigation(
  url: string,
  fileExists: (path: string) => boolean,
): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(file|javascript|data|about|chrome):/i.test(trimmed)) return trimmed;
  if (
    /^([a-zA-Z]:[\\/]|\/|\.{1,2}[\\/])/.test(trimmed) &&
    fileExists(trimmed)
  ) {
    return pathToFileURL(resolvePath(trimmed)).href;
  }
  const host = (
    trimmed.match(/^(\[[^\]]+\]|[^/:?#]+)/)?.[1] ?? ""
  ).toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]"
  ) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

function normalizeUrl(url: string): string {
  return normalizeUrlForNavigation(url, existsSync);
}

function isNavigableUrl(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) ||
    /^file:\/\//i.test(url) ||
    url === "about:blank"
  );
}

function isRegularPage(target: TargetInfo): boolean {
  return (
    target.type === "page" &&
    !target.url.startsWith("devtools://") &&
    !target.url.startsWith("chrome-extension://")
  );
}

function createRefRegistryKey(): string {
  return (
    "tau-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
  );
}

function createTabActivityBindingName(): string {
  return (
    "__tauTabActivity_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2)
  );
}

/**
 * Browser-side activity tracker. It reports only trusted focus/input events;
 * Node verifies focus again before changing the active CDP target. The tracker
 * owns and cleans up only its own listeners, so it cannot disturb application
 * or extension listeners on the page.
 */
export function buildTabActivityScript(bindingName: string): string {
  const binding = JSON.stringify(bindingName);
  return `
(function(){
  const bindingName = ${binding};
  const stateKey = '__tauTabActivityTracker';
  const previous = window[stateKey];
  if (previous && previous.bindingName === bindingName) return true;
  if (previous && typeof previous.cleanup === 'function') {
    try { previous.cleanup(); } catch (e) {}
  }

  const listeners = [];
  const add = (target, type, handler) => {
    target.addEventListener(type, handler, true);
    listeners.push({ target, type, handler });
  };
  const notify = (event) => {
    if (!event || event.isTrusted !== true) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const report = window[bindingName];
    if (typeof report !== 'function') return;
    try {
      report(JSON.stringify({ type: String(event.type || 'activity'), ts: Date.now() }));
    } catch (e) {}
  };

  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
    add(document, type, notify);
  }
  add(window, 'focus', notify);
  add(document, 'visibilitychange', notify);

  const state = {
    bindingName,
    cleanup() {
      for (const item of listeners) {
        try { item.target.removeEventListener(item.type, item.handler, true); } catch (e) {}
      }
    }
  };
  try {
    Object.defineProperty(window, stateKey, { configurable: true, value: state });
  } catch (e) {
    window[stateKey] = state;
  }
  return true;
})()
`;
}

/** Pure decision gate used after a tab reports human activity. */
export function shouldAdoptTabActivity(
  activeTargetId: string | undefined,
  candidateTargetId: string | undefined,
  probe: TabActivityProbe | null,
): boolean {
  return !!(
    candidateTargetId &&
    candidateTargetId !== activeTargetId &&
    probe?.focused &&
    probe.visible
  );
}

class BrowserSessionService {
  private client?: CdpClient;
  private child?: ChildProcess;
  private mode: "spawned" | "attached" = "spawned";
  private sessions = new Map<string, string>();
  /** Coalesces concurrent attachment attempts for the same tab. */
  private sessionPromises = new Map<string, Promise<string>>();
  /** Tabs with the full console/network/stealth setup, not just activity tracking. */
  private fullyPreparedTargets = new Set<string>();
  /** Tabs with the human-activity binding and page listener installed. */
  private activityTargets = new Set<string>();
  private activityBindingName = createTabActivityBindingName();
  private activeTargetId?: string;
  private cachedElements = new Map<number, InteractiveElement>();
  private cachedElementsTargetId?: string;
  private lastKnownUrl?: string;
  /**
   * Ref ids come from session-wide, non-overlapping blocks. This keeps ids
   * disjoint across observations, tabs, and new documents while the in-page
   * registry preserves ids for DOM nodes that survive a rerender.
   */
  private nextRefBase = 0;
  private refRegistryKey = createRefRegistryKey();
  private exitHookInstalled = false;
  /** Anti-detection: injected on every new document per target. */
  private stealthScript?: string;
  private cachedUserAgent?: string;
  private stealthTargets = new Set<string>();
  /**
   * Recent blind coordinate clicks since the last explicit observe/screenshot.
   * Drives the guard that stops the model from bashing coordinates (guessing
   * (x,y) without seeing the page), which is how it nukes its own progress.
   */
  private coordClicks: Array<{ x: number; y: number }> = [];
  /** Reverse of `sessions`, for routing CDP events back to their tab. */
  private sessionToTarget = new Map<string, string>();
  /** Per-tab capture of console messages + uncaught exceptions. */
  private consoleBuf = new Map<string, ConsoleEntry[]>();
  /** Per-tab capture of network requests (ordered, ring-capped). */
  private networkBuf = new Map<string, NetworkEntry[]>();
  private networkIndex = new Map<string, Map<string, NetworkEntry>>();
  /** Requests started but not yet finished/failed, per tab (settle signal). */
  private inflight = new Map<string, Set<string>>();
  /** Auto-handled JS dialogs + finished downloads, drained into warnings. */
  private sessionNotes: string[] = [];
  private downloadDir?: string;
  private downloadNames = new Map<string, string>();

  isRunning(): boolean {
    return !!this.client?.isOpen;
  }

  getCachedElement(ref: number): InteractiveElement | undefined {
    if (this.cachedElementsTargetId !== this.activeTargetId) return undefined;
    return this.cachedElements.get(ref);
  }

  getLastKnownUrl(): string | undefined {
    return this.lastKnownUrl;
  }

  /**
   * Clears the blind-coordinate-click streak. Called by the tool layer when the
   * model takes an explicit look at the page (observe/screenshot) — NOT on the
   * implicit observation that trails every action, or the guard would never
   * accumulate across a run of clicks.
   */
  resetCoordinateGuard(): void {
    this.coordClicks = [];
  }

  /**
   * Records a blind coordinate click and returns a block message when the model
   * is coordinate-bashing: 3+ in a row without looking, or repeating a spot that
   * already did nothing. Returns null to allow the click.
   */
  private guardCoordinateClick(x: number, y: number): string | null {
    const verdict = classifyCoordinateStreak(this.coordClicks, x, y);
    this.coordClicks.push({ x, y });
    if (verdict === "repeat") {
      return (
        "Blocked: you already clicked almost this exact spot and it did nothing. " +
        "Repeating the same coordinates will not help. Take a screenshot to see " +
        "what is actually there, or observe and click the target by its @ref."
      );
    }
    if (verdict === "streak") {
      return (
        `Blocked: that is ${this.coordClicks.length} coordinate clicks in a row with no ` +
        "observe or screenshot in between - this is blind guessing, which is exactly " +
        "what nukes progress by hitting the wrong element. STOP guessing coordinates. " +
        "Take a screenshot to SEE the page, or observe to get element @refs and click " +
        "by ref/text. To close a modal or popup, use the dismiss action."
      );
    }
    return null;
  }

  /**
   * A stale numeric ref is not safe to retry after observing because the new
   * registry may assign that number to a different element. Refresh once and
   * return the fresh observation so the caller can use its replacement ref.
   */
  private async pageActionFailureOutcome(
    result: PageActionResult,
    fallbackError: string,
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const failed: BrowserActionOutcome = {
      ok: false,
      reason: result.reason,
      error: result.error ?? fallbackError,
      warnings: [],
    };
    if (
      result.reason !== "stale_ref" &&
      result.reason !== "element_covered" &&
      result.reason !== "not_editable"
    ) {
      return failed;
    }

    try {
      const { observation, warnings } = await this.observe(signal);
      if (result.reason === "element_covered") {
        return {
          ok: false,
          reason: result.reason,
          error:
            (result.error ?? fallbackError) +
            " I refreshed the observation below so the blocking layer and its close control have current refs. " +
            "If it is an overlay or drawer, use dismiss once, then retry using a ref from that refreshed observation.",
          observation,
          warnings,
        };
      }
      if (result.reason === "not_editable") {
        return {
          ok: false,
          reason: result.reason,
          error:
            (result.error ?? fallbackError) +
            " I refreshed the observation below. Fill only an input, textarea, select, or textbox ref from that observation; do not retry the same non-editable ref.",
          observation,
          warnings,
        };
      }
      const change =
        result.staleKind === "registry_missing"
          ? "The page loaded a new document"
          : result.staleKind === "unknown_ref"
            ? "That ref is not in the current observation registry"
            : "The page re-rendered and detached that element";
      return {
        ok: false,
        reason: "stale_ref",
        error: `${change}, so the old numeric ref is no longer safe to use. I refreshed the observation below; retry with the replacement @ref.`,
        observation,
        warnings,
      };
    } catch {
      return failed;
    }
  }

  async ensureStarted(options: {
    headless?: boolean;
    signal?: AbortSignal;
  }): Promise<{ launched: "already" | "spawned" | "attached"; note?: string }> {
    if (this.client?.isOpen) return { launched: "already" };
    this.resetState();

    const connectPort = Number(process.env.TAU_BROWSER_CONNECT_PORT || "");
    if (Number.isInteger(connectPort) && connectPort > 0) {
      const wsUrl = await resolveExistingBrowser(connectPort, options.signal);
      this.client = await CdpClient.connect(wsUrl);
      this.mode = "attached";
      this.installClientHooks();
      await this.setupDownloads();
      await this.prepareStealth();
      await this.ensureActiveTarget();
      await this.startTabActivityTracking();
      return {
        launched: "attached",
        note: `Attached to the already-running browser on port ${connectPort} (its real profile and logins).`,
      };
    }

    const headless =
      options.headless ?? isEnvTruthy(process.env.TAU_BROWSER_HEADLESS);
    const launched = await launchBrowser({ headless, signal: options.signal });
    this.child = launched.child;
    this.client = await CdpClient.connect(launched.wsUrl);
    this.mode = "spawned";
    this.installClientHooks();
    this.installExitHook();
    await this.setupDownloads();
    await this.prepareStealth();
    await this.ensureActiveTarget();
    await this.startTabActivityTracking();
    return {
      launched: "spawned",
      note: `Launched ${launched.executable}${headless ? " (headless)" : ""} with an isolated automation profile.`,
    };
  }

  /**
   * Routes downloads somewhere known and turns on progress events, so the
   * model learns "Downloaded report.csv → <path>" instead of files vanishing
   * into a profile dir. In attached mode the user's own download location is
   * left alone; we only enable the events.
   */
  private async setupDownloads(): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (this.mode === "spawned") {
      const dir = resolvePath(getBrowserProfileDir(), "downloads");
      try {
        mkdirSync(dir, { recursive: true });
        this.downloadDir = dir;
        await client.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: dir,
          eventsEnabled: true,
        });
      } catch {
        this.downloadDir = undefined;
      }
    } else {
      await client
        .send("Browser.setDownloadBehavior", {
          behavior: "default",
          eventsEnabled: true,
        })
        .catch(() => undefined);
    }
  }

  async listTabs(): Promise<TabInfo[]> {
    const client = this.requireClient();
    const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    const pages = targetInfos
      .filter(isRegularPage)
      .sort((a, b) => a.targetId.localeCompare(b.targetId));
    return pages.map((page, index) => ({
      index,
      targetId: page.targetId,
      url: page.url,
      title: page.title,
      active: page.targetId === this.activeTargetId,
    }));
  }

  async selectTab(index: number): Promise<TabInfo[]> {
    const client = this.requireClient();
    const tabs = await this.listTabs();
    const tab = tabs[index];
    if (!tab) {
      throw new Error(
        `No tab with index ${index}. Open tabs: ${tabs.map((t) => `${t.index}: ${t.title || t.url}`).join(", ") || "none"}`,
      );
    }
    // Keep the tool's active target and the user-visible browser tab aligned.
    await client.send("Target.activateTarget", { targetId: tab.targetId });
    this.activeTargetId = tab.targetId;
    this.coordClicks = [];
    await this.getActiveSession();
    return this.listTabs();
  }

  async newTab(url?: string): Promise<void> {
    const client = this.requireClient();
    const { targetId } = await client.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    await client.send("Target.activateTarget", { targetId });
    this.activeTargetId = targetId;
    this.coordClicks = [];
    await this.getActiveSession();
    if (url) await this.navigate(url);
  }

  async closeTab(index?: number): Promise<TabInfo[]> {
    const client = this.requireClient();
    const tabs = await this.listTabs();
    const tab = index === undefined ? tabs.find((t) => t.active) : tabs[index];
    if (!tab) {
      throw new Error(
        index === undefined
          ? "No active tab to close."
          : `No tab with index ${index}.`,
      );
    }
    await client.send("Target.closeTarget", { targetId: tab.targetId });
    const staleSession = this.sessions.get(tab.targetId);
    if (staleSession) this.sessionToTarget.delete(staleSession);
    this.sessions.delete(tab.targetId);
    this.sessionPromises.delete(tab.targetId);
    this.fullyPreparedTargets.delete(tab.targetId);
    this.activityTargets.delete(tab.targetId);
    this.consoleBuf.delete(tab.targetId);
    this.networkBuf.delete(tab.targetId);
    this.networkIndex.delete(tab.targetId);
    this.inflight.delete(tab.targetId);
    if (this.activeTargetId === tab.targetId) {
      this.activeTargetId = undefined;
      await this.ensureActiveTarget();
    }
    return this.listTabs();
  }

  async navigate(url: string, signal?: AbortSignal): Promise<void> {
    const target = normalizeUrl(url);
    if (!isNavigableUrl(target)) {
      throw new Error(
        `The browser only navigates to http(s), file:// and about:blank URLs, not "${url}". ` +
          "A plain local path works when the file exists (it becomes a file:// URL).",
      );
    }
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const loadFired = client.waitForEvent(
      "Page.loadEventFired",
      sessionId,
      15_000,
    );
    const result = await client.send<{ errorText?: string }>(
      "Page.navigate",
      { url: target },
      sessionId,
    );
    if (result.errorText && result.errorText !== "net::ERR_ABORTED") {
      throw new Error(`Navigation to ${target} failed: ${result.errorText}`);
    }
    await loadFired;
    await this.waitForSettle(signal);
    this.lastKnownUrl = target;
    this.coordClicks = [];
  }

  async goBack(signal?: AbortSignal): Promise<void> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const history = await client.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>("Page.getNavigationHistory", {}, sessionId);
    if (history.currentIndex <= 0) {
      throw new Error("No earlier page in this tab’s history.");
    }
    const entry = history.entries[history.currentIndex - 1]!;
    await client.send(
      "Page.navigateToHistoryEntry",
      { entryId: entry.id },
      sessionId,
    );
    await this.waitForSettle(signal);
  }

  async observe(signal?: AbortSignal): Promise<{
    observation: ObservedState;
    warnings: string[];
  }> {
    // Reserve before any await so concurrent observations cannot share a block.
    const refBase = this.nextRefBase;
    this.nextRefBase += MAX_OBSERVED_ELEMENTS;
    await this.evaluate(NUDGE_SCRIPT).catch(() => undefined);
    const dismissed = await this.evaluate<string>(OVERLAY_DISMISS_SCRIPT).catch(
      () => "",
    );
    if (dismissed) await sleep(350, signal);

    const observeConfig = JSON.stringify({
      sessionKey: this.refRegistryKey,
      base: refBase,
    });
    const raw = await this.evaluate<ObservedState>(
      "window.__tauObserveConfig = " + observeConfig + ";\n" + OBSERVE_SCRIPT,
    );
    if (!raw || !Array.isArray(raw.interactive_elements)) {
      throw new Error("Could not observe the page (no DOM available yet).");
    }
    raw.interactive_elements = prunePayloadElements(raw.interactive_elements);
    await this.callPageTools<PageActionResult>(
      "setObservedIds(" +
        JSON.stringify(raw.interactive_elements.map((el) => el.id)) +
        ")",
    ).catch(() => undefined);
    if (dismissed) raw.dismissed = dismissed;

    this.cachedElements = new Map(
      raw.interactive_elements.map((el) => [el.id, el]),
    );
    this.cachedElementsTargetId = this.activeTargetId;
    this.lastKnownUrl = raw.url;

    const warnings: string[] = [];
    const blocker = detectBlocker(raw);
    if (blocker) warnings.push(blocker.hint);
    if (raw.crossFrames) {
      warnings.push(
        `${raw.crossFrames} cross-origin iframe(s) on this page are invisible to observe/read. If what you need is inside one, take a screenshot to see it; a coordinate click into it is allowed after that.`,
      );
    }
    warnings.push(...this.drainSessionNotes());
    return { observation: raw, warnings };
  }

  async click(
    target: ClickTarget & { double?: boolean },
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const warnings: string[] = [];
    let prep: ClickPrepareResult;
    let refForClick: number | undefined;
    const selected = resolveClickTarget(target);

    if (selected?.kind === "ref") {
      refForClick = selected.ref;
      prep = await this.callPageTools<ClickPrepareResult>(
        `prepareRef(${selected.ref})`,
      );
    } else if (selected?.kind === "text") {
      prep = await this.callPageTools<ClickPrepareResult>(
        `prepareText(${JSON.stringify(selected.text)}, ${selected.nth})`,
      );
    } else if (selected?.kind === "coordinates") {
      const { x, y } = selected;
      const at = await this.callPageTools<{
        found: boolean;
        label?: string;
        tag?: string;
      }>(`labelAt(${x}, ${y})`);
      const blocked = this.guardCoordinateClick(x, y);
      if (blocked) {
        const here = at?.label
          ? ` The point (${x}, ${y}) sits on: "${at.label}".`
          : "";
        return {
          ok: false,
          reason: "coordinate_guessing",
          error: blocked + here,
          warnings,
        };
      }
      // Even an allowed coordinate click is blind; tell the model what it hit so
      // it can catch a wrong target (e.g. a nav link) before losing progress.
      if (this.cachedElements.size > 0) {
        warnings.push(
          `Coordinate clicks are blind. (${x}, ${y}) is on "${at?.label || at?.tag || "unknown element"}". ` +
            "Prefer clicking by @ref or text; use coordinates only for canvas/map/video with no DOM element.",
        );
      }
      prep = {
        success: true,
        x,
        y,
        label: at?.label,
        tag: at?.tag,
      };
    } else {
      return {
        ok: false,
        reason: "invalid_target",
        error: "click needs a ref, a text, or x+y coordinates.",
        warnings,
      };
    }

    if (!prep.success) {
      const failed = await this.pageActionFailureOutcome(
        prep,
        "Could not resolve the click target.",
        signal,
      );
      failed.warnings.unshift(...warnings);
      return failed;
    }

    const before = await this.pageFingerprint();
    const tabsBefore = await this.listTabs();

    try {
      await this.realClick(prep.x!, prep.y!, signal, target.double ? 2 : 1);
    } catch (error) {
      if (refForClick !== undefined) {
        const fallback = await this.callPageTools<PageActionResult>(
          `fallbackClickRef(${refForClick})`,
        ).catch(() => null);
        if (!fallback?.success) {
          throw error;
        }
        warnings.push(
          "Real input dispatch failed; used a synthetic in-page click instead.",
        );
      } else {
        throw error;
      }
    }

    await this.waitForSettle(signal, { maxMs: 5000 });

    // A click can open a new tab; follow it like a user would.
    const tabsAfter = await this.listTabs().catch(() => tabsBefore);
    const known = new Set(tabsBefore.map((t) => t.targetId));
    const newTab = tabsAfter.find((t) => !known.has(t.targetId));
    if (newTab) {
      this.activeTargetId = newTab.targetId;
      await this.getActiveSession();
      await this.waitForSettle(signal, { maxMs: 4000 });
      warnings.push(`The click opened a new tab; switched to it.`);
    }

    const after = await this.pageFingerprint();
    const detail: Record<string, unknown> = {
      clicked: prep.label || prep.tag || "element",
      ...(newTab ? { newTab: true } : {}),
    };

    // Link that visibly did nothing: fall back to direct navigation, which is
    // more reliable than fighting an interception layer (ported from Bah).
    if (
      !newTab &&
      prep.href &&
      before &&
      after &&
      before.url === after.url &&
      before.elementCount === after.elementCount
    ) {
      await this.navigate(prep.href, signal);
      detail.navigatedTo = prep.href;
      warnings.push(
        "The click had no visible effect; navigated directly to the link target instead.",
      );
    }

    const { observation, warnings: observeWarnings } =
      await this.observe(signal);
    warnings.push(...observeWarnings);
    return { ok: true, detail, observation, warnings };
  }

  async fill(
    ref: number,
    value: string,
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const result = await this.callPageTools<PageActionResult>(
      `fillRef(${Number(ref)}, ${JSON.stringify(value)})`,
    );
    if (!result.success) {
      return this.pageActionFailureOutcome(result, "Fill failed.", signal);
    }
    await this.waitForSettle(signal, { maxMs: 1500 });
    const { observation, warnings } = await this.observe(signal);
    return { ok: true, detail: { ...result.info }, observation, warnings };
  }

  async typeText(
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const focused = await this.callPageTools<{
      editable: boolean;
      tag?: string;
      label?: string;
    }>("focusedInfo()");
    if (!focused?.editable) {
      return {
        ok: false,
        reason: "not_editable",
        error:
          "No editable field has focus. Click the field first (click with its ref), then type.",
        warnings: [],
      };
    }
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    await client.send("Input.insertText", { text }, sessionId);
    const typed = await this.callPageTools<{ length: number }>("verifyTyped()");
    if (text && (!typed || typed.length === 0)) {
      return {
        ok: false,
        reason: "not_editable",
        error:
          "The focused field did not accept the text (still empty). Click the right field before typing, or use fill with the field’s ref.",
        warnings: [],
      };
    }
    if (submit) await this.dispatchKey("enter");
    await this.waitForSettle(signal, { maxMs: submit ? 5000 : 1500 });
    const { observation, warnings } = await this.observe(signal);
    return {
      ok: true,
      detail: {
        typedInto: focused.label || focused.tag,
        length: text.length,
        submitted: submit,
      },
      observation,
      warnings,
    };
  }

  async press(
    key: string,
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const parsed = parseChord(key);
    if ("error" in parsed) {
      return {
        ok: false,
        reason: "invalid_target",
        error: parsed.error,
        warnings: [],
      };
    }
    if (
      !parsed.named &&
      !parsed.modifiers &&
      parsed.entry.text &&
      parsed.entry.key.length === 1
    ) {
      // Bare printable character: insertText types it robustly (IME-safe).
      // Named keys (Space, Enter, ...) always go as real key events, since
      // pages listen for their keydown (players, games, shortcut handlers).
      const client = this.requireClient();
      const sessionId = await this.getActiveSession();
      await client.send(
        "Input.insertText",
        { text: parsed.entry.text },
        sessionId,
      );
    } else {
      await this.dispatchParsedKey(parsed);
    }
    await this.waitForSettle(signal, { maxMs: 4000 });
    const { observation, warnings } = await this.observe(signal);
    return { ok: true, detail: { key }, observation, warnings };
  }

  /**
   * Moves the mouse over an element (by ref or text) with a human-ish path.
   * This is how hover menus, tooltips, and hover-revealed controls open —
   * the observation afterwards contains whatever appeared.
   */
  async hover(
    target: { ref?: number; text?: string; nth?: number },
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    let prep: ClickPrepareResult;
    if (target.ref !== undefined) {
      prep = await this.callPageTools<ClickPrepareResult>(
        `prepareRef(${Number(target.ref)})`,
      );
    } else if (target.text) {
      prep = await this.callPageTools<ClickPrepareResult>(
        `prepareText(${JSON.stringify(target.text)}, ${Number(target.nth ?? 1)})`,
      );
    } else {
      return {
        ok: false,
        reason: "invalid_target",
        error: "hover needs a ref or a text.",
        warnings: [],
      };
    }
    if (!prep.success) {
      return this.pageActionFailureOutcome(
        prep,
        "Could not resolve the hover target.",
        signal,
      );
    }
    await this.moveMouse(prep.x!, prep.y!, signal);
    // Hover UIs typically open on a short delay.
    await sleep(450, signal).catch(() => undefined);
    await this.waitForSettle(signal, { maxMs: 2000 });
    const { observation, warnings } = await this.observe(signal);
    return {
      ok: true,
      detail: { hovered: prep.label || prep.tag },
      observation,
      warnings,
    };
  }

  async scroll(
    options: {
      direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
      amount?: number;
      ref?: number;
    },
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const result =
      options.ref !== undefined
        ? await this.callPageTools<PageActionResult>(
            `scrollToRef(${Number(options.ref)})`,
          )
        : await this.callPageTools<PageActionResult>(
            `scrollPage(${JSON.stringify(options.direction ?? "down")}, ${options.amount ? Number(options.amount) : "undefined"})`,
          );
    if (!result.success) {
      return this.pageActionFailureOutcome(result, "Scroll failed.", signal);
    }
    await this.waitForSettle(signal, { maxMs: 1200 });
    const { observation, warnings } = await this.observe(signal);
    return { ok: true, detail: { ...result.info }, observation, warnings };
  }

  /**
   * Closes the topmost modal/dialog/drawer/popup: clicks its close control, or
   * falls back to the Escape key when the overlay has no obvious close button.
   * The clean way out of a QuickView/lightbox — replaces the coordinate-bashing
   * the model resorts to when a click reports element_covered.
   */
  async dismissOverlay(signal?: AbortSignal): Promise<BrowserActionOutcome> {
    const result = await this.callPageTools<PageActionResult>(
      "dismissTopOverlay()",
    );
    if (!result.success && result.reason === "no_close_button") {
      await this.dispatchKey("escape");
      await this.waitForSettle(signal, { maxMs: 1200 });
      const { observation, warnings } = await this.observe(signal);
      return {
        ok: true,
        detail: { method: "escape" },
        observation,
        warnings: [
          ...warnings,
          "The overlay had no obvious close control, so I sent the Escape key. If it is still open, observe and click its close element by @ref.",
        ],
      };
    }
    if (!result.success) {
      const { observation, warnings } = await this.observe(signal);
      return {
        ok: false,
        reason: result.reason,
        error: result.error ?? "Nothing to dismiss.",
        observation,
        warnings,
      };
    }
    await this.waitForSettle(signal, { maxMs: 1500 });
    const { observation, warnings } = await this.observe(signal);
    return { ok: true, detail: { ...result.info }, observation, warnings };
  }

  async waitAction(
    options: {
      ms?: number;
      selector?: string;
      text?: string;
      gone?: boolean;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    if (options.selector || options.text) {
      const timeout = Math.min(options.timeoutMs ?? 5000, 30_000);
      const result = await this.callPageTools<PageActionResult>(
        `waitForCondition(${JSON.stringify(options.selector ?? null)}, ${JSON.stringify(options.text ?? null)}, ${options.gone ? "true" : "false"}, ${timeout})`,
        { awaitPromise: true, timeoutMs: timeout + 5000 },
      );
      if (!result.success) {
        return {
          ok: false,
          reason: result.reason ?? "timeout",
          error: result.error ?? "Wait timed out.",
          warnings: [],
        };
      }
    } else {
      await sleep(Math.min(options.ms ?? 1000, 30_000), signal);
    }
    const { observation, warnings } = await this.observe(signal);
    return { ok: true, observation, warnings };
  }

  /**
   * Extracts the rendered page (or a selector within it) as compact markdown.
   * This is the model's reading channel — articles, docs, search results —
   * with offset/maxChars pagination for long pages.
   */
  async readPage(options: {
    selector?: string;
    offset?: number;
    maxChars?: number;
  }): Promise<ReadResult> {
    const maxChars = clampNumber(Number(options.maxChars), 500, 30_000, 6_000);
    const offset = Math.max(0, Number(options.offset) || 0);
    const result = await this.callPageTools<ReadResult>(
      `readPage(${JSON.stringify(options.selector ?? null)}, ${offset}, ${maxChars})`,
      { timeoutMs: 25_000 },
    );
    if (result?.url) this.lastKnownUrl = result.url;
    return result ?? { success: false, error: "Read produced no result." };
  }

  /**
   * Sets local files on a file input resolved from @ref (the input itself, its
   * label, a descendant, or one in the same form). Files must exist locally.
   */
  async upload(
    ref: number,
    files: string[],
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const resolved = files.map((f) => resolvePath(f));
    const missing = resolved.filter((f) => !existsSync(f));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: "no_match",
        error: `File(s) not found on disk: ${missing.join(", ")}`,
        warnings: [],
      };
    }
    const gate = await this.callPageTools<PageActionResult>(
      `resolveFileInput(${Number(ref)})`,
    );
    if (!gate.success) {
      return this.pageActionFailureOutcome(
        gate,
        "Could not resolve a file input.",
        signal,
      );
    }
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    await client.send("DOM.enable", {}, sessionId).catch(() => undefined);
    const evaluated = await client.send<{
      result?: { objectId?: string };
    }>(
      "Runtime.evaluate",
      { expression: "window.__tauUploadInput", returnByValue: false },
      sessionId,
    );
    const objectId = evaluated.result?.objectId;
    if (!objectId) {
      return this.pageActionFailureOutcome(
        {
          success: false,
          reason: "stale_ref",
          staleKind: "detached",
          error: "The file input vanished before files could be set.",
        },
        "The file input vanished before files could be set.",
        signal,
      );
    }
    await client.send(
      "DOM.setFileInputFiles",
      { files: resolved, objectId },
      sessionId,
    );
    await this.evaluate("delete window.__tauUploadInput").catch(
      () => undefined,
    );
    await this.waitForSettle(signal, { maxMs: 2500 });
    const { observation, warnings } = await this.observe(signal);
    return {
      ok: true,
      detail: { files: resolved, ...gate.info },
      observation,
      warnings,
    };
  }

  /**
   * Drags @fromRef onto @toRef: real mouse drag first; when the page visibly
   * does not change, replays it as an HTML5 DnD event sequence, which is what
   * kanban/list libraries actually listen to.
   */
  async drag(
    fromRef: number,
    toRef: number,
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const warnings: string[] = [];
    const source = await this.callPageTools<ClickPrepareResult>(
      `prepareRef(${Number(fromRef)})`,
    );
    if (!source.success) {
      const failed = await this.pageActionFailureOutcome(
        source,
        "Bad drag source.",
        signal,
      );
      failed.warnings.unshift(...warnings);
      return failed;
    }
    // Target rect WITHOUT scrolling: scrolling the target into view now would
    // move the just-centered source. Off-viewport targets get clamped toward
    // the edge (many UIs auto-scroll during an edge-ward drag).
    const to = await this.callPageTools<PageActionResult>(
      `rectOfRefNoScroll(${Number(toRef)})`,
    );
    if (!to.success) {
      const failed = await this.pageActionFailureOutcome(
        to,
        "Bad drag target.",
        signal,
      );
      failed.warnings.unshift(...warnings);
      return failed;
    }
    const viewport = await this.evaluate<{ w: number; h: number }>(
      "({ w: innerWidth, h: innerHeight })",
    ).catch(() => null);
    const info = to.info as { x: number; y: number; w: number; h: number };
    let tx = Math.round(info.x + info.w / 2);
    let ty = Math.round(info.y + info.h / 2);
    if (viewport) {
      const cx = Math.min(Math.max(tx, 8), viewport.w - 8);
      const cy = Math.min(Math.max(ty, 8), viewport.h - 8);
      if (cx !== tx || cy !== ty) {
        warnings.push(
          "The drag target is partly off-screen; dragged toward its direction (clamped to the viewport edge). If the drop missed, scroll so both elements are visible and retry.",
        );
        tx = cx;
        ty = cy;
      }
    }
    const before = await this.pageFingerprint();
    await this.realDrag(source.x!, source.y!, tx, ty, signal);
    await this.waitForSettle(signal, { maxMs: 2500 });
    const after = await this.pageFingerprint();
    let method = "mouse";
    if (
      before &&
      after &&
      before.url === after.url &&
      before.elementCount === after.elementCount
    ) {
      const synthetic = await this.callPageTools<PageActionResult>(
        `syntheticDrag(${Number(fromRef)}, ${Number(toRef)})`,
      ).catch(() => null);
      if (synthetic?.success) {
        method = "html5-synthetic";
        warnings.push(
          "The mouse drag had no visible effect, so an HTML5 drag-and-drop event sequence was dispatched as fallback. Verify the result in the observation.",
        );
        await this.waitForSettle(signal, { maxMs: 2000 });
      }
    }
    const { observation, warnings: observeWarnings } =
      await this.observe(signal);
    warnings.push(...observeWarnings);
    return {
      ok: true,
      detail: { dragged: source.label || source.tag || "element", method },
      observation,
      warnings,
    };
  }

  /**
   * Runs JavaScript in the page and returns its JSON-serialized value — the
   * escape hatch for data extraction and anything without a dedicated action.
   * Statement bodies get an async-IIFE retry so both styles work.
   */
  async evalJs(js: string): Promise<{
    ok: boolean;
    value?: string;
    error?: string;
  }> {
    const cap = clampNumber(
      Number(process.env.TAU_BROWSER_EVAL_MAX_CHARS),
      500,
      50_000,
      5_000,
    );
    const serialize = (value: unknown): string => {
      if (value === undefined) return "undefined";
      const s = safeJson(value, cap);
      return s;
    };
    try {
      const value = await this.evaluate<unknown>(js, {
        awaitPromise: true,
        timeoutMs: 20_000,
      });
      return { ok: true, value: serialize(value) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/SyntaxError|Illegal return|Unexpected token/i.test(message)) {
        try {
          const value = await this.evaluate<unknown>(
            `(async () => { ${js} })()`,
            { awaitPromise: true, timeoutMs: 20_000 },
          );
          return { ok: true, value: serialize(value) };
        } catch (retryError) {
          const retryMessage =
            retryError instanceof Error
              ? retryError.message
              : String(retryError);
          return { ok: false, error: retryMessage };
        }
      }
      return { ok: false, error: message };
    }
  }

  /** Console messages + uncaught exceptions captured for the active tab. */
  consoleLogs(options: {
    level?: string;
    filter?: string;
    limit?: number;
    clear?: boolean;
  }): { text: string; captured: number } {
    const targetId = this.activeTargetId;
    const entries = (targetId && this.consoleBuf.get(targetId)) || [];
    const text = formatConsoleEntries(entries, options);
    const captured = entries.length;
    if (options.clear && targetId) this.consoleBuf.set(targetId, []);
    return {
      text:
        text ||
        "(no console messages captured on this tab since it was attached)",
      captured,
    };
  }

  /** Network requests captured for the active tab. */
  networkLog(options: {
    filter?: string;
    failedOnly?: boolean;
    limit?: number;
    clear?: boolean;
  }): { text: string; captured: number } {
    const targetId = this.activeTargetId;
    const entries = (targetId && this.networkBuf.get(targetId)) || [];
    const text = formatNetworkEntries(entries, options);
    const captured = entries.length;
    if (options.clear && targetId) {
      this.networkBuf.set(targetId, []);
      this.networkIndex.set(targetId, new Map());
    }
    return {
      text:
        text ||
        (options.failedOnly
          ? "(no failed requests captured on this tab)"
          : "(no requests captured on this tab since it was attached)"),
      captured,
    };
  }

  /** Prints the current page to a PDF file at the given local path. */
  async pdf(path: string): Promise<{ savedPath: string; bytes: number }> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const target = resolvePath(/\.pdf$/i.test(path) ? path : `${path}.pdf`);
    const { data } = await client.send<{ data: string }>(
      "Page.printToPDF",
      { printBackground: true, preferCSSPageSize: true },
      sessionId,
      60_000,
    );
    const buffer = Buffer.from(data, "base64");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buffer);
    return { savedPath: target, bytes: buffer.length };
  }

  /**
   * Emulates a viewport size (responsive/device testing). width=0 height=0
   * clears the override back to the real window size.
   */
  async resize(
    width: number,
    height: number,
    options: { mobile?: boolean; scale?: number },
    signal?: AbortSignal,
  ): Promise<BrowserActionOutcome> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    if (width === 0 && height === 0) {
      await client.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
      await client
        .send(
          "Emulation.setTouchEmulationEnabled",
          { enabled: false },
          sessionId,
        )
        .catch(() => undefined);
    } else {
      const w = Math.round(clampNumber(width, 240, 4000, 1280));
      const h = Math.round(clampNumber(height, 240, 4000, 900));
      const mobile = !!options.mobile;
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: w,
          height: h,
          deviceScaleFactor: clampNumber(
            Number(options.scale),
            1,
            3,
            mobile ? 2 : 1,
          ),
          mobile,
        },
        sessionId,
      );
      await client
        .send(
          "Emulation.setTouchEmulationEnabled",
          { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 },
          sessionId,
        )
        .catch(() => undefined);
    }
    await this.waitForSettle(signal, { maxMs: 1500 });
    const { observation, warnings } = await this.observe(signal);
    return {
      ok: true,
      detail:
        width === 0 && height === 0
          ? { reset: true }
          : { width, height, mobile: !!options.mobile },
      observation,
      warnings,
    };
  }

  async goForward(signal?: AbortSignal): Promise<void> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const history = await client.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>("Page.getNavigationHistory", {}, sessionId);
    if (history.currentIndex >= history.entries.length - 1) {
      throw new Error("No later page in this tab’s history.");
    }
    const entry = history.entries[history.currentIndex + 1]!;
    await client.send(
      "Page.navigateToHistoryEntry",
      { entryId: entry.id },
      sessionId,
    );
    await this.waitForSettle(signal);
  }

  /** Reloads the current page; hard=true bypasses the cache (dev loop). */
  async reload(hard: boolean, signal?: AbortSignal): Promise<void> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const loadFired = client.waitForEvent(
      "Page.loadEventFired",
      sessionId,
      15_000,
    );
    await client.send("Page.reload", { ignoreCache: hard }, sessionId);
    await loadFired;
    await this.waitForSettle(signal);
  }

  /**
   * Captures the viewport as a downscaled JPEG. Screenshots are the single
   * heaviest item a browsing session puts in context, and the coordinate-guard
   * actively pushes the model toward taking more of them, so we shrink each one:
   * a sub-1 clip scale plus modest quality cuts the image roughly in half with
   * no loss of the layout information the model actually needs. Both are
   * env-tunable (TAU_BROWSER_SCREENSHOT_SCALE, TAU_BROWSER_SCREENSHOT_QUALITY).
   */
  async screenshot(options?: {
    full?: boolean;
    ref?: number;
    path?: string;
    annotate?: boolean;
  }): Promise<{
    base64?: string;
    mediaType: "image/jpeg" | "image/png";
    savedPath?: string;
    note?: string;
  }> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const scale = clampNumber(
      Number(process.env.TAU_BROWSER_SCREENSHOT_SCALE),
      0.4,
      1,
      0.66,
    );
    const quality = Math.round(
      clampNumber(
        Number(process.env.TAU_BROWSER_SCREENSHOT_QUALITY),
        20,
        90,
        45,
      ),
    );
    const toFile = options?.path
      ? resolvePath(
          /\.(png|jpe?g)$/i.test(options.path)
            ? options.path
            : `${options.path}.png`,
        )
      : undefined;
    const asPng = !!toFile && /\.png$/i.test(toFile);
    const params: Record<string, unknown> = asPng
      ? { format: "png" }
      : { format: "jpeg", quality: toFile ? 80 : quality };
    let note: string | undefined;
    let annotated = false;

    if (options?.annotate) {
      const result = await this.callPageTools<PageActionResult>(
        "annotate()",
      ).catch(() => null);
      if (result?.success) {
        annotated = true;
        note = `Annotated ${(result.info as { labeled?: number })?.labeled ?? ""} elements with their @ref badges.`;
      } else {
        note =
          result?.error ??
          "Could not annotate (observe first); captured plain.";
      }
    }
    try {
      if (options?.ref !== undefined) {
        const rect = await this.callPageTools<PageActionResult>(
          `rectOfRef(${Number(options.ref)})`,
        );
        if (!rect.success) {
          throw new Error(
            rect.error ?? `Cannot resolve @${options.ref} for the screenshot.`,
          );
        }
        const r = rect.info as { x: number; y: number; w: number; h: number };
        params.clip = {
          x: r.x,
          y: r.y,
          width: Math.max(r.w, 8),
          height: Math.max(r.h, 8),
          scale: 1,
        };
      } else if (options?.full) {
        const metrics = await client
          .send<{
            contentSize?: { width: number; height: number };
          }>("Page.getLayoutMetrics", {}, sessionId)
          .catch(() => undefined);
        const content = metrics?.contentSize;
        if (content && content.width > 0 && content.height > 0) {
          const height = Math.min(content.height, 8000);
          if (content.height > height) {
            note = [
              note,
              `Page is ${Math.round(content.height)}px tall; captured the first ${height}px.`,
            ]
              .filter(Boolean)
              .join(" ");
          }
          params.captureBeyondViewport = true;
          params.clip = { x: 0, y: 0, width: content.width, height, scale };
        }
      } else {
        const metrics = await client
          .send<{
            cssLayoutViewport?: { clientWidth: number; clientHeight: number };
            layoutViewport?: { clientWidth: number; clientHeight: number };
          }>("Page.getLayoutMetrics", {}, sessionId)
          .catch(() => undefined);
        const vp = metrics?.cssLayoutViewport ?? metrics?.layoutViewport;
        if (scale < 0.999 && vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
          params.clip = {
            x: 0,
            y: 0,
            width: vp.clientWidth,
            height: vp.clientHeight,
            scale,
          };
        }
      }
      const { data } = await client.send<{ data: string }>(
        "Page.captureScreenshot",
        params,
        sessionId,
        30_000,
      );
      const mediaType = asPng ? "image/png" : "image/jpeg";
      if (toFile) {
        const buffer = Buffer.from(data, "base64");
        mkdirSync(dirname(toFile), { recursive: true });
        writeFileSync(toFile, buffer);
        return { mediaType, savedPath: toFile, note };
      }
      return { base64: data, mediaType, note };
    } finally {
      if (annotated) {
        await this.callPageTools("clearAnnotations()").catch(() => undefined);
      }
    }
  }

  async closeBrowser(): Promise<void> {
    const client = this.client;
    if (client?.isOpen) {
      if (this.mode === "spawned") {
        await client.send("Browser.close", {}, undefined, 5_000).catch(() => {
          this.child?.kill();
        });
      }
      client.close();
    }
    if (this.mode === "spawned") {
      const child = this.child;
      if (child && child.exitCode === null) {
        setTimeout(() => {
          if (child.exitCode === null) child.kill();
        }, 3_000).unref();
      }
    }
    this.resetState();
  }

  /**
   * Waits for the DOM to stop growing instead of sleeping a fixed time
   * (ported from Bah): returns as soon as the element count is stable for
   * `quietMs` with readyState complete, capped at `maxMs`. Each probe is
   * raced against 1.5s so a page with a wedged main thread cannot hang us.
   */
  private async waitForSettle(
    signal?: AbortSignal,
    options?: { maxMs?: number; quietMs?: number },
  ): Promise<void> {
    const maxMs = options?.maxMs ?? 4000;
    const quietMs = options?.quietMs ?? 350;
    const start = Date.now();
    const targetId = this.activeTargetId;
    let lastCount = -1;
    let stableSince = 0;
    while (Date.now() - start < maxMs) {
      if (signal?.aborted) return;
      const snap = await Promise.race([
        this.evaluate<{ rs: string; n: number }>(
          `({ rs: document.readyState, n: document.getElementsByTagName('*').length })`,
        ).catch(() => null),
        sleep(1500).then(() => null),
      ]);
      if (!snap) return;
      if (snap.n === lastCount) {
        if (!stableSince) stableSince = Date.now();
        if (snap.rs === "complete" && Date.now() - stableSince >= quietMs) {
          // DOM is quiet; give straggling XHRs a bounded grace so results
          // that are one response away make it in. Long-pollers can hold a
          // request open forever, hence the small cap, not a hard wait.
          const pending = targetId
            ? (this.inflight.get(targetId)?.size ?? 0)
            : 0;
          if (pending === 0 || Date.now() - start >= Math.min(2500, maxMs)) {
            return;
          }
        }
      } else {
        lastCount = snap.n;
        stableSince = 0;
      }
      await sleep(120, signal).catch(() => undefined);
    }
  }

  /**
   * Trusted click through CDP input dispatch: short eased mouse path with
   * jitter, then press/release. Sites see the same event stream a human
   * produces (isTrusted true), so React/Vue/anti-bot handlers respond.
   */
  /** Eased, jittered mouse move to (x, y); ends with the cursor on the point. */
  private async moveMouse(
    x: number,
    y: number,
    signal?: AbortSignal,
    buttons = 0,
  ): Promise<{ tx: number; ty: number }> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const tx = Math.round(x + rnd(-2, 2));
    const ty = Math.round(y + rnd(-2, 2));
    const sx = Math.max(0, Math.round(tx - rnd(40, 90)));
    const sy = Math.max(0, Math.round(ty - rnd(25, 60)));
    const steps = 4 + Math.floor(rnd(0, 3));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t * t * (3 - 2 * t);
      await client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: Math.round(sx + (tx - sx) * e),
          y: Math.round(sy + (ty - sy) * e),
          buttons,
        },
        sessionId,
      );
      await sleep(rnd(8, 22), signal);
    }
    return { tx, ty };
  }

  private async realClick(
    x: number,
    y: number,
    signal?: AbortSignal,
    clickCount = 1,
  ): Promise<void> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const { tx, ty } = await this.moveMouse(x, y, signal);
    for (let c = 1; c <= clickCount; c++) {
      await client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: tx,
          y: ty,
          button: "left",
          clickCount: c,
          buttons: 1,
        },
        sessionId,
      );
      await sleep(rnd(60, 130), signal);
      await client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          x: tx,
          y: ty,
          button: "left",
          clickCount: c,
          buttons: 0,
        },
        sessionId,
      );
      if (c < clickCount) await sleep(rnd(40, 90), signal);
    }
  }

  /**
   * Real mouse drag: press on the source, eased path to the target (with the
   * button held), settle, release. Sliders, canvases, and reorder handles
   * respond to this; HTML5 DnD libraries get the synthetic fallback instead.
   */
  private async realDrag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const from = await this.moveMouse(x1, y1, signal);
    await client.send(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: from.tx,
        y: from.ty,
        button: "left",
        clickCount: 1,
        buttons: 1,
      },
      sessionId,
    );
    await sleep(rnd(80, 150), signal);
    const steps = 8 + Math.floor(rnd(0, 4));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t * t * (3 - 2 * t);
      await client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: Math.round(from.tx + (x2 - from.tx) * e),
          y: Math.round(from.ty + (y2 - from.ty) * e),
          buttons: 1,
        },
        sessionId,
      );
      await sleep(rnd(12, 28), signal);
    }
    await sleep(rnd(80, 160), signal);
    await client.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: Math.round(x2),
        y: Math.round(y2),
        button: "left",
        clickCount: 1,
        buttons: 0,
      },
      sessionId,
    );
  }

  private async dispatchKey(normalizedKey: string): Promise<void> {
    const entry = KEY_MAP[normalizedKey]!;
    await this.dispatchParsedKey({ entry, modifiers: 0 });
  }

  private async dispatchParsedKey(parsed: ParsedChord): Promise<void> {
    const { entry, modifiers, commands } = parsed;
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const base = {
      key: entry.key,
      code: entry.code,
      windowsVirtualKeyCode: entry.vk,
      nativeVirtualKeyCode: entry.vk,
      ...(modifiers ? { modifiers } : {}),
    };
    const withText = !!entry.text && !(modifiers & ~8);
    await client.send(
      "Input.dispatchKeyEvent",
      {
        type: withText ? "keyDown" : "rawKeyDown",
        ...base,
        ...(withText ? { text: entry.text } : {}),
        ...(commands?.length ? { commands } : {}),
      },
      sessionId,
    );
    await client.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...base },
      sessionId,
    );
  }

  private async pageFingerprint(): Promise<{
    url: string;
    elementCount: number;
  } | null> {
    return this.evaluate<{ url: string; elementCount: number }>(
      `({ url: location.href, elementCount: document.getElementsByTagName('*').length })`,
    ).catch(() => null);
  }

  private async callPageTools<T>(
    invocation: string,
    options?: { awaitPromise?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const pageConfig = JSON.stringify({ sessionKey: this.refRegistryKey });
    return this.evaluate<T>(
      "window.__tauPageConfig = " +
        pageConfig +
        ";\n" +
        PAGE_TOOLS_SCRIPT +
        "\n window.__tauPageTools." +
        invocation,
      options,
    );
  }

  private async evaluate<T>(
    expression: string,
    options?: { awaitPromise?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const client = this.requireClient();
    const sessionId = await this.getActiveSession();
    const evaluated = await client.send<EvaluateResult>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: options?.awaitPromise ?? false,
        userGesture: true,
      },
      sessionId,
      options?.timeoutMs ?? 30_000,
    );
    if (evaluated.exceptionDetails) {
      const description =
        evaluated.exceptionDetails.exception?.description ??
        evaluated.exceptionDetails.text ??
        "Page script failed";
      throw new Error(description.split("\n")[0]);
    }
    return evaluated.result?.value as T;
  }

  private requireClient(): CdpClient {
    if (!this.client?.isOpen) {
      throw new Error(
        "The browser is not running. Use the open action to start it.",
      );
    }
    return this.client;
  }

  private async ensureActiveTarget(): Promise<void> {
    const client = this.requireClient();
    const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    const pages = targetInfos
      .filter(isRegularPage)
      .sort((a, b) => a.targetId.localeCompare(b.targetId));
    const current = pages.find((p) => p.targetId === this.activeTargetId);
    if (current) return;
    if (pages.length > 0) {
      this.activeTargetId = pages[0]!.targetId;
    } else {
      const { targetId } = await client.send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );
      this.activeTargetId = targetId;
    }
    await this.getActiveSession();
  }

  private async getActiveSession(): Promise<string> {
    if (!this.activeTargetId) {
      await this.ensureActiveTarget();
    }
    const targetId = this.activeTargetId!;
    const sessionId = await this.ensureTargetSession(targetId);
    await this.prepareTargetForAutomation(targetId, sessionId);
    return sessionId;
  }

  /**
   * Attaches to a page once and installs only the lightweight activity tracker.
   * Background tabs stay free of console/network capture until the user or the
   * tool actually makes one active.
   */
  private async ensureTargetSession(targetId: string): Promise<string> {
    const client = this.requireClient();
    const cached = this.sessions.get(targetId);
    if (cached) return cached;
    const pending = this.sessionPromises.get(targetId);
    if (pending) return pending;

    const attachment = (async () => {
      const { sessionId } = await client.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      this.sessions.set(targetId, sessionId);
      this.sessionToTarget.set(sessionId, targetId);
      await client.send("Page.enable", {}, sessionId).catch(() => undefined);
      await client.send("Runtime.enable", {}, sessionId).catch(() => undefined);
      await this.installTabActivityTracker(targetId, sessionId);
      return sessionId;
    })();
    this.sessionPromises.set(targetId, attachment);
    try {
      return await attachment;
    } finally {
      if (this.sessionPromises.get(targetId) === attachment) {
        this.sessionPromises.delete(targetId);
      }
    }
  }

  private async prepareTargetForAutomation(
    targetId: string,
    sessionId: string,
  ): Promise<void> {
    if (this.fullyPreparedTargets.has(targetId)) return;
    this.fullyPreparedTargets.add(targetId);
    const client = this.requireClient();
    // Console/network capture and dialog interception ride on these domains;
    // failures are tolerated (an exotic target without them still browses).
    await client.send("Log.enable", {}, sessionId).catch(() => undefined);
    await client
      .send(
        "Network.enable",
        { maxTotalBufferSize: 5_000_000, maxResourceBufferSize: 1_000_000 },
        sessionId,
      )
      .catch(() => undefined);
    await this.installStealth(targetId, sessionId);
  }

  private async installTabActivityTracker(
    targetId: string,
    sessionId: string,
  ): Promise<void> {
    if (this.activityTargets.has(targetId)) return;
    this.activityTargets.add(targetId);
    const client = this.client;
    if (!client) return;
    const source = buildTabActivityScript(this.activityBindingName);
    await client
      .send("Runtime.addBinding", { name: this.activityBindingName }, sessionId)
      .catch(() => undefined);
    await client
      .send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId)
      .catch(() => undefined);
    // The new-document hook covers future navigations; this covers the page
    // already loaded when Tau attaches to an existing browser.
    await client
      .send(
        "Runtime.evaluate",
        { expression: source, returnByValue: true },
        sessionId,
      )
      .catch(() => undefined);
  }

  /** Discover existing/future pages, attach the tracker once, then align with the focused tab. */
  private async startTabActivityTracking(): Promise<void> {
    const client = this.requireClient();
    await client
      .send("Target.setDiscoverTargets", { discover: true })
      .catch(() => undefined);
    const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    await Promise.allSettled(
      targetInfos
        .filter(isRegularPage)
        .map((target) => this.ensureTargetSession(target.targetId)),
    );
    await this.syncFocusedTab(false);
  }

  private async probeTabFocus(
    sessionId: string,
  ): Promise<TabActivityProbe | null> {
    const client = this.client;
    if (!client?.isOpen) return null;
    const evaluated = await client
      .send<EvaluateResult>(
        "Runtime.evaluate",
        {
          expression:
            `({ focused: document.hasFocus(), ` +
            `visible: document.visibilityState === "visible", ` +
            `url: location.href, title: document.title })`,
          returnByValue: true,
        },
        sessionId,
        2_000,
      )
      .catch(() => null);
    const value = evaluated?.result?.value;
    if (!value || typeof value !== "object") return null;
    const probe = value as Partial<TabActivityProbe>;
    return {
      focused: probe.focused === true,
      visible: probe.visible === true,
      ...(typeof probe.url === "string" ? { url: probe.url } : {}),
      ...(typeof probe.title === "string" ? { title: probe.title } : {}),
    };
  }

  private adoptActiveTarget(
    targetId: string,
    probe: TabActivityProbe,
    announce: boolean,
  ): void {
    if (targetId === this.activeTargetId) return;
    this.activeTargetId = targetId;
    this.lastKnownUrl = probe.url ?? this.lastKnownUrl;
    this.coordClicks = [];
    if (announce) {
      const label = probe.title?.trim() || probe.url || "another browser tab";
      this.sessionNotes.push(
        `Browser focus moved to ${label}; Browser followed the active tab.`,
      );
    }
  }

  private async syncFocusedTab(announce: boolean): Promise<void> {
    const entries = [...this.sessions.entries()];
    const probes = await Promise.all(
      entries.map(async ([targetId, sessionId]) => ({
        targetId,
        probe: await this.probeTabFocus(sessionId),
      })),
    );
    const focused = probes.find(
      ({ targetId, probe }) =>
        shouldAdoptTabActivity(this.activeTargetId, targetId, probe),
    );
    if (focused?.probe) {
      this.adoptActiveTarget(focused.targetId, focused.probe, announce);
    }
  }

  private async handleTabActivityBinding(
    params: { name?: string },
    sessionId?: string,
  ): Promise<void> {
    if (params.name !== this.activityBindingName || !sessionId) return;
    const targetId = this.sessionToTarget.get(sessionId);
    if (!targetId || targetId === this.activeTargetId) return;
    const probe = await this.probeTabFocus(sessionId);
    if (!shouldAdoptTabActivity(this.activeTargetId, targetId, probe) || !probe) {
      return;
    }
    this.adoptActiveTarget(targetId, probe, true);
  }

  /**
   * Registers the anti-detection script to run before page JS on every future
   * navigation of this target, overrides the User-Agent (dropping any Headless
   * marker) with a matching Accept-Language, and runs the script once against
   * the current document. Best-effort: a failure here must never block a
   * legitimate action, so every call swallows its error. Runs once per target.
   */
  private async installStealth(
    targetId: string,
    sessionId: string,
  ): Promise<void> {
    if (this.stealthTargets.has(targetId)) return;
    this.stealthTargets.add(targetId);
    const client = this.client;
    if (!client) return;
    if (this.stealthScript) {
      await client
        .send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: this.stealthScript },
          sessionId,
        )
        .catch(() => undefined);
    }
    if (this.cachedUserAgent) {
      await client
        .send(
          "Emulation.setUserAgentOverride",
          {
            userAgent: this.cachedUserAgent,
            acceptLanguage: "en-US,en;q=0.9",
            platform: "Win32",
          },
          sessionId,
        )
        .catch(() => undefined);
    }
    // Cover an already-loaded document (e.g. attach-to-existing-tab); the
    // registered script only fires on the next navigation.
    if (this.stealthScript) {
      await client
        .send(
          "Runtime.evaluate",
          { expression: this.stealthScript, returnByValue: true },
          sessionId,
        )
        .catch(() => undefined);
    }
  }

  /**
   * Reads the browser's real User-Agent and Chrome major version once at
   * startup, so the injected stealth script's spoofed userAgentData brands
   * stay consistent with the UA header. Defaults are used if the probe fails.
   */
  private async prepareStealth(): Promise<void> {
    this.stealthTargets.clear();
    let chromeMajor = 131;
    try {
      const client = this.requireClient();
      const version = await client.send<{
        product?: string;
        userAgent?: string;
      }>("Browser.getVersion");
      const rawUa = version.userAgent || "";
      const cleanUa = rawUa.replace(/HeadlessChrome/g, "Chrome");
      const match = (version.product || rawUa).match(/Chrome\/(\d+)/);
      if (match) chromeMajor = Number(match[1]);
      this.cachedUserAgent = cleanUa || undefined;
    } catch {
      this.cachedUserAgent = undefined;
    }
    this.stealthScript = buildStealthScript(chromeMajor);
  }

  private installClientHooks(): void {
    const client = this.client;
    if (!client) return;
    client.on(
      "Target.targetCreated",
      (params: { targetInfo?: TargetInfo }) => {
        const target = params.targetInfo;
        if (!target || !isRegularPage(target)) return;
        // Event listeners are synchronous in the minimal CDP client; attachment
        // is best-effort and coalesced with any simultaneous explicit switch.
        void this.ensureTargetSession(target.targetId).catch(() => undefined);
      },
    );
    client.on("Target.detachedFromTarget", (params: { sessionId?: string }) => {
      for (const [targetId, sessionId] of this.sessions) {
        if (sessionId === params.sessionId) {
          this.sessions.delete(targetId);
          this.sessionToTarget.delete(sessionId);
          this.sessionPromises.delete(targetId);
          this.fullyPreparedTargets.delete(targetId);
          this.activityTargets.delete(targetId);
        }
      }
    });
    client.onClose(() => {
      if (this.client === client) this.resetState();
    });

    const targetOf = (sessionId?: string): string | undefined =>
      sessionId ? this.sessionToTarget.get(sessionId) : undefined;
    client.on(
      "Runtime.bindingCalled",
      (params: { name?: string }, sessionId?: string) => {
        void this.handleTabActivityBinding(params, sessionId).catch(
          () => undefined,
        );
      },
    );
    const pushConsole = (targetId: string, entry: ConsoleEntry) => {
      let buf = this.consoleBuf.get(targetId);
      if (!buf) {
        buf = [];
        this.consoleBuf.set(targetId, buf);
      }
      buf.push(entry);
      if (buf.length > EVENT_BUFFER_CAP)
        buf.splice(0, buf.length - EVENT_BUFFER_CAP);
    };

    client.on(
      "Runtime.consoleAPICalled",
      (
        params: {
          type?: string;
          args?: Array<{
            type?: string;
            value?: unknown;
            description?: string;
          }>;
        },
        sessionId?: string,
      ) => {
        const targetId = targetOf(sessionId);
        if (!targetId) return;
        const text = (params.args ?? [])
          .map((a) => {
            if (a.value !== undefined) {
              return typeof a.value === "string" ? a.value : safeJson(a.value);
            }
            return (a.description ?? a.type ?? "").split("\n")[0] ?? "";
          })
          .join(" ")
          .slice(0, 500);
        pushConsole(targetId, {
          ts: Date.now(),
          level: params.type === "warning" ? "warning" : (params.type ?? "log"),
          text,
        });
      },
    );
    client.on(
      "Runtime.exceptionThrown",
      (
        params: {
          exceptionDetails?: {
            text?: string;
            url?: string;
            lineNumber?: number;
            exception?: { description?: string };
          };
        },
        sessionId?: string,
      ) => {
        const targetId = targetOf(sessionId);
        if (!targetId) return;
        const d = params.exceptionDetails;
        const text = (
          d?.exception?.description ??
          d?.text ??
          "Uncaught exception"
        )
          .split("\n")
          .slice(0, 3)
          .join("\n");
        const where = d?.url
          ? `${d.url.split("/").pop()}:${d.lineNumber ?? "?"}`
          : undefined;
        pushConsole(targetId, {
          ts: Date.now(),
          level: "exception",
          text,
          source: where,
        });
      },
    );
    client.on(
      "Log.entryAdded",
      (
        params: {
          entry?: {
            level?: string;
            text?: string;
            source?: string;
            url?: string;
          };
        },
        sessionId?: string,
      ) => {
        const targetId = targetOf(sessionId);
        if (!targetId || !params.entry) return;
        pushConsole(targetId, {
          ts: Date.now(),
          level: params.entry.level ?? "info",
          text: (params.entry.text ?? "").slice(0, 500),
          source: params.entry.source,
        });
      },
    );

    client.on(
      "Network.requestWillBeSent",
      (
        params: {
          requestId: string;
          type?: string;
          request?: { url?: string; method?: string };
        },
        sessionId?: string,
      ) => {
        const targetId = targetOf(sessionId);
        if (!targetId) return;
        const url = params.request?.url ?? "";
        if (url.startsWith("data:")) return;
        const entry: NetworkEntry = {
          ts: Date.now(),
          requestId: params.requestId,
          method: params.request?.method ?? "GET",
          url,
          type: params.type,
        };
        let buf = this.networkBuf.get(targetId);
        let index = this.networkIndex.get(targetId);
        if (!buf || !index) {
          buf = [];
          index = new Map();
          this.networkBuf.set(targetId, buf);
          this.networkIndex.set(targetId, index);
        }
        buf.push(entry);
        index.set(params.requestId, entry);
        if (buf.length > EVENT_BUFFER_CAP) {
          for (const dropped of buf.splice(0, buf.length - EVENT_BUFFER_CAP)) {
            index.delete(dropped.requestId);
          }
        }
        let pending = this.inflight.get(targetId);
        if (!pending) {
          pending = new Set();
          this.inflight.set(targetId, pending);
        }
        pending.add(params.requestId);
      },
    );
    client.on(
      "Network.responseReceived",
      (
        params: {
          requestId: string;
          response?: { status?: number; mimeType?: string };
        },
        sessionId?: string,
      ) => {
        const targetId = targetOf(sessionId);
        if (!targetId) return;
        const entry = this.networkIndex.get(targetId)?.get(params.requestId);
        if (entry) {
          entry.status = params.response?.status;
          entry.mime = params.response?.mimeType;
        }
      },
    );
    const settleRequest = (
      params: { requestId: string; errorText?: string; canceled?: boolean },
      sessionId?: string,
    ) => {
      const targetId = targetOf(sessionId);
      if (!targetId) return;
      this.inflight.get(targetId)?.delete(params.requestId);
      const entry = this.networkIndex.get(targetId)?.get(params.requestId);
      if (entry) {
        entry.finished = true;
        if (params.errorText && !params.canceled)
          entry.error = params.errorText;
      }
    };
    client.on("Network.loadingFinished", settleRequest);
    client.on("Network.loadingFailed", settleRequest);

    // JS dialogs (alert/confirm/prompt/beforeunload) block every evaluate on
    // the page, which would wedge the whole loop. Handle them like a user who
    // clicks OK, and tell the model what happened in the next warnings.
    client.on(
      "Page.javascriptDialogOpening",
      (
        params: { type?: string; message?: string; defaultPrompt?: string },
        sessionId?: string,
      ) => {
        const accept = !isEnvTruthy(process.env.TAU_BROWSER_DISMISS_DIALOGS);
        client
          .send(
            "Page.handleJavaScriptDialog",
            {
              accept,
              ...(params.type === "prompt"
                ? { promptText: params.defaultPrompt ?? "" }
                : {}),
            },
            sessionId,
            5_000,
          )
          .catch(() => undefined);
        const msg = (params.message ?? "").slice(0, 200);
        this.sessionNotes.push(
          `A JavaScript ${params.type ?? "dialog"} appeared${msg ? `: "${msg}"` : ""} — auto-${accept ? "accepted (OK)" : "dismissed (Cancel)"}.`,
        );
      },
    );

    client.on(
      "Browser.downloadWillBegin",
      (params: { guid?: string; suggestedFilename?: string }) => {
        if (params.guid) {
          this.downloadNames.set(
            params.guid,
            params.suggestedFilename ?? "download",
          );
        }
      },
    );
    client.on(
      "Browser.downloadProgress",
      (params: { guid?: string; state?: string }) => {
        if (!params.guid || params.state === "inProgress") return;
        const name = this.downloadNames.get(params.guid);
        if (name === undefined) return;
        this.downloadNames.delete(params.guid);
        if (params.state === "completed") {
          const where = this.downloadDir
            ? ` → ${resolvePath(this.downloadDir, name)}`
            : " (in the browser download folder)";
          this.sessionNotes.push(`Download finished: ${name}${where}`);
        } else {
          this.sessionNotes.push(`Download of ${name} was canceled or failed.`);
        }
      },
    );
  }

  /** Returns and clears pending browser-session notes for outcome warnings. */
  drainSessionNotes(): string[] {
    if (this.sessionNotes.length === 0) return [];
    const notes = this.sessionNotes.slice(-8);
    this.sessionNotes = [];
    return notes;
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.once("exit", () => {
      if (
        this.mode === "spawned" &&
        this.child &&
        this.child.exitCode === null &&
        !isEnvTruthy(process.env.TAU_BROWSER_KEEP_OPEN)
      ) {
        try {
          this.child.kill();
        } catch {
          // Best-effort cleanup.
        }
      }
    });
  }

  private resetState(): void {
    this.client = undefined;
    this.child = undefined;
    this.sessions.clear();
    this.sessionPromises.clear();
    this.sessionToTarget.clear();
    this.fullyPreparedTargets.clear();
    this.activityTargets.clear();
    this.activityBindingName = createTabActivityBindingName();
    this.activeTargetId = undefined;
    this.cachedElements.clear();
    this.cachedElementsTargetId = undefined;
    // A reconnect to an existing Chrome page must reject any registry injected
    // by an earlier BrowserSession. The global id allocator intentionally does
    // not rewind, so old numeric refs cannot be recycled within this process.
    this.refRegistryKey = createRefRegistryKey();
    this.stealthTargets.clear();
    this.stealthScript = undefined;
    this.cachedUserAgent = undefined;
    this.coordClicks = [];
    this.consoleBuf.clear();
    this.networkBuf.clear();
    this.networkIndex.clear();
    this.inflight.clear();
    this.sessionNotes = [];
    this.downloadDir = undefined;
    this.downloadNames.clear();
  }
}

let singleton: BrowserSessionService | undefined;

export function getBrowserSession(): BrowserSessionService {
  if (!singleton) singleton = new BrowserSessionService();
  return singleton;
}

export type { BrowserSessionService };
