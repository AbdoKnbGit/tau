/**
 * Proof-of-effect receipts.
 *
 * WHY THIS EXISTS: a browser action that does nothing looks exactly like one
 * that worked. An observed failure mode in a competing agent: three page-script
 * cells in a row returned no output, each one indistinguishable from success,
 * so the model concluded the tool was broken and abandoned it — then described
 * a UI it had never rendered. Every action here comes back with evidence that
 * it moved the world, or an explicit statement that it did not.
 *
 * The probe is one `Runtime.evaluate` with no round-trips of its own: document
 * identity, URL, scroll position, and a bounded signature over the interactive
 * DOM. Document identity is a marker minted into the page's JS context, so a
 * navigation (which replaces that context) shows up as a new id for free.
 */

/** One cheap sample of the page, taken before and after an action. */
export interface PageStateSnapshot {
  /** Per-document marker; a fresh JS context (navigation/reload) mints a new one. */
  docId: string;
  url: string;
  title: string;
  /** Count of interactive elements matched by the probe selector. */
  elements: number;
  /** FNV-1a over the first N interactive elements' identity + label + state. */
  sig: string;
  /** Length of body innerText, so a text-only re-render still registers. */
  textLen: number;
  scrollY: number;
  readyState: string;
  /** State of the element the action targeted ("gone" once it left the page). */
  target?: string;
}

/** What changed between two snapshots. */
export interface ActionEffect {
  step: number;
  ms: number;
  url: string;
  urlChanged: boolean;
  docChanged: boolean;
  domChanged: boolean;
  scrolled: boolean;
  elementsBefore?: number;
  elementsAfter?: number;
  /** True only for a mutating action that changed nothing observable. */
  noop: boolean;
  /** Set when the before/after sample could not be taken (browser starting, tab gone). */
  unverified?: string;
}

/**
 * Actions expected to change the page. A no-op verdict on `observe` or
 * `console` would be noise — of course they changed nothing.
 */
const MUTATING_ACTIONS = new Set([
  "navigate",
  "click",
  "fill",
  "type",
  "press",
  "hover",
  "scroll",
  "drag",
  "upload",
  "eval",
  "dismiss",
  "back",
  "forward",
  "reload",
  "get",
  "flow",
]);

export function isMutatingAction(action: string): boolean {
  return MUTATING_ACTIONS.has(action);
}

/**
 * One expression, evaluated in the page, returning a {@link PageStateSnapshot}.
 * Never throws: a page that blocks property access still yields a usable
 * sample, and total failure returns null rather than breaking the action.
 *
 * The signature covers each control's state as well as its text, so ticking a
 * checkbox or pressing a toggle registers as a change. With `targetRef` the
 * sample also carries the state of the element the action is aimed at, which
 * catches a toggle the page-wide signature cannot see (past its cap, or inside
 * a shadow root).
 */
export function buildStateProbeScript(targetRef?: number): string {
  const target = Number.isSafeInteger(targetRef) && Number(targetRef) >= 0 ? Number(targetRef) : -1;
  return `(function(){
  try {
    var d = document;
    if (!window.__tauDocId) {
      window.__tauDocId = 'd' + Math.random().toString(36).slice(2, 10);
    }
    var SEL = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[onclick],[contenteditable=""],[contenteditable="true"]';
    var nodes = [];
    try { nodes = Array.prototype.slice.call(d.querySelectorAll(SEL)); } catch (e) { nodes = []; }
    // Controls and text inside open shadow roots count too.
    var shadowText = 0;
    var scan = function (scope, depth) {
      var all = [];
      try { all = scope.querySelectorAll('*'); } catch (e) { return; }
      for (var a = 0; a < all.length && a < 20000; a++) {
        var root = all[a] && all[a].shadowRoot;
        if (!root) continue;
        try { nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll(SEL))); } catch (e) {}
        try { shadowText += String(root.textContent || '').length; } catch (e) {}
        if (depth < 8) scan(root, depth + 1);
      }
    };
    scan(d, 0);
    var stateOf = function (el) {
      var attr = function (name) {
        try { return el.getAttribute ? (el.getAttribute(name) || '') : ''; } catch (e) { return ''; }
      };
      var open = '';
      try {
        if (String(el.tagName || '').toUpperCase() === 'SUMMARY' && el.parentElement && el.parentElement.open) open = 'o';
      } catch (e) {}
      return (el.checked ? 'c' : '') + attr('aria-checked') + attr('aria-pressed') + attr('aria-expanded') + attr('aria-selected') + open;
    };
    var describe = function (el) {
      return (el.tagName || '') + '|' + (el.id || '') + '|'
        + String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) + '|'
        + (el.disabled ? '1' : '0') + '|'
        + (el.value == null ? '' : String(el.value).slice(0, 20)) + '|'
        + stateOf(el);
    };
    var total = nodes.length;
    var cap = total < 2000 ? total : 2000;
    var h = 2166136261;
    for (var i = 0; i < cap; i++) {
      var part = '';
      try { part = describe(nodes[i]); } catch (e) { part = 'x'; }
      for (var j = 0; j < part.length; j++) {
        h ^= part.charCodeAt(j);
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    var target;
    if (${target} >= 0) {
      try {
        var reg = window.__tauRefState;
        var el = reg && reg.document === d && reg.idToElement && reg.idToElement.get(${target});
        target = el && el.isConnected ? describe(el) : 'gone';
      } catch (e) { target = undefined; }
    }
    var textLen = 0;
    try { textLen = (d.body && d.body.innerText ? d.body.innerText.length : 0); } catch (e) { textLen = 0; }
    return {
      docId: window.__tauDocId,
      url: location.href,
      title: d.title || '',
      elements: total,
      sig: h.toString(36),
      textLen: textLen + shadowText,
      scrollY: Math.round(window.scrollY || 0),
      readyState: d.readyState || '',
      target: target
    };
  } catch (e) {
    return null;
  }
})()`;
}

