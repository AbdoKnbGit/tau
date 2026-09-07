/**
 * In-page scripts for the Browser tool, executed via CDP Runtime.evaluate.
 *
 * Adapted from Bah browser (https://github.com/alexvilelabah/bah-browser),
 * MIT License, Copyright (c) Alex Vilela / VilelaLab. The observation,
 * coverage-check, verified-fill, and consent-dismissal techniques are ports
 * of Bah's page-executor.ts and overlay-script.ts, restructured for CDP:
 * observation stores matched elements in an identity registry so later actions
 * resolve refs to the exact DOM node that was observed. Ref ids are allocated
 * by the BrowserSession and are never recycled onto a different element.
 */

/**
 * Max interactive elements returned per observation. The dominant cost of a
 * browsing session is these lists accumulating in context (one per action), so
 * this is the primary token lever. Env-tunable; clamped to a sane range.
 */
export const MAX_OBSERVED_ELEMENTS = (() => {
  const raw = Number(process.env.TAU_BROWSER_MAX_ELEMENTS);
  return Number.isInteger(raw) && raw >= 20 && raw <= 500 ? raw : 120;
})();

export interface InteractiveElement {
  /** Stable ref for this observation. Not renumbered after pruning, so ids may have gaps. */
  id: number;
  tag: string;
  text: string;
  /** Viewport-relative center coordinates in CSS pixels (top document, frame offsets applied). */
  x: number;
  y: number;
  w: number;
  h: number;
  role?: string;
  href?: string;
  placeholder?: string;
  aria?: string;
  value?: string;
  pressed?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** True when the element lives inside a same-origin iframe (still clickable/fillable by ref). */
  frame?: boolean;
  /** Set on a collapsed run marker: N additional similar elements were omitted after this one. */
  repeatNote?: number;
}

export interface ObservedState {
  url: string;
  title: string;
  text_sample: string;
  interactive_elements: InteractiveElement[];
  /** Label of the consent/cookie overlay that was auto-dismissed, if any. */
  dismissed?: string;
  /** Vertical scroll state, so the model knows whether scrolling can reveal more. */
  scroll?: { y: number; maxY: number; viewportH: number };
  /** Count of cross-origin iframes whose content is invisible to observation. */
  crossFrames?: number;
}

/** Result of in-page readable-content extraction (the read action). */
export interface ReadResult {
  success: boolean;
  error?: string;
  reason?: string;
  url?: string;
  title?: string;
  /** The extracted markdown-ish slice [offset, offset+maxChars). */
  content?: string;
  /** Total extracted length before slicing, for pagination. */
  total?: number;
  offset?: number;
}

/** Structured result returned by every in-page action helper. */
export interface PageActionResult {
  success: boolean;
  error?: string;
  /** Machine-readable failure category: 'stale_ref' | 'element_covered' | 'no_match' | 'not_editable'. */
  reason?: string;
  /** Why a ref went stale; numeric refs must never be reused across registries. */
  staleKind?: "registry_missing" | "unknown_ref" | "detached";
  /** Description of the covering element when reason === 'element_covered'. */
  covering?: string;
  /** Safe next action suggested by the page runtime for a recoverable failure. */
  suggestedAction?: "dismiss" | "observe";
  info?: Record<string, unknown>;
}

/** Result of preparing a click target in-page before real input dispatch. */
export interface ClickPrepareResult extends PageActionResult {
  x?: number;
  y?: number;
  href?: string;
  label?: string;
  tag?: string;
  /** The centre was blocked, so a different point inside the target was used. */
  offCentre?: boolean;
  /** Pixels scrolled to get the target out from under fixed/sticky chrome. */
  scrolled?: number;
  /** That scroll is what made the target reachable. */
  recovered?: boolean;
  /** For a text target: how many visible controls carry that text. */
  matches?: number;
  /** modal | fixed | stacked | offscreen — what kind of thing is on top. */
  coverageKind?: "modal" | "fixed" | "stacked" | "offscreen";
}

/** Why an action that ran may have left the page unchanged. */
export interface StateExplanation {
  known: boolean;
  reasons?: string[];
  label?: string;
  tag?: string;
}

/**
 * Wakes lazy loaders and IntersectionObservers before observing, so
 * below-the-fold content that mounts on visibility is present in the DOM.
 */
export const NUDGE_SCRIPT = `
(function(){
  try {
    window.focus();
    document.body && document.body.focus && document.body.focus();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    window.scrollBy(0, 1); window.scrollBy(0, -1);
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    document.dispatchEvent(new Event('mousemove'));
  } catch(e) {}
  return true;
})()
`;

/**
 * Conservative cookie/consent dismisser. Known CMP selectors first (high
 * confidence), then a text heuristic that only fires inside a consent-looking
 * container. Never clicks login/social/reject/settings buttons. Runs once per
 * document (guarded by a window flag). Returns the label of what it clicked,
 * or ''. Top-frame only under CDP (cross-origin CMP iframes are out of reach).
 */
export const OVERLAY_DISMISS_SCRIPT = `
(function(){
  try {
    if (window.__tauOverlaysDismissed) return '';
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
    };
    const fire = (el, why) => {
      try { el.scrollIntoView({ block: 'center' }); } catch(e){}
      try { ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}))); } catch(e){}
      try { if (typeof el.click === 'function') el.click(); } catch(e){}
      window.__tauOverlaysDismissed = true;
      return why;
    };
    const KNOWN = [
      '#onetrust-accept-btn-handler',
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept',
      '#didomi-notice-agree-button',
      '.qc-cmp2-summary-buttons button[mode="primary"]',
      '.fc-button.fc-cta-consent',
      'button.osano-cm-accept-all',
      '#truste-consent-button',
      'button[data-testid="uc-accept-all-button"]',
      '.sp_choice_type_11',
      'button.sp_choice_type_ACCEPT_ALL',
      'button[title="Accept all" i]','button[title="Accept cookies" i]',
      'button[aria-label="Accept all" i]','button[aria-label="Accept cookies" i]',
    ];
    for (const sel of KNOWN) {
      let el = null; try { el = document.querySelector(sel); } catch(e){}
      if (el && vis(el)) return fire(el, 'consent:' + sel);
    }
    const ACCEPT = /\\b(accept(?:\\s+all)?(?:\\s+cookies)?|i\\s+agree|agree|allow\\s+all|got\\s+it|aceitar(?:\\s+(?:todos|tudo))?|aceito|concordo|entendi|ok)\\b/i;
    const BAD = /\\b(delete|remove|logout|log\\s*out|cancel|unsubscribe|reject|decline|settings|manage|prefer|personaliz|customi[sz]e|with\\s+google|with\\s+facebook|with\\s+apple|with\\s+microsoft|continue\\s+with|sign\\s*in|log\\s*in|sign\\s*up|create\\s+account|excluir|apagar|remover|sair|cancelar|recusar|rejeitar|configurar|gerenciar|fazer\\s+login|criar\\s+conta)\\b/i;
    const CTX = '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[id*="privacy" i],[class*="privacy" i],[id*="cmp" i],[class*="cmp" i],[aria-modal="true"],[role="dialog"]';
    const btns = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"], a[href="#"]'));
    for (const b of btns) {
      if (!vis(b)) continue;
      const label = (b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
      if (!label || label.length > 45) continue;
      if (!ACCEPT.test(label) || BAD.test(label)) continue;
      let inCtx = false; try { inCtx = !!b.closest(CTX); } catch(e){}
      if (!inCtx) continue;
      return fire(b, 'text:' + label.slice(0,45));
    }
    return '';
  } catch(e){ return ''; }
})()
`;

/**
 * Observes the page: collects visible interactive elements and stores them in
 * a bidirectional identity registry. BrowserSession supplies a unique id block
 * for each observation, while surviving DOM nodes retain their existing ids.
 * Consequently a ref always means the exact node the model saw, or fails stale.
 */
export const OBSERVE_SCRIPT = `
(function() {
  const MAX = ${MAX_OBSERVED_ELEMENTS};
  const REGISTRY_VERSION = 2;
  const config = window.__tauObserveConfig || {};
  const sessionKey = String(config.sessionKey || '');
  const blockBase = Number.isSafeInteger(config.base) && config.base >= 0 ? config.base : 0;
  const selector = 'a,button,input,textarea,select,[contenteditable="true"],[role=textbox],[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox],[role=option],[role=menuitem],[role=tab],[tabindex]:not([tabindex="-1"])';
  const elements = [];
  let crossFrames = 0;
  let localCursor = 0;

  const liveInTopTree = (el) => {
    if (!el || !el.isConnected || !el.ownerDocument) return false;
    let doc = el.ownerDocument;
    let guard = 0;
    try {
      while (doc && doc !== document && guard++ < 6) {
        const win = doc.defaultView;
        const frame = win && win.frameElement;
        if (!frame || !frame.isConnected || frame.contentDocument !== doc) return false;
        doc = frame.ownerDocument;
      }
    } catch (e) { return false; }
    return doc === document;
  };

  let state = window.__tauRefState;
  const validState = state
    && state.version === REGISTRY_VERSION
    && state.sessionKey === sessionKey
    && state.document === document
    && state.elementToId instanceof WeakMap
    && state.idToElement instanceof Map;
  if (!validState) {
    state = {
      version: REGISTRY_VERSION,
      sessionKey,
      document,
      elementToId: new WeakMap(),
      idToElement: new Map(),
      lastObservedIds: [],
    };
    window.__tauRefState = state;
  } else {
    // Detached nodes are retired permanently. A later re-attachment receives a
    // new id, so a ref that once failed stale can never become valid again.
    for (const [id, el] of state.idToElement) {
      if (!liveInTopTree(el)) {
        state.idToElement.delete(id);
        state.elementToId.delete(el);
      }
    }
  }

  const refFor = (el) => {
    const existing = state.elementToId.get(el);
    if (Number.isSafeInteger(existing) && state.idToElement.get(existing) === el) return existing;
    let id = blockBase + localCursor++;
    while (state.idToElement.has(id)) id = blockBase + localCursor++;
    state.elementToId.set(el, id);
    state.idToElement.set(id, el);
    return id;
  };

  const closeIconLabel = (el, rect) => {
    if (!el || String(el.tagName || '').toUpperCase() !== 'BUTTON' || rect.width > 80 || rect.height > 80) return '';
    const nodes = [el].concat(Array.from(el.querySelectorAll ? el.querySelectorAll('svg,use,i,[data-icon]') : []).slice(0, 6));
    const hint = nodes.map(node => [
      node.getAttribute && node.getAttribute('class'),
      node.getAttribute && node.getAttribute('data-icon'),
      node.getAttribute && node.getAttribute('href'),
      node.getAttribute && node.getAttribute('xlink:href'),
    ].filter(Boolean).join(' ')).join(' ').toLowerCase();
    return /(?:^|[\\s:_-])(close|dismiss|times|xmark|cross|lucide-x)(?:$|[\\s:_-])/.test(hint) ? 'Close' : '';
  };
  // Walks a document plus its same-origin iframes (payment forms, embedded
  // editors, docs viewers). Frame elements get their coordinates translated to
  // top-viewport space, so real-input clicks land in the right frame for free.
  const collect = (doc, ox, oy, depth) => {
    const win = doc.defaultView;
    if (!win) return;
    let list;
    try { list = doc.querySelectorAll(selector); } catch (e) { return; }
    for (const el of list) {
      if (elements.length >= MAX) return;
      const r = el.getBoundingClientRect();
      const style = win.getComputedStyle(el);
      if (!(r.width > 0 && r.height > 0) || style.visibility === 'hidden' || style.display === 'none') continue;
      const ax = ox + r.left, ay = oy + r.top;
      if (ay + r.height < 0 || ax + r.width < 0 || ay > innerHeight * 2 || ax > innerWidth) continue;
      const ariaLabel = el.getAttribute('aria-label') || '';
      const innerText = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const text = (innerText || ariaLabel || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || closeIconLabel(el, r) || '').slice(0, 120);
      const pressed = el.getAttribute('aria-pressed');
      const checked = el.matches('input[type=checkbox],input[type=radio]') ? String(el.checked) : el.getAttribute('aria-checked');
      const value = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && typeof el.value === 'string' && el.type !== 'password' ? el.value.slice(0, 60) : undefined;
      const id = refFor(el);
      elements.push({
        id,
        tag: el.tagName.toLowerCase(),
        text,
        x: Math.round(ax + r.width / 2),
        y: Math.round(ay + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
        role: el.getAttribute('role') || undefined,
        href: (el.href && typeof el.href === 'string') ? el.href.slice(0, 300) : undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        aria: ariaLabel ? ariaLabel.slice(0, 80) : undefined,
        value,
        pressed: pressed === 'true' ? true : (pressed === 'false' ? false : undefined),
        checked: checked === 'true' ? true : (checked === 'false' ? false : undefined),
        disabled: (el.disabled === true || el.getAttribute('aria-disabled') === 'true') ? true : undefined,
        frame: depth > 0 ? true : undefined,
      });
    }
    if (depth >= 3) return;
    let frames;
    try { frames = doc.querySelectorAll('iframe,frame'); } catch (e) { return; }
    for (const f of frames) {
      if (elements.length >= MAX) return;
      const fr = f.getBoundingClientRect();
      if (fr.width < 30 || fr.height < 30) continue;
      const fx = ox + fr.left, fy = oy + fr.top;
      if (fy + fr.height < 0 || fx + fr.width < 0 || fy > innerHeight * 2 || fx > innerWidth) continue;
      let cd = null;
      try { cd = f.contentDocument; } catch (e) { cd = null; }
      if (!cd || !cd.body) { crossFrames++; continue; }
      collect(cd, fx, fy, depth + 1);
    }
  };
  collect(document, 0, 0, 0);
  state.lastObservedIds = elements.map(el => el.id);
  // Do not leave the legacy positional array around: resolving through it can
  // silently bind an old numeric ref to a different element after a rerender.
  try { delete window.__tauRefs; } catch (e) { window.__tauRefs = undefined; }
  const doc = document.documentElement;
  return {
    url: location.href,
    title: document.title,
    text_sample: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
    interactive_elements: elements,
    scroll: {
      y: Math.round(window.scrollY),
      maxY: Math.max(0, Math.round((doc.scrollHeight || 0) - innerHeight)),
      viewportH: Math.round(innerHeight),
    },
    crossFrames: crossFrames || undefined,
  };
})()
`;

/**
 * Idempotent in-page action helpers. Injected before each action call.
 * Click targets are *prepared* here (resolve, scroll into view, coverage
 * check) and then clicked with real CDP input from the Node side;
 * `fallbackClick` is the synthetic-event fallback when real input fails.
 */