export const STATE_PROBE_SCRIPT = buildStateProbeScript();

/**
 * Compares two samples. `before` may be null (browser had no page yet), in
 * which case nothing is claimed beyond the after-state.
 */
export function diffEffect(
  action: string,
  before: PageStateSnapshot | null,
  after: PageStateSnapshot | null,
  step: number,
  ms: number,
  options?: { producedValue?: boolean },
): ActionEffect {
  if (!after) {
    return {
      step,
      ms,
      url: before?.url ?? "",
      urlChanged: false,
      docChanged: false,
      domChanged: false,
      scrolled: false,
      noop: false,
      unverified: "the page could not be sampled after this action",
    };
  }
  if (!before) {
    return {
      step,
      ms,
      url: after.url,
      urlChanged: false,
      docChanged: false,
      domChanged: false,
      scrolled: false,
      elementsAfter: after.elements,
      noop: false,
      unverified: "no before-sample (first action on this page)",
    };
  }
  const urlChanged = before.url !== after.url;
  const docChanged = before.docId !== after.docId;
  const domChanged =
    before.sig !== after.sig ||
    before.elements !== after.elements ||
    before.textLen !== after.textLen ||
    (before.target ?? "") !== (after.target ?? "");
  const scrolled = before.scrollY !== after.scrollY;
  // Targeting an element scrolls it into view first, so on any page longer than
  // the viewport a click "scrolls the page" no matter what it does afterwards.
  // Counting that as evidence would hide every no-op on a long page — which is
  // most of them. Only the scroll action itself is judged by scroll position.
  const scrollIsEvidence = action === "scroll";
  const noop =
    isMutatingAction(action) &&
    !urlChanged &&
    !docChanged &&
    !domChanged &&
    !(scrolled && scrollIsEvidence) &&
    !options?.producedValue;
  return {
    step,
    ms,
    url: after.url,
    urlChanged,
    docChanged,
    domChanged,
    scrolled,
    elementsBefore: before.elements,
    elementsAfter: after.elements,
    noop,
  };
}

/** One-line receipt for the model. Deliberately terse and always present. */
export function formatEffect(effect: ActionEffect): string {
  const parts: string[] = [`step ${effect.step}`];
  if (effect.unverified) {
    parts.push(`unverified (${effect.unverified})`);
    parts.push(`${effect.ms}ms`);
    return parts.join(" · ");
  }
  if (effect.noop) {
    parts.push(
      effect.scrolled
        ? "NO OBSERVABLE EFFECT — url, document and DOM unchanged (the page scrolled only because I moved the target into view)"
        : "NO OBSERVABLE EFFECT — url, document, DOM and scroll all unchanged",
    );
    parts.push(`${effect.ms}ms`);
    return parts.join(" · ");
  }
  parts.push(effect.urlChanged ? `url → ${effect.url}` : "url unchanged");
  parts.push(effect.docChanged ? "new document" : "same document");
  if (effect.elementsBefore !== undefined && effect.elementsAfter !== undefined) {
    parts.push(
      effect.domChanged
        ? `dom changed (${effect.elementsBefore}→${effect.elementsAfter} interactive)`
        : `dom unchanged (${effect.elementsAfter} interactive)`,
    );
  }
  if (effect.scrolled) parts.push("scrolled");
  parts.push(`${effect.ms}ms`);
  return parts.join(" · ");
}