export const PAGE_TOOLS_SCRIPT = `
window.__tauPageState = window.__tauPageState || {};
window.__tauPageTools = Object.assign(window.__tauPageTools || {}, {
  version: 2,
  visible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    const s = (view && view.getComputedStyle ? view.getComputedStyle(el) : getComputedStyle(el));
    if (!(r.width > 0 && r.height > 0)) return false;
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (s.pointerEvents === 'none') return false;
    const opacity = parseFloat(s.opacity);
    if (!Number.isNaN(opacity) && opacity <= 0.01) return false;
    return true;
  },
  closeIconHint(el) {
    if (!el) return false;
    const nodes = [el].concat(Array.from(el.querySelectorAll ? el.querySelectorAll('svg,use,i,[data-icon]') : []).slice(0, 6));
    const hint = nodes.map(node => [
      node.getAttribute && node.getAttribute('class'),
      node.getAttribute && node.getAttribute('data-icon'),
      node.getAttribute && node.getAttribute('href'),
      node.getAttribute && node.getAttribute('xlink:href'),
    ].filter(Boolean).join(' ')).join(' ').toLowerCase();
    return /(?:^|[\\s:_-])(close|dismiss|times|xmark|cross|lucide-x)(?:$|[\\s:_-])/.test(hint);
  },
  label(el) {
    const explicit = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').replace(/\\s+/g, ' ').trim();
    if (explicit) return explicit;
    if (String(el.tagName || '').toUpperCase() === 'BUTTON' && this.closeIconHint(el)) return 'Close';
    return '';
  },
  // Bounding rect translated to top-viewport coordinates: for elements inside
  // same-origin iframes, walks the frameElement chain adding each frame's
  // offset, so CDP real-input events (which are top-viewport coords) land right.
  absRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top;
    let win = el.ownerDocument ? el.ownerDocument.defaultView : null;
    let guard = 0;
    while (win && win !== window && win.frameElement && guard++ < 5) {
      const fr = win.frameElement.getBoundingClientRect();
      x += fr.left; y += fr.top;
      win = win.parent;
    }
    return { left: x, top: y, width: r.width, height: r.height };
  },
  describeEl(hit) {
    const classText = hit && typeof hit.className === 'string'
      ? hit.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.')
      : '';
    const label = hit ? this.label(hit).slice(0, 50) : '';
    return (hit.tagName || '?').toLowerCase()
      + (hit.id ? '#' + hit.id : '')
      + (classText ? '.' + classText : '')
      + (label ? ' ["' + label + '"]' : '');
  },
  liveInTopTree(el) {
    if (!el || !el.isConnected || !el.ownerDocument) return false;
    let doc = el.ownerDocument;
    let guard = 0;
    try {
      while (doc && doc !== document && guard++ < 6) {
        const win = doc.defaultView;
        const frame = win && win.frameElement;
        if (!frame || !frame.isConnected || frame.contentDocument !== doc) return false;
        doc = frame.ownerDocument;
      }
    } catch (e) { return false; }
    return doc === document;
  },
  semanticOverlay(el) {
    if (!el || !el.matches) return false;
    const selector = '[role="dialog"],[aria-modal="true"],[popover]:popover-open,[class*="modal" i],[class*="popup" i],[class*="dialog" i],[class*="lightbox" i],[class*="drawer" i],[class*="overlay" i],[id*="modal" i],[id*="popup" i]';
    try { return el.matches(selector); } catch (e) { return false; }
  },
  geometryOverlay(el, allowSidePanel) {
    if (!this.visible(el)) return false;
    const r = el.getBoundingClientRect();
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const vw = Math.max(1, Number(view.innerWidth || innerWidth));
    const vh = Math.max(1, Number(view.innerHeight || innerHeight));
    const s = view.getComputedStyle ? view.getComputedStyle(el) : getComputedStyle(el);
    const positioned = s.position === 'fixed' || s.position === 'absolute';
    if (!positioned) return false;
    const fullLayer = r.width >= vw * 0.72 && r.height >= vh * 0.72;
    const nearLeft = r.left <= 8;
    const nearRight = r.right >= vw - 8;
    const sidePanel = r.height >= vh * 0.7 && r.width >= Math.min(220, vw * 0.22) && (nearLeft || nearRight);
    const z = parseInt(s.zIndex || '0', 10) || 0;
    const background = String(s.backgroundColor || '').toLowerCase();
    const transparent = background === '' || background === 'transparent'
      || /rgba?\\([^)]*,\\s*0(?:\\.0+)?\\s*\\)$/.test(background);
    return (fullLayer && (s.position === 'fixed' || z > 0 || !transparent))
      || (!!allowSidePanel && sidePanel && (s.position === 'fixed' || z > 0));
  },
  findOverlayScope(hit) {
    let node = hit;
    let geometric = null;
    let guard = 0;
    while (node && guard++ < 14) {
      if (this.semanticOverlay(node) && this.visible(node)) return node;
      if (this.geometryOverlay(node, true)) geometric = node;
      const doc = node.ownerDocument;
      if (node === (doc && doc.body) || node === (doc && doc.documentElement)) break;
      node = node.parentElement;
    }
    return geometric;
  },
  rememberBlocker(hit, x, y) {
    const scope = this.findOverlayScope(hit);
    window.__tauPageState.lastBlocker = { hit, scope, x, y, at: Date.now() };
    return scope;
  },
  // A hit counts as on-target when it IS the element, sits inside it, or wraps
  // it. Anything else is a different element painted on top.
  pointHitsTarget(el, hit) {
    if (!hit) return false;
    return hit === el || el.contains(hit) || hit.contains(el);
  },
  // Points to try inside an element, best first. Testing only the centre fails
  // whenever a badge, ribbon, sticker or price label is stacked over the middle
  // of a control — common, and no reason to abandon the click when the rest of
  // the control is reachable.
  hitPoints(el) {
    const doc = el.ownerDocument || document;
    const view = doc.defaultView || window;
    const r = el.getBoundingClientRect();
    // Sample inside the element's VISIBLE part. An element taller than the
    // viewport, or one hanging half off the fold, has a perfectly clickable
    // area even though its geometric centre is nowhere on screen.
    const left = Math.max(r.left, 1);
    const right = Math.min(r.right, view.innerWidth - 1);
    const top = Math.max(r.top, 1);
    const bottom = Math.min(r.bottom, view.innerHeight - 1);
    if (right <= left || bottom <= top) return [];
    const fx = [0.5, 0.22, 0.78, 0.5, 0.5, 0.22, 0.78, 0.22, 0.78];
    const fy = [0.5, 0.5, 0.5, 0.22, 0.78, 0.22, 0.22, 0.78, 0.78];
    const out = [];
    for (let i = 0; i < fx.length; i++) {
      out.push({
        x: left + (right - left) * fx[i],
        y: top + (bottom - top) * fy[i],
        centre: i === 0,
      });
    }
    return out;
  },
  clickablePoint(el) {
    const doc = el.ownerDocument || document;
    const points = this.hitPoints(el);
    let blocker = null;
    for (let i = 0; i < points.length; i++) {
      const hit = doc.elementFromPoint(points[i].x, points[i].y);
      if (this.pointHitsTarget(el, hit)) {
        return { found: true, x: points[i].x, y: points[i].y, centre: points[i].centre, tried: points.length };
      }
      if (!blocker && hit) blocker = hit;
    }
    return { found: false, blocker: blocker, tried: points.length };
  },
  // Why is something on top: a dialog you must close, page chrome that does not
  // scroll, or a plain element painted above — three different situations that
  // deserve three different answers.
  classifyBlocker(blocker) {
    if (!blocker) return { kind: 'offscreen' };
    // An overlay scope is either semantic (role=dialog, drawer/modal naming) or
    // geometric (a full-viewport layer or a side panel). Both are things a user
    // closes, so both are dismissible — and this test has to come FIRST: a
    // modal backdrop is position:fixed too, and calling it page furniture would
    // send the caller scrolling instead of closing it.
    const scope = this.findOverlayScope(blocker);
    if (scope) return { kind: 'modal', node: scope };
    let node = blocker;
    let guard = 0;
    while (node && guard++ < 8) {
      let s;
      try { s = getComputedStyle(node); } catch (e) { break; }
      // Fixed or sticky, but not an overlay: headers, language bars, cookie
      // strips. Nothing to dismiss; they move only when the page scrolls.
      if (s.position === 'fixed' || s.position === 'sticky') return { kind: 'fixed', node: node };
      node = node.parentElement;
    }
    return { kind: 'stacked', node: blocker };
  },
  // Full-width bands of fixed/sticky chrome pinned to the top or bottom of the
  // viewport. Found by computed position and geometry — never by name.
  fixedBands(el) {
    const doc = el.ownerDocument || document;
    const view = doc.defaultView || window;
    const vh = Math.max(1, view.innerHeight);
    const vw = Math.max(1, view.innerWidth);
    const band = { top: 0, bottom: vh };
    let nodes = [];
    try { nodes = doc.querySelectorAll('body *'); } catch (e) { return band; }
    const cap = nodes.length < 2500 ? nodes.length : 2500;
    for (let i = 0; i < cap; i++) {
      const node = nodes[i];
      if (node === el || node.contains(el) || el.contains(node)) continue;
      let s;
      try { s = getComputedStyle(node); } catch (e) { continue; }
      if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (!this.visible(node)) continue;
      const r = node.getBoundingClientRect();
      if (r.width < vw * 0.5 || r.height <= 0 || r.height > vh * 0.5) continue;
      if (r.top <= 2 && r.bottom > band.top) band.top = r.bottom;
      else if (r.bottom >= vh - 2 && r.top < band.bottom) band.bottom = r.top;
    }
    return band;
  },
  // scrollIntoView({block:'center'}) cannot centre anything on a page too short
  // to scroll, so a target near the top stays under a sticky header. Move it
  // into the free band between the fixed layers instead.
  clearFixedCoverage(el) {
    const doc = el.ownerDocument || document;
    const view = doc.defaultView || window;
    const band = this.fixedBands(el);
    const free = band.bottom - band.top;
    if (free < 40) return { scrolled: 0, band: band };
    const r = el.getBoundingClientRect();
    const desiredTop = band.top + Math.max(6, (free - r.height) / 2);
    const delta = Math.round(r.top - desiredTop);
    if (Math.abs(delta) < 4) return { scrolled: 0, band: band };
    if (typeof view.scrollBy !== 'function') return { scrolled: 0, band: band };
    const before = view.scrollY || 0;
    try { view.scrollBy(0, delta); } catch (e) { return { scrolled: 0, band: band }; }
    return { scrolled: Math.round((view.scrollY || 0) - before), band: band };
  },
  // Does a point on the element actually reach the element? Tries several
  // points, then tries to get out from under fixed chrome, and only then
  // reports a blocker — classified, so the caller knows whether to dismiss
  // something, scroll, or treat it as a defect in the page.
  // Checked inside the element's own document AND at every hosting-frame level,
  // so a top-page modal covering an iframe form is caught too.
  coverageCheck(el) {
    const doc = el.ownerDocument || document;
    const dwin = doc.defaultView || window;
    let attempt = this.clickablePoint(el);
    let scrolled = 0;
    let recovered = false;
    if (!attempt.found) {
      const first = this.classifyBlocker(attempt.blocker);
      if (first.kind === 'fixed' || first.kind === 'offscreen') {
        const moved = this.clearFixedCoverage(el);
        scrolled = moved.scrolled || 0;
        if (scrolled !== 0) {
          const retry = this.clickablePoint(el);
          if (retry.found) {
            attempt = retry;
            recovered = true;
          }
        }
      }
    }
    if (!attempt.found) {
      const verdict = this.classifyBlocker(attempt.blocker);
      const scope = verdict.node || attempt.blocker;
      const r = el.getBoundingClientRect();
      if (attempt.blocker) {
        this.rememberBlocker(attempt.blocker, r.left + r.width / 2, r.top + r.height / 2);
      }
      let z = 0;
      try { z = parseInt(getComputedStyle(scope || el).zIndex, 10) || 0; } catch (e) { z = 0; }
      let openOverlays = 0;
      try { openOverlays = this.overlayCandidates().length; } catch (e) { openOverlays = 0; }
      return {
        ok: false,
        covering: this.describeEl(scope || el),
        dismissible: verdict.kind === 'modal',
        kind: verdict.kind,
        sampled: attempt.tried,
        scrolled: scrolled,
        zIndex: z,
        openOverlays: openOverlays,
      };
    }
    let x = Math.min(Math.max(attempt.x, 1), dwin.innerWidth - 1);
    let y = Math.min(Math.max(attempt.y, 1), dwin.innerHeight - 1);
    const localPoint = { x: x, y: y };
    let win = dwin, guard = 0;
    while (win && win !== window && win.frameElement && guard++ < 5) {
      const fe = win.frameElement;
      const fr = fe.getBoundingClientRect();
      x += fr.left; y += fr.top;
      const pdoc = fe.ownerDocument;
      const pwin = pdoc.defaultView;
      const phit = pdoc.elementFromPoint(
        Math.min(Math.max(x, 1), pwin.innerWidth - 1),
        Math.min(Math.max(y, 1), pwin.innerHeight - 1),
      );
      if (phit && phit !== fe && !fe.contains(phit) && !phit.contains(fe)) {
        const scope = this.rememberBlocker(phit, x, y);
        const verdict = this.classifyBlocker(phit);
        return {
          ok: false,
          covering: this.describeEl(scope || phit),
          dismissible: verdict.kind === 'modal',
          kind: verdict.kind,
          sampled: 1,
          scrolled: scrolled,
          zIndex: 0,
          openOverlays: 0,
        };
      }
      win = win.parent;
    }
    return {
      ok: true,
      x: localPoint.x,
      y: localPoint.y,
      offCentre: !attempt.centre,
      scrolled: scrolled,
      recovered: recovered,
    };
  },
  byRef(ref) {
    const state = window.__tauRefState;
    const expectedKey = String((window.__tauPageConfig && window.__tauPageConfig.sessionKey) || '');
    if (!state || state.version !== 2 || state.sessionKey !== expectedKey || state.document !== document || !(state.idToElement instanceof Map)) return { error: 'none_observed' };
    const id = Number(ref);
    const el = Number.isSafeInteger(id) ? state.idToElement.get(id) : null;
    if (!el) return { error: 'no_such_ref' };
    if (!this.liveInTopTree(el)) {
      state.idToElement.delete(id);
      if (state.elementToId && state.elementToId.delete) state.elementToId.delete(el);
      return { error: 'stale' };
    }
    return { el };
  },
  setObservedIds(ids) {
    const state = window.__tauRefState;
    const expectedKey = String((window.__tauPageConfig && window.__tauPageConfig.sessionKey) || '');
    if (!state || state.version !== 2 || state.sessionKey !== expectedKey || state.document !== document || !(state.idToElement instanceof Map)) return { success: false, reason: 'stale_ref' };
    state.lastObservedIds = Array.from(ids || []).map(Number).filter(id => Number.isSafeInteger(id) && state.idToElement.has(id));
    return { success: true, info: { count: state.lastObservedIds.length } };
  },
  staleKind(got) {
    if (got && got.error === 'none_observed') return 'registry_missing';
    if (got && got.error === 'no_such_ref') return 'unknown_ref';
    return 'detached';
  },
  // scrollIntoView honours the CSS scroll-behavior property, so on a page that
  // asks for smooth scrolling it is ASYNCHRONOUS: it returns immediately and the
  // page glides into place over the next few hundred ms. Every rect read straight
  // afterwards is then the PRE-scroll rect, so hit-testing lands on whatever
  // occupies that point - usually the sticky header, which is exactly the
  // mystery 'covered by the header' failure. behavior:instant overrides the
  // page's preference; the fallback covers containers that still do not move.
  scrollTo(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (e) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e2) {}
    }
    const doc = el.ownerDocument || document;
    const view = doc.defaultView || window;
    const r = el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < view.innerHeight) return;
    try {
      const absoluteTop = r.top + (view.scrollY || 0);
      view.scrollTo({ top: Math.max(0, absoluteTop - view.innerHeight / 2), behavior: 'instant' });
    } catch (e) {
      try { view.scrollTo(0, Math.max(0, r.top + (view.scrollY || 0) - view.innerHeight / 2)); } catch (e2) {}
    }
  },
  fireClick(el) {
    this.scrollTo(el);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y }));
    }
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y }));
  },
  prepareEl(el) {
    this.scrollTo(el);
    const cov = this.coverageCheck(el);
    if (!cov.ok) {
      // Three different situations, three different answers. Guessing "an
      // overlay is blocking it" for all of them sends the caller into a
      // dismiss/retry loop that cannot work when the cause is the page's own
      // stacking order.
      let hint;
      if (cov.kind === 'offscreen') {
        // Nothing is on top of it: there is simply no part of it on screen.
        return {
          success: false,
          reason: 'element_covered',
          coverageKind: cov.kind,
          suggestedAction: 'observe',
          error: 'Target has no visible area: after scrolling to it, no part of the element lies inside the viewport'
            + (cov.scrolled ? ' (I scrolled ' + Math.abs(cov.scrolled) + 'px trying to bring it in)' : '')
            + '. It may be hidden by a collapsed container, animating in, or laid out off-screen. Scroll, wait, or resize the viewport, then re-observe.',
        };
      }
      if (cov.kind === 'modal') {
        hint = ' A dialog, drawer or full-page layer is open above it'
          + (cov.openOverlays > 1 ? ' (' + cov.openOverlays + ' layers are open — close the topmost first)' : '')
          + '. Use the dismiss action, then re-observe and retry with a fresh ref.';
      } else if (cov.kind === 'fixed') {
        hint = ' That is fixed or sticky page furniture, and it stays put when the page scrolls.'
          + (cov.scrolled ? ' I scrolled ' + Math.abs(cov.scrolled) + 'px to get out from under it and it still covers every point of the target.' : ' The page cannot scroll far enough to clear it.')
          + ' Scroll the page yourself, resize taller, or act on a different element.';
      } else if (cov.kind === 'offscreen') {
        hint = ' The target has no point inside the viewport. Scroll it into view or resize the viewport first.';
      } else {
        hint = ' I tried ' + (cov.sampled || 1) + ' points across the target and every one landed on that element'
          + (cov.zIndex ? ' (z-index ' + cov.zIndex + ')' : '')
          + '. It is a normal element painted above the target, not a dialog — dismissing will not help and retrying the same click will fail the same way.'
          + ' This is a stacking (z-index) defect in the page: report it, or act on the covering element instead.';
      }
      return {
        success: false,
        reason: 'element_covered',
        covering: cov.covering,
        suggestedAction: cov.dismissible ? 'dismiss' : 'observe',
        coverageKind: cov.kind,
        error: 'Target is covered by: ' + cov.covering + '.' + hint,
      };
    }
    const r = this.absRect(el);
    const link = el.closest ? el.closest('a[href]') : null;
    const href = link && link.href && !String(link.href).startsWith('javascript:') ? String(link.href) : undefined;
    // coverageCheck works in the element's own document; absRect is in top
    // viewport coordinates. Carry the frame offset across so the real mouse
    // event lands on the point that was actually hit-tested.
    const local = el.getBoundingClientRect();
    const offsetX = r.left - local.left;
    const offsetY = r.top - local.top;
    const pointX = cov.x != null ? cov.x + offsetX : r.left + r.width / 2;
    const pointY = cov.y != null ? cov.y + offsetY : r.top + r.height / 2;
    return {
      success: true,
      x: Math.round(pointX),
      y: Math.round(pointY),
      href,
      label: this.label(el).slice(0, 120),
      tag: el.tagName.toLowerCase(),
      offCentre: !!cov.offCentre,
      scrolled: cov.scrolled || 0,
      recovered: !!cov.recovered,
    };
  },
  prepareRef(ref) {
    const got = this.byRef(ref);
    if (got.error === 'none_observed') return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'No observation registry on this page. Run observe first.' };
    if (got.error === 'no_such_ref') return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'No element with ref @' + ref + ' in the last observation.' };
    if (got.error === 'stale') return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'Element @' + ref + ' is no longer in the page (DOM changed). Re-observe.' };
    return this.prepareEl(got.el);
  },
  prepareText(text, nth) {
    const needle = String(text || '').toLowerCase().trim();
    if (!needle) return { success: false, reason: 'no_match', error: 'Missing text' };
    const NEG = ['no ', 'not ', 'un', 'dis', "don't ", 'do not ', 'never ', 'nao ', 'não '];
    const NEG_SCORE = 900;
    const escapeRe = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const wordRe = new RegExp('(^|\\\\W)' + escapeRe(needle) + '($|\\\\W)');
    const score = (label) => {
      const l = label.toLowerCase().trim();
      if (!l.includes(needle)) return 999;
      for (const neg of NEG) { if (l.includes(neg + needle)) return NEG_SCORE; }
      if (l === needle) return 0;
      if (wordRe.test(l)) return 1;
      return 5;
    };
    const selector = 'a,button,[role=button],[role=link],input,textarea,select,[contenteditable="true"],[role=textbox],[tabindex]:not([tabindex="-1"]),span,div,p,li,label';
    const candidates = Array.from(document.querySelectorAll(selector))
      .filter(el => this.visible(el))
      .filter(el => this.label(el).toLowerCase().includes(needle))
      .sort((a, b) => {
        const sa = score(this.label(a));
        const sb = score(this.label(b));
        if (sa !== sb) return sa - sb;
        const ap = a.closest('a,button,[role=button],[role=link]') ? 0 : 1;
        const bp = b.closest('a,button,[role=button],[role=link]') ? 0 : 1;
        return ap - bp || this.label(a).length - this.label(b).length;
      });
    const raw = candidates[Math.max(0, Number(nth || 1) - 1)];
    if (!raw) return { success: false, reason: 'no_match', error: 'No visible element contains text: ' + text };
    if (score(this.label(raw)) >= NEG_SCORE) return { success: false, reason: 'no_match', error: 'Only negated matches found for "' + text + '" (e.g. "' + this.label(raw).slice(0, 60) + '"). Observe and click by ref instead.' };
    const el = raw.closest('a,button,[role=button],[role=link]') || raw;
    const prepared = this.prepareEl(el);
    // How many controls carry this text. One is unambiguous; several mean the
    // caller is relying on ordering that the page is free to change.
    prepared.matches = candidates.filter(c => score(this.label(c)) < NEG_SCORE).length;
    return prepared;
  },
  // Why an action might have left the page unchanged. Read from the element's
  // own state, so it works for a native <select>, an ARIA toggle, or any
  // component library that exposes state through data-state.
  explainState(ref) {
    const got = this.byRef(ref);
    if (!got || !got.el) return { known: false };
    const el = got.el;
    const attr = name => (el.getAttribute ? el.getAttribute(name) : null);
    const reasons = [];
    if (el.disabled === true || attr('aria-disabled') === 'true') reasons.push('the control is disabled');
    if (attr('aria-pressed') === 'true') reasons.push('it was already pressed (aria-pressed="true")');
    if (attr('aria-selected') === 'true') reasons.push('it was already selected (aria-selected="true")');
    if (attr('aria-checked') === 'true') reasons.push('it was already checked (aria-checked="true")');
    if (attr('aria-expanded') === 'true') reasons.push('it was already expanded (aria-expanded="true")');
    const state = attr('data-state');
    if (state && /^(checked|active|selected|on|open)$/i.test(state)) {
      reasons.push('it was already active (data-state="' + state + '")');
    }
    if (String(el.tagName).toUpperCase() === 'OPTION' && el.selected) {
      reasons.push('that option was already the selected one');
    }
    const select = el.closest ? el.closest('select') : null;
    if (select) {
      reasons.push('it belongs to a <select>, which fires no change event when the value does not change');
    }
    let style = null;
    try { style = getComputedStyle(el); } catch (e) { style = null; }
    if (style && style.pointerEvents === 'none') reasons.push('its computed pointer-events is none');
    const href = attr('href');
    if (href === '#' || (href && href.indexOf('javascript:') === 0)) {
      reasons.push('its href is a placeholder (' + href + ')');
    }
    return {
      known: reasons.length > 0,
      reasons: reasons,
      label: this.label(el).slice(0, 60),
      tag: String(el.tagName || '').toLowerCase(),
    };
  },
  labelAt(x, y) {
    const el = document.elementFromPoint(Number(x), Number(y));
    if (!el) return { found: false };
    return { found: true, label: this.label(el).slice(0, 120), tag: el.tagName.toLowerCase() };
  },
  fallbackClickRef(ref) {
    const got = this.byRef(ref);
    if (!got.el) return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'Ref @' + ref + ' cannot be resolved.' };
    this.fireClick(got.el);
    return { success: true, info: { synthetic: true } };
  },
  fieldValue(el) {
    if (el && typeof el.value === 'string') return el.value;
    if (el && (el.isContentEditable || el.getAttribute('role') === 'textbox')) return el.innerText || el.textContent || '';
    return '';
  },
  editableTarget(el) {
    if (!el) return null;
    if (el.matches && (el.matches('input,textarea,select,[contenteditable="true"],[role=textbox]') || el.isContentEditable)) return el;
    return el.closest && el.closest('input,textarea,select,[contenteditable="true"],[role=textbox]');
  },
  insertText(el, value, replace) {
    if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
      el.focus();
      if (replace) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: value, inputType: replace ? 'insertReplacementText' : 'insertText' }));
      if (!document.execCommand('insertText', false, value)) {
        if (replace) el.textContent = value;
        else el.textContent = (el.textContent || '') + value;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: replace ? 'insertReplacementText' : 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // React/Vue controlled inputs: set through the prototype setter and emit a
    // representative key/input/change sequence so the framework registers it.
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    const keyOpts = { bubbles: true, cancelable: true, key: value.slice(-1) || 'a' };
    el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  // Verified fill: reads the real value back afterwards, so a swallowed write
  // (disabled/custom widget) reports failure instead of fake success. Lenient
  // on purpose: masked fields (phone/date) reformat the text and still pass.
  fillRef(ref, value) {
    const got = this.byRef(ref);
    if (got.error === 'none_observed' || got.error === 'no_such_ref') return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'No element with ref @' + ref + ' in the last observation. Re-observe.' };
    if (got.error === 'stale') return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'Element @' + ref + ' is no longer in the page. Re-observe.' };
    const el = this.editableTarget(got.el) || got.el;
    if (el.tagName === 'SELECT') return this.selectOption(el, value, ref);
    if (!this.editableTarget(el)) return { success: false, reason: 'not_editable', error: 'Element @' + ref + ' (' + el.tagName.toLowerCase() + ' "' + this.label(el).slice(0, 40) + '") is not an editable field.' };
    this.scrollTo(el);
    el.focus();
    const want = String(value ?? '');
    this.insertText(el, want, true);
    const gotValue = this.fieldValue(el);
    if (want && !gotValue) return { success: false, reason: 'not_editable', error: 'Field @' + ref + ' stayed empty — it did not accept the text (disabled or custom widget). Try clicking it first, or use a different element.' };
    return { success: true, info: { ref: Number(ref), tag: el.tagName.toLowerCase(), valueLength: gotValue.length, verified: gotValue === want } };
  },
  selectOption(el, value, ref) {
    const want = String(value ?? '').toLowerCase().trim();
    const options = Array.from(el.options || []);
    const match = options.find(o => o.value.toLowerCase() === want)
      || options.find(o => (o.label || o.text || '').toLowerCase().trim() === want)
      || options.find(o => (o.label || o.text || '').toLowerCase().includes(want));
    if (!match) return { success: false, reason: 'no_match', error: 'No option matching "' + value + '" in select @' + ref + '. Options: ' + options.slice(0, 20).map(o => o.label || o.text || o.value).join(' | ').slice(0, 300) };
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
    if (setter) setter.call(el, match.value); else el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, info: { ref: Number(ref), tag: 'select', selected: match.label || match.text || match.value } };
  },
  focusedInfo() {
    const el = this.editableTarget(document.activeElement);
    if (!el) return { editable: false };
    return { editable: true, tag: el.tagName.toLowerCase(), label: this.label(el).slice(0, 80), valueBefore: this.fieldValue(el).length };
  },
  verifyTyped() {
    const el = this.editableTarget(document.activeElement);
    if (!el) return { length: 0 };
    return { length: this.fieldValue(el).length };
  },
  scrollPage(direction, amount) {
    const n = Number(amount || 650);
    const doc = document.documentElement;
    if (direction === 'left' || direction === 'right') {
      window.scrollBy({ left: direction === 'left' ? -n : n, behavior: 'instant' });
    } else {
      const map = { up: -n, down: n, top: -doc.scrollHeight, bottom: doc.scrollHeight };
      window.scrollBy({ top: map[direction] ?? n, behavior: 'instant' });
    }
    return { success: true, info: { direction, y: Math.round(window.scrollY), maxY: Math.max(0, Math.round(doc.scrollHeight - innerHeight)) } };
  },
  scrollToRef(ref) {
    const got = this.byRef(ref);
    if (got.error) return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'Element @' + ref + ' cannot be resolved (DOM changed). Re-observe.' };
    got.this.scrollTo(el);
    return { success: true, info: { scrolledTo: this.label(got.el).slice(0, 60) || got.el.tagName.toLowerCase(), y: Math.round(window.scrollY) } };
  },
  // Viewport rect (with a small margin) of @ref for an element screenshot.
  rectOfRef(ref) {
    const got = this.byRef(ref);
    if (got.error) return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'Element @' + ref + ' cannot be resolved (DOM changed). Re-observe.' };
    got.this.scrollTo(el);
    const r = this.absRect(got.el);
    return { success: true, info: { x: Math.max(0, Math.round(r.left) - 4), y: Math.max(0, Math.round(r.top) - 4), w: Math.min(Math.round(r.width) + 8, innerWidth), h: Math.min(Math.round(r.height) + 8, innerHeight) } };
  },
  // Rect of @ref WITHOUT scrolling it into view (drag targets: scrolling the
  // target would move the just-centered source).
  rectOfRefNoScroll(ref) {
    const got = this.byRef(ref);
    if (got.error) return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'Element @' + ref + ' cannot be resolved (DOM changed). Re-observe.' };
    const r = this.absRect(got.el);
    return { success: true, info: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
  },
  // Closes the topmost modal/dialog/drawer/popup. Finds the highest-stacked
  // overlay container, then its close control (X / aria-label close / role
  // button in a dialog). Returns what it closed, or a miss so the caller can
  // fall back to the Escape key from the Node side. This is the first-class
  // way out of a QuickView/lightbox — far more reliable than guessing where
  // the X sits and clicking coordinates.
  overlayPaintRank(el) {
    const doc = el.ownerDocument || document;
    const view = doc.defaultView || window;
    const r = el.getBoundingClientRect();
    const points = [
      [Math.min(Math.max(r.left + r.width / 2, 1), view.innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 1), view.innerHeight - 1)],
      [Math.min(Math.max(r.right - 12, 1), view.innerWidth - 1), Math.min(Math.max(r.top + 12, 1), view.innerHeight - 1)],
    ];
    let rank = 1000000;
    if (typeof doc.elementsFromPoint !== 'function') return rank;
    for (const [x, y] of points) {
      let stack = [];
      try { stack = Array.from(doc.elementsFromPoint(x, y)); } catch (e) {}
      const index = stack.findIndex(node => node === el || (el.contains && el.contains(node)));
      if (index >= 0) rank = Math.min(rank, index);
    }
    return rank;
  },
  overlayCandidates() {
    const out = [];
    const seen = new Set();
    const add = (el, provenance) => {
      if (!el || seen.has(el) || !el.isConnected || !this.visible(el)) return;
      seen.add(el);
      out.push({ el, provenance: !!provenance, rank: this.overlayPaintRank(el) });
    };
    const saved = window.__tauPageState && window.__tauPageState.lastBlocker;
    if (saved && Date.now() - Number(saved.at || 0) < 120000 && saved.scope) {
      const currentScope = this.findOverlayScope(saved.scope) || saved.scope;
      if (this.semanticOverlay(currentScope) || this.geometryOverlay(currentScope, true)) add(currentScope, true);
    }
    const semanticSelector = '[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="popup" i],[class*="dialog" i],[class*="lightbox" i],[class*="drawer" i],[class*="overlay" i],[id*="modal" i],[id*="popup" i]';
    try {
      for (const el of document.querySelectorAll(semanticSelector)) add(el, false);
    } catch (e) {}
    // Page-wide geometry is deliberately conservative. A side panel is only
    // eligible after coverageCheck proved that exact layer blocked a target.
    try {
      for (const el of document.querySelectorAll('body *')) {
        if (this.geometryOverlay(el, false)) add(el, false);
      }
    } catch (e) {}
    out.sort((a, b) => {
      if (a.provenance !== b.provenance) return a.provenance ? -1 : 1;
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.el.compareDocumentPosition && (a.el.compareDocumentPosition(b.el) & 4)) return 1;
      return -1;
    });
    return out.map(item => item.el);
  },
  closeControl(scope) {
    const usable = el => !!el && this.visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const CLOSE_SEL = 'button[aria-label*="close" i],button[title*="close" i],[aria-label*="close" i][role="button"],a[aria-label*="close" i],[data-dismiss],[data-testid*="close" i],.close,.modal-close,.mfp-close,.dialog-close,button[class*="close" i]';
    let candidates = [];
    try { candidates = Array.from(scope.querySelectorAll(CLOSE_SEL)); } catch (e) {}
    let closer = candidates.find(usable) || null;
    const controls = Array.from(scope.querySelectorAll ? scope.querySelectorAll('button,a[role="button"],[role="button"]') : []).filter(usable);
    if (!closer) {
      const CLOSE_TXT = /^(x|\\u00d7|\\u2715|\\u2716|\\u2573|close|dismiss|no thanks|no,?\\s*thanks)$/i;
      closer = controls.find(el => CLOSE_TXT.test(this.label(el)) || this.closeIconHint(el)) || null;
    }
    if (!closer) {
      const sr = scope.getBoundingClientRect();
      const destructive = /\\b(delete|remove|trash|checkout|pay|purchase|submit)\\b/i;
      const corner = controls.filter(el => {
        const r = el.getBoundingClientRect();
        const label = this.label(el);
        const small = r.width >= 12 && r.height >= 12 && r.width <= 72 && r.height <= 72;
        const nearTop = r.top <= sr.top + Math.min(110, sr.height * 0.22);
        const nearEdge = r.left <= sr.left + Math.min(110, sr.width * 0.25)
          || r.right >= sr.right - Math.min(110, sr.width * 0.25);
        const iconOnly = !!(el.querySelector && el.querySelector('svg,use,i,[data-icon]')) && label.length <= 12;
        return small && nearTop && nearEdge && iconOnly && !destructive.test(label);
      });
      if (corner.length === 1) closer = corner[0];
    }
    return closer;
  },
  dismissTopOverlay() {
    const containers = this.overlayCandidates();
    if (containers.length === 0) return { success: false, reason: 'no_overlay', error: 'No modal/overlay is currently open.' };
    for (const top of containers) {
      const closer = this.closeControl(top);
      if (!closer) continue;
      const label = this.label(closer) || closer.getAttribute('aria-label') || 'close';
      this.fireClick(closer);
      return { success: true, info: { closed: String(label).slice(0, 40), overlay: this.describeEl(top).slice(0, 100) } };
    }
    return { success: false, reason: 'no_close_button', error: 'Found an overlay but no obvious close control. Try the Escape key (press Escape), or click its close control by ref after observing.' };
  },
  // Waits until a CSS selector or a text substring appears (or, with gone=true,
  // disappears). "Appears" means present AND visible, so a spinner that goes
  // display:none counts as gone.
  async waitForCondition(selector, text, gone, timeoutMs) {
    const timeout = Number(timeoutMs || 5000);
    const start = Date.now();
    const probe = () => {
      if (selector) {
        let found = null;
        try { found = document.querySelector(selector); } catch (e) { return { bad: 'Invalid selector: ' + selector }; }
        const present = !!found && this.visible(found);
        return { met: gone ? !present : present };
      }
      if (text) {
        const has = ((document.body && document.body.innerText) || '').toLowerCase().includes(String(text).toLowerCase());
        return { met: gone ? !has : has };
      }
      return { bad: 'Nothing to wait for: give a selector or a text.' };
    };
    while (Date.now() - start < timeout) {
      const v = probe();
      if (v.bad) return { success: false, error: v.bad };
      if (v.met) return { success: true, info: { waitedMs: Date.now() - start } };
      await new Promise(r => setTimeout(r, 150));
    }
    const what = selector ? 'selector ' + selector : 'text "' + text + '"';
    return { success: false, reason: 'timeout', error: 'Timed out after ' + timeout + 'ms waiting for ' + what + (gone ? ' to disappear' : ' to appear') };
  },
  // Resolves the actual <input type=file> for an upload targeted at @ref: the
  // ref itself, its label's control, a descendant, or one in the same form.
  // Parks it in window.__tauUploadInput so the Node side can take an objectId.
  resolveFileInput(ref) {
    const got = this.byRef(ref);
    if (got.error) return { success: false, reason: 'stale_ref', staleKind: this.staleKind(got), error: 'Element @' + ref + ' cannot be resolved (DOM changed). Re-observe.' };
    let el = got.el;
    const isFile = (n) => !!n && n.tagName === 'INPUT' && n.type === 'file';
    if (!isFile(el)) {
      let cand = null;
      if (el.tagName === 'LABEL' && isFile(el.control)) cand = el.control;
      if (!cand && el.querySelector) cand = el.querySelector('input[type=file]');
      if (!cand && el.closest) {
        const lab = el.closest('label');
        if (lab && isFile(lab.control)) cand = lab.control;
      }
      if (!cand && el.closest) {
        const form = el.closest('form');
        if (form) cand = form.querySelector('input[type=file]');
      }
      if (!isFile(cand)) return { success: false, reason: 'no_match', error: '@' + ref + ' is not a file input and no file input was found near it. Observe and target the file input itself (it may appear after clicking an upload button).' };
      el = cand;
    }
    window.__tauUploadInput = el;
    return { success: true, info: { multiple: !!el.multiple, accept: el.getAttribute('accept') || undefined } };
  },
  // HTML5 drag-and-drop fallback (dragstart→dragenter→dragover→drop→dragend
  // with a shared DataTransfer) for when the real mouse drag visibly did
  // nothing — kanban/list libraries listen to these events, not mouse events.
  syntheticDrag(fromRef, toRef) {
    const a = this.byRef(fromRef);
    const b = this.byRef(toRef);
    if (a.error || b.error) return { success: false, reason: 'stale_ref', staleKind: this.staleKind(a.error ? a : b), error: 'Drag refs cannot be resolved (DOM changed). Re-observe.' };
    const src = a.el, dst = b.el;
    const dt = new DataTransfer();
    try { dt.setData('text/plain', (src.innerText || '').slice(0, 100)); } catch (e) {}
    const fire = (el, type) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    };
    fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend');
    return { success: true, info: { synthetic: true } };
  },
  // Draws @N badges over the elements of the last observation so a screenshot
  // shows which visual thing each ref is. Removed right after capture.
  annotate() {
    this.clearAnnotations();
    const state = window.__tauRefState;
    const expectedKey = String((window.__tauPageConfig && window.__tauPageConfig.sessionKey) || '');
    const ids = state && state.version === 2 && state.sessionKey === expectedKey && state.document === document && Array.isArray(state.lastObservedIds)
      ? state.lastObservedIds
      : [];
    if (!(state && state.idToElement instanceof Map) || ids.length === 0) return { success: false, reason: 'none_observed', error: 'Nothing observed yet on this page. Run observe first, then screenshot with annotate.' };
    const wrap = document.createElement('div');
    wrap.id = '__tau_annotations';
    wrap.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    let n = 0;
    ids.forEach(id => {
      const el = state.idToElement.get(id);
      if (!el || !this.liveInTopTree(el)) return;
      const r = this.absRect(el);
      if (r.width < 2 || r.height < 2) return;
      if (r.top > innerHeight || r.left > innerWidth || r.top + r.height < 0 || r.left + r.width < 0) return;
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;border:1.5px solid rgba(220,20,60,.85);border-radius:3px;left:' + Math.round(r.left) + 'px;top:' + Math.round(r.top) + 'px;width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px;';
      const tag = document.createElement('span');
      tag.textContent = '@' + id;
      tag.style.cssText = 'position:absolute;left:-2px;top:-14px;background:rgba(220,20,60,.92);color:#fff;font:600 10px/12px monospace;padding:0 3px;border-radius:2px;';
      box.appendChild(tag);
      wrap.appendChild(box);
      n++;
    });
    document.body.appendChild(wrap);
    return { success: true, info: { labeled: n } };
  },
  clearAnnotations() {
    const w = document.getElementById('__tau_annotations');
    if (w) w.remove();
    return { success: true };
  },
  // Readable-content extraction (the read action): walks the rendered DOM and
  // serializes it as compact markdown — headings, paragraphs, lists, tables,
  // code fences, links as [text](url). This is how the model READS a page
  // (articles, docs, search results) without burning tokens on screenshots.
  readPage(selector, offset, maxChars) {
    let root = null;
    if (selector) {
      try { root = document.querySelector(selector); } catch (e) { return { success: false, error: 'Invalid selector: ' + selector }; }
      if (!root) return { success: false, reason: 'no_match', error: 'No element matches selector: ' + selector };
    } else {
      root = document.querySelector('main,[role="main"],article') || document.body;
      if (root !== document.body && document.body) {
        const mainLen = ((root.innerText || '').length) || 0;
        const bodyLen = ((document.body.innerText || '').length) || 1;
        if (mainLen < bodyLen * 0.25) root = document.body;
      }
    }
    if (!root) return { success: false, error: 'Page has no readable body yet.' };
    const FENCE = String.fromCharCode(96, 96, 96);
    const SKIP = selector ? 'script,style,noscript,template,svg' : 'script,style,noscript,template,svg,nav,header,footer,aside';
    const want = Number(offset || 0) + Number(maxChars || 6000) + 2000;
    const parts = [];
    let len = 0;
    let nodes = 0;
    const push = (s) => { if (s) { parts.push(s); len += s.length; } };
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const hidden = (el) => {
      try {
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
        return el.getClientRects().length === 0 && el.tagName !== 'HTML' && el.tagName !== 'BODY';
      } catch (e) { return false; }
    };
    const BLOCKS = { DIV:1, SECTION:1, ARTICLE:1, MAIN:1, ASIDE:1, HEADER:1, FOOTER:1, UL:1, OL:1, TABLE:1, TBODY:1, THEAD:1, FIGURE:1, FIELDSET:1, DETAILS:1, DL:1, DT:1, DD:1, NAV:1, FORM:1, P:1, LI:1, PRE:1, BLOCKQUOTE:1, HR:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1 };
    const inlineNode = (node) => {
      if (node.nodeType === 3) return String(node.textContent || '').replace(/\\s+/g, ' ');
      if (node.nodeType !== 1) return '';
      const t = node.tagName;
      if (node.matches && node.matches(SKIP)) return '';
      if (hidden(node)) return '';
      if (t === 'BR') return '\\n';
      if (t === 'IMG') { const alt = clean(node.getAttribute('alt')); return alt ? '[image: ' + alt + ']' : ''; }
      if (t === 'A') {
        const label = clean(inline(node));
        let href = '';
        try { href = String(node.href || ''); } catch (e) {}
        if (label && /^https?:/.test(href) && href !== label && label.length < 120) return '[' + label + '](' + href.slice(0, 200) + ')';
        return label;
      }
      return inline(node);
    };
    const inline = (el) => {
      let out = '';
      for (const node of el.childNodes) out += inlineNode(node);
      return out;
    };
    const serialize = (el, depth) => {
      if (len >= want || nodes++ > 20000 || depth > 40) return;
      if (el.nodeType !== 1) return;
      if (el.matches && el.matches(SKIP) && el !== root) return;
      if (el !== root && hidden(el)) return;
      const t = el.tagName;
      const h = { H1:1, H2:2, H3:3, H4:4, H5:5, H6:6 }[t];
      if (h) { push('\\n\\n' + '#'.repeat(h) + ' ' + clean(inline(el)) + '\\n'); return; }
      if (t === 'LI' || t === 'DT' || t === 'DD') {
        // Own text from non-list children only; nested lists serialize after,
        // so items are not duplicated through inline() recursion.
        let liBuf = '';
        const sublists = [];
        for (const node of el.childNodes) {
          if (node.nodeType === 1 && (node.tagName === 'UL' || node.tagName === 'OL')) { sublists.push(node); continue; }
          liBuf += inlineNode(node);
        }
        const s = clean(liBuf);
        if (s) push('\\n- ' + s);
        for (const sub of sublists) serialize(sub, depth + 1);
        return;
      }
      if (t === 'BLOCKQUOTE') { const s = clean(inline(el)); if (s) push('\\n> ' + s + '\\n'); return; }
      if (t === 'PRE') { const s = String(el.innerText || '').trim(); if (s) push('\\n' + FENCE + '\\n' + s.slice(0, 3000) + '\\n' + FENCE + '\\n'); return; }
      if (t === 'HR') { push('\\n---\\n'); return; }
      if (t === 'IMG') { const alt = clean(el.getAttribute('alt')); if (alt) push('\\n[image: ' + alt + ']\\n'); return; }
      if (t === 'TABLE') {
        const rows = el.querySelectorAll('tr');
        let i = 0;
        for (const row of rows) {
          if (i++ >= 40 || len >= want) { push('\\n(...more rows)'); break; }
          const cells = Array.from(row.querySelectorAll('th,td')).map(c => clean(inline(c)));
          if (cells.some(Boolean)) push('\\n| ' + cells.join(' | ') + ' |');
        }
        push('\\n');
        return;
      }
      // Generic container (P, DIV, SECTION, ...): mixed content — direct text
      // and inline children accumulate into a paragraph; block children flush
      // it and recurse, so neither side of the mix is lost.
      let buf = '';
      const flush = () => { const s = clean(buf); buf = ''; if (s) push('\\n' + s + '\\n'); };
      for (const node of el.childNodes) {
        if (len >= want) break;
        if (node.nodeType === 3) { buf += String(node.textContent || '').replace(/\\s+/g, ' '); continue; }
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches(SKIP)) continue;
        if (hidden(node)) continue;
        if (BLOCKS[node.tagName]) { flush(); serialize(node, depth + 1); }
        else buf += inlineNode(node);
      }
      flush();
    };
    serialize(root, 0);
    let content = parts.join('').replace(/\\n{3,}/g, '\\n\\n').trim();
    const total = content.length;
    const from = Math.min(Number(offset || 0), total);
    content = content.slice(from, from + Number(maxChars || 6000));
    return { success: true, url: location.href, title: document.title, content, total, offset: from };
  }
});
`;

/**
 * Anti-detection script, injected via Page.addScriptToEvaluateOnNewDocument so
 * it runs before any page JS on every navigation. Ported and trimmed from Bah
 * browser's STEALTH_SCRIPT. This is why an Electron-embedded browser (or a
 * stealthed Playwright) sails past Google's "unusual traffic" wall while a
 * bare CDP-driven Chrome gets flagged: a remote-debugged Chrome leaks
 * navigator.webdriver, an empty plugin/mediaDevice list, a missing
 * window.chrome, and headless screen/outerWindow zeros — all cheap bot tells.
 * We mask the high-signal ones. `chromeMajor` keeps the spoofed userAgentData
 * brands consistent with the real User-Agent string.
 */
/** Platform identity the spoofs must agree on. */
export interface StealthPlatform {
  /** `navigator.platform` (via Emulation.setUserAgentOverride). */
  navigator: string;
  /** `navigator.userAgentData.platform`. */
  uaData: string;
  /** `platformVersion` from getHighEntropyValues. */
  version: string;
  /** `architecture` from getHighEntropyValues. */
  architecture: string;
  /** `bitness` from getHighEntropyValues. */
  bitness: string;
}

/**
 * Derives the platform identity from the browser's own User-Agent, falling
 * back to the host.
 *
 * This used to be hardcoded to Windows. On a Mac or a Linux box that made the
 * spoof *worse* than no spoof: the UA header said "Macintosh" while
 * navigator.platform said "Win32" and userAgentData said "Windows" — a
 * contradiction no real browser produces, and one of the cheapest checks an
 * anti-bot script can run.
 */
export function stealthPlatformFromUserAgent(
  userAgent?: string,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): StealthPlatform {
  const architecture = /^arm/i.test(hostArch) ? "arm" : "x86";
  const bitness = /64/.test(hostArch) ? "64" : "32";
  const ua = userAgent ?? "";
  const isMac = /Mac OS X|Macintosh/i.test(ua) || (!ua && hostPlatform === "darwin");
  const isWindows = /Windows NT/i.test(ua) || (!ua && hostPlatform === "win32");
  if (isMac) {
    const raw = ua.match(/Mac OS X ([0-9_.]+)/)?.[1] ?? "10_15_7";
    return {
      navigator: "MacIntel",
      uaData: "macOS",
      version: raw.replace(/_/g, "."),
      architecture,
      bitness,
    };
  }
  if (isWindows) {
    const nt = ua.match(/Windows NT ([0-9.]+)/)?.[1] ?? "10.0";
    return {
      navigator: "Win32",
      uaData: "Windows",
      // Chrome reports the platform version, not the NT version, and pads it
      // to three parts.
      version: `${nt.split(".")[0] ?? "10"}.0.0`,
      architecture,
      bitness,
    };
  }
  return {
    navigator: hostArch === "arm64" ? "Linux aarch64" : "Linux x86_64",
    uaData: "Linux",
    version: "",
    architecture,
    bitness,
  };
}

export function buildStealthScript(
  chromeMajor: number,
  platform: StealthPlatform = stealthPlatformFromUserAgent(),
): string {
  const major =
    Number.isInteger(chromeMajor) && chromeMajor > 0 ? chromeMajor : 131;
  return `
(function(){
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        ];
        Object.defineProperty(arr, 'item', { value: (i) => arr[i], enumerable: false });
        Object.defineProperty(arr, 'namedItem', { value: (n) => arr.find(p => p.name === n), enumerable: false });
        return arr;
      },
      configurable: true,
    });
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: [
          { brand: 'Google Chrome', version: '${major}' },
          { brand: 'Not;A=Brand', version: '8' },
          { brand: 'Chromium', version: '${major}' }
        ],
        mobile: false,
        platform: '${platform.uaData}',
        getHighEntropyValues: () => Promise.resolve({ platform: '${platform.uaData}', platformVersion: '${platform.version}', architecture: '${platform.architecture}', bitness: '${platform.bitness}', model: '', uaFullVersion: '${major}.0.0.0' }),
      }),
      configurable: true
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', UPDATE: 'update' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', WIN: 'win' },
    };
    if (!window.chrome.csi) window.chrome.csi = function() { return { onloadT: Date.now(), pageT: 1, startE: Date.now() - 1000, tran: 15 }; };
    if (!window.chrome.loadTimes) window.chrome.loadTimes = function() { return { commitLoadTime: Date.now()/1000, finishDocumentLoadTime: Date.now()/1000, finishLoadTime: Date.now()/1000, firstPaintTime: Date.now()/1000, navigationType: 'Other', requestTime: Date.now()/1000-1, startLoadTime: Date.now()/1000, wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }; };
    if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (params) => params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQuery.call(navigator.permissions, params);
    }
    try {
      const gp = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel(R) Iris(TM) Graphics 6100';
        return gp.call(this, p);
      };
      if (window.WebGL2RenderingContext) {
        const gp2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(p) {
          if (p === 37445) return 'Intel Inc.';
          if (p === 37446) return 'Intel(R) Iris(TM) Graphics 6100';
          return gp2.call(this, p);
        };
      }
    } catch(e) {}
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    if (window.Notification) { try { Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }); } catch(e) {} }
    try {
      if (window.outerWidth === 0) Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
      if (window.outerHeight === 0) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 80, configurable: true });
      if (screen.width === 0) Object.defineProperty(screen, 'width', { get: () => 1920, configurable: true });
      if (screen.height === 0) Object.defineProperty(screen, 'height', { get: () => 1080, configurable: true });
    } catch(e) {}
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const orig = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = async () => {
        const list = await orig();
        if (list.length === 0) return [
          { kind: 'audioinput', deviceId: 'default', groupId: '1', label: '' },
          { kind: 'videoinput', deviceId: 'default', groupId: '2', label: '' },
          { kind: 'audiooutput', deviceId: 'default', groupId: '1', label: '' },
        ];
        return list;
      };
    }
    if (!navigator.getBattery) {
      navigator.getBattery = () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
    }
  } catch(e) {}
})()
`;
}

const TEXT_CAP = 70;

function capText(value: string | undefined): string | undefined {
  if (!value) return value;
  const t = value.replace(/\s+/g, " ").trim();
  return t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP - 1)}…` : t;
}

/**
 * Token-economy pruning for huge pages (ported from Bah's "payload razor"):
 * (1) cap per-element text/aria; (2) merge parent/child duplicates that share
 * the same label at the same exact center point; (3) collapse runs of 6+
 * consecutive same-signature elements into 3 representatives, marking the
 * third with repeatNote = how many were omitted. Ref ids are preserved (the
 * in-page registry keeps every element), so pruned output has id gaps.
 */
export function prunePayloadElements(
  elements: InteractiveElement[],
): InteractiveElement[] {
  for (const e of elements) {
    e.text = capText(e.text) ?? "";
    if (e.aria) e.aria = capText(e.aria);
  }

  // Positional parent/child duplicate: same label at the same exact center.
  // Exact position (not a grid) so adjacent, distinct list items never merge.
  const seen = new Set<string>();
  const dedup: InteractiveElement[] = [];
  for (const e of elements) {
    const t = (e.text || "").toLowerCase();
    const posKey = `${t}|${e.x}|${e.y}`;
    if (t && seen.has(posKey)) continue;
    seen.add(posKey);
    dedup.push(e);
  }

  const sig = (e: InteractiveElement) =>
    `${e.tag}|${e.role || ""}|${(e.text || "").toLowerCase()}`;
  const out: InteractiveElement[] = [];
  for (let i = 0; i < dedup.length; ) {
    let j = i + 1;
    while (j < dedup.length && sig(dedup[j]!) === sig(dedup[i]!)) j++;
    const run = j - i;
    if (run >= 6) {
      out.push(dedup[i]!, dedup[i + 1]!);
      dedup[i + 2]!.repeatNote = run - 3;
      out.push(dedup[i + 2]!);
    } else {
      for (let k = i; k < j; k++) out.push(dedup[k]!);
    }
    i = j;
  }
  return out;
}

/**
 * Detects pages where the agent should stop and ask the user to intervene
 * (CAPTCHA / verification walls, login walls). Ported from Bah's
 * agent-login-policy heuristics, trimmed to the high-confidence signals.
 */
export function detectBlocker(
  observation: ObservedState,
): { kind: "captcha" | "login"; hint: string } | null {
  const page = [
    observation.title,
    observation.text_sample,
    observation.interactive_elements
      .map((e) => `${e.text || ""} ${e.aria || ""} ${e.placeholder || ""}`)
      .join(" "),
  ]
    .join(" ")
    .toLowerCase();

  const CAPTCHA =
    /\b(captcha|recaptcha|hcaptcha|not\s*a\s*robot|verify\s*you\s*are\s*human|prove\s*you'?re\s*human|verify\s*you'?re\s*human|checking\s*your\s*browser|are\s*you\s*a\s*robot|unusual\s*traffic|security\s*check)\b/i;
  if (CAPTCHA.test(page)) {
    return {
      kind: "captcha",
      hint: "This page is showing a human-verification challenge. Ask the user to solve it manually in the browser window, then continue.",
    };
  }

  const LOGIN_BLOCK =
    /\b(log\s*in\s*to\s*continue|sign\s*in\s*required|login\s*required|please\s*sign\s*in|you\s*must\s*be\s*logged\s*in|sign\s*in\s*to\s*continue)\b/i;
  if (LOGIN_BLOCK.test(page)) {
    return {
      kind: "login",
      hint: "This page requires signing in. Do not enter credentials yourself; ask the user to log in manually in the browser window, then continue.",
    };
  }
  return null;
}
