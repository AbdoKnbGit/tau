/**
 * Pick: the user points at the element they mean.
 *
 * Some targets are faster to point at than to describe: "this price", "the
 * second chart", "why is this misaligned". While a pick runs, the visible page
 * outlines whatever the pointer is over, and the element the user clicks comes
 * back to the model; the observation that follows lists it first with a ref.
 *
 * The page must not be able to tell a pick from nothing at all. Clicks and
 * presses are stopped before the page sees them, so picking a link never also
 * follows it. Pointer movement and hover events are stopped too: a page that
 * reacts to hovering (Wikipedia's reference tooltips, link previews) would
 * otherwise pop up an element under the pointer, which then gets picked and
 * vanishes. A menu that is already open stays open, since it never hears the
 * pointer leave; CSS :hover still shows. What is picked is what lies under
 * the click, and scrolling re-aims at what is under the still pointer.
 * Frames are made pointer-transparent for the duration, so a click can never
 * land inside one: a same-origin frame is looked into, a cross-origin one is
 * picked as a whole.
 *
 * Design adapted from Browsentic's A-Eye picker (https://github.com/imshaikot/browsentic),
 * MIT License, Copyright (c) 2026 Shahriar. Everything is styled through the
 * CSSOM rather than inline <style> markup, so a page's style-src policy cannot
 * blank the outline.
 */

/** How long a pick waits for a person before giving up. */
export const PICK_TIMEOUT_MS = 120_000;

export interface PickedElement {
  tag: string;
  /** The element's opening tag with its identifying attributes, for finding it in source. */
  openTag: string;
  /** CSS path from the nearest id (or the document root of its frame). */
  selector: string;
  /** Rendered text, cut to 300 characters. */
  text: string;
  textLength: number;
  /** Top-viewport CSS pixels. */
  box: { x: number; y: number; w: number; h: number };
  /** CSS path of the same-origin frame the element sits in. */
  inFrame?: string;
  /** The pick landed on a cross-origin frame, whose content cannot be read. */
  crossOrigin?: boolean;
  src?: string;
}

export type PickOutcome =
  | { picked: PickedElement }
  | { cancelled: true }
  | { timedOut: true };

/** Ends a pick that is still waiting, as if the user pressed Escape. */
export const CANCEL_PICK_SCRIPT =
  "(function(){ var p = window.__tauPick; if (p && typeof p.cancel === 'function') p.cancel(); return true; })()";

/**
 * One expression that resolves when the user clicks an element, presses Escape
 * or the timeout passes. The clicked element is parked in
 * `window.__tauPickTarget` for the next observation to give it a ref.
 */
export function buildPickScript(hint: string, timeoutMs: number = PICK_TIMEOUT_MS): string {
  const ask = hint.replace(/\s+/g, " ").trim().slice(0, 120) || "Click the element you mean";
  const message = `Tau: ${ask}   (Esc cancels, Up arrow picks the parent)`;
  return `(function () {
  var MESSAGE = ${JSON.stringify(message)};
  var TIMEOUT = ${Math.max(1000, Math.round(timeoutMs))};
  if (window.__tauPick && typeof window.__tauPick.cancel === 'function') {
    try { window.__tauPick.cancel(); } catch (e) {}
  }
  return new Promise(function (resolve) {
    var doc = document;
    var hovered = null;
    var done = false;
    var timer = null;
    var lastX = -1, lastY = -1;
    // The outline was moved with the keyboard (Up arrow), not by the pointer.
    var widened = false;

    var host = doc.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    var box = doc.createElement('div');
    box.style.cssText = 'position:fixed;display:none;box-sizing:border-box;pointer-events:none;border:2px solid #ff7a3d;border-radius:3px;background:rgba(255,122,61,.18);';
    var chip = doc.createElement('div');
    chip.style.cssText = 'position:absolute;left:-2px;top:-20px;padding:1px 6px;border-radius:3px;background:#ff7a3d;color:#1a0f08;font:600 11px/16px monospace;white-space:nowrap;';
    box.appendChild(chip);
    var bar = doc.createElement('div');
    bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:92vw;padding:6px 14px;border-radius:999px;background:rgba(20,14,10,.92);color:#f4ece6;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;box-shadow:0 8px 30px rgba(0,0,0,.45);';
    bar.textContent = MESSAGE;
    root.appendChild(box);
    root.appendChild(bar);
    (doc.documentElement || doc.body).appendChild(host);

    var css = 'html,html *{cursor:crosshair !important;user-select:none !important}iframe,frame{pointer-events:none !important}';
    var sheet = null;
    var styleEl = null;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.concat([sheet]);
    } catch (e) {
      sheet = null;
      try {
        styleEl = doc.createElement('style');
        styleEl.textContent = css;
        (doc.head || doc.documentElement).appendChild(styleEl);
      } catch (e2) { styleEl = null; }
    }

    function isFrame(el) {
      var tag = String((el && el.tagName) || '').toUpperCase();
      return tag === 'IFRAME' || tag === 'FRAME';
    }
    // Box in top-viewport pixels, through any same-origin frames.
    function topRect(el) {
      var r = el.getBoundingClientRect();
      var x = r.left, y = r.top;
      var view = el.ownerDocument && el.ownerDocument.defaultView;
      var guard = 0;
      while (view && view !== window && view.frameElement && guard++ < 5) {
        var fe = view.frameElement;
        var fr = fe.getBoundingClientRect();
        x += fr.left + (fe.clientLeft || 0);
        y += fr.top + (fe.clientTop || 0);
        view = view.parent;
      }
      return { left: x, top: y, width: r.width, height: r.height };
    }
    // A frame inside el (or el itself) that contains the point.
    function frameIn(el, x, y) {
      var list = isFrame(el) ? [el] : [];
      try { list = list.concat(Array.prototype.slice.call(el.querySelectorAll('iframe,frame'))); } catch (e) {}
      for (var i = list.length - 1; i >= 0; i--) {
        var r = list[i].getBoundingClientRect();
        if (r.width > 1 && r.height > 1 && x >= r.left && x < r.right && y >= r.top && y < r.bottom) return list[i];
      }
      return null;
    }
    // Frames are pointer-transparent while picking, so the hit is whatever
    // holds the frame; look into a same-origin frame for the real element.
    function resolveAt(x, y) {
      var under = doc.elementFromPoint(x, y);
      if (!under || under === host) return null;
      var frame = frameIn(under, x, y);
      var depth = 0;
      while (frame && depth++ < 3) {
        var inner = null;
        try { inner = frame.contentDocument; } catch (e) { inner = null; }
        if (!inner) return frame;
        var fr = frame.getBoundingClientRect();
        x -= fr.left + (frame.clientLeft || 0);
        y -= fr.top + (frame.clientTop || 0);
        var hit = null;
        try { hit = inner.elementFromPoint(x, y); } catch (e) { hit = null; }
        if (!hit) return frame;
        under = hit;
        frame = isFrame(hit) ? hit : null;
      }
      return under;
    }
    // What a click means: the control holding the point (a link, a button, a
    // tab), or for text inside nested inline wrappers, the element they belong
    // to (a heading, a cell). An SVG icon counts as its <svg>. A wrapper with
    // text of its own, like a price inside a card, stays as it is.
    var CONTROL = 'a[href],button,summary,label,select,textarea,input,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"]';
    var PHRASING = { SPAN: 1, B: 1, I: 1, EM: 1, STRONG: 1, SMALL: 1, MARK: 1, SUB: 1, SUP: 1, ABBR: 1, CITE: 1, Q: 1, S: 1, U: 1, FONT: 1, TIME: 1, BDI: 1, BDO: 1, DATA: 1, DFN: 1, KBD: 1, SAMP: 1, VAR: 1 };
    function squash(text) { return String(text || '').replace(/\\s+/g, ' ').trim(); }
    function meaningful(el) {
      if (!el || el.nodeType !== 1) return el;
      var node = el;
      while (node.ownerSVGElement) node = node.ownerSVGElement;
      var control = null;
      try { control = node.closest(CONTROL); } catch (e) { control = null; }
      if (control) return control;
      var guard = 0;
      while (PHRASING[String(node.tagName || '').toUpperCase()] && node.parentElement && guard++ < 6) {
        var up = node.parentElement;
        if (up.childNodes.length > 6 || squash(up.textContent) !== squash(node.textContent)) break;
        node = up;
      }
      return node;
    }
    function parentOf(el) {
      var parent = el.parentElement;
      var top = el.ownerDocument && el.ownerDocument.documentElement;
      if (parent && parent !== top) return parent;
      var view = el.ownerDocument && el.ownerDocument.defaultView;
      return view && view !== window && view.frameElement ? view.frameElement : null;
    }
    function label(el, r) {
      var tag = String(el.tagName || '').toLowerCase();
      var id = el.id ? '#' + el.id : '';
      var cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      return (tag + id + cls).slice(0, 60) + '  ' + Math.round(r.width) + 'x' + Math.round(r.height);
    }
    function draw() {
      if (!hovered || !hovered.isConnected) { box.style.display = 'none'; return; }
      var r = topRect(hovered);
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = Math.max(2, r.width) + 'px';
      box.style.height = Math.max(2, r.height) + 'px';
      chip.style.top = r.top < 22 ? (Math.max(2, r.height) + 2) + 'px' : '-20px';
      chip.textContent = label(hovered, r);
    }
    function aim(el) {
      if (!el || el === host || el === doc.documentElement) return;
      hovered = meaningful(el);
      draw();
    }
    function cssPath(el) {
      var parts = [];
      var node = el;
      var top = el.ownerDocument && el.ownerDocument.documentElement;
      for (var i = 0; node && node.nodeType === 1 && node !== top && i < 12; i++) {
        var tag = String(node.tagName).toLowerCase();
        if (node.id) {
          parts.unshift(tag + '#' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id));
          break;
        }
        var parent = node.parentElement;
        if (!parent) { parts.unshift(tag); break; }
        var same = 0, index = 0;
        for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
          if (c.tagName === node.tagName) { same++; if (c === node) index = same; }
        }
        parts.unshift(same > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
        node = parent;
      }
      return parts.join(' > ');
    }
    function openTag(el) {
      var keep = /^(id|class|name|type|role|href|src|alt|title|for|placeholder|aria-label|data-[\\w-]+)$/i;
      var out = '<' + String(el.tagName).toLowerCase();
      var attrs = el.attributes || [];
      for (var i = 0; i < attrs.length && out.length < 280; i++) {
        var a = attrs[i];
        if (!keep.test(a.name)) continue;
        var v = String(a.value).replace(/\\s+/g, ' ').trim();
        if (v.length > 80) v = v.slice(0, 77) + '...';
        out += ' ' + a.name + '="' + v.replace(/"/g, '&quot;') + '"';
      }
      return out + '>';
    }
    function describe(el) {
      var r = topRect(el);
      var text = '';
      try { text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(); } catch (e) { text = ''; }
      var info = {
        tag: String(el.tagName || '').toLowerCase(),
        openTag: openTag(el),
        selector: cssPath(el),
        text: text.slice(0, 300),
        textLength: text.length,
        box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      };
      if (isFrame(el)) {
        var readable = null;
        try { readable = el.contentDocument; } catch (e) { readable = null; }
        if (!readable) info.crossOrigin = true;
        info.src = String(el.src || '').slice(0, 200);
      }
      var view = el.ownerDocument && el.ownerDocument.defaultView;
      if (view && view !== window && view.frameElement) info.inFrame = cssPath(view.frameElement);
      return info;
    }

    function mute(e) { e.stopPropagation(); e.stopImmediatePropagation(); }
    function swallow(e) { e.preventDefault(); mute(e); }
    function onMove(e) {
      mute(e);
      lastX = e.clientX;
      lastY = e.clientY;
      widened = false;
      aim(resolveAt(lastX, lastY));
    }
    // Scrolling moves the page under a still pointer: aim at what is under it
    // now, unless the user chose a parent with the keyboard.
    function onScroll() {
      if (!widened && lastX >= 0) aim(resolveAt(lastX, lastY));
      else draw();
    }
    function onClick(e) {
      swallow(e);
      // What lies under the click is what was meant, unless the user widened
      // the outline with the keyboard and is confirming that choice.
      var target = widened && hovered ? hovered : meaningful(resolveAt(e.clientX, e.clientY));
      if (target && target !== doc.documentElement) finish({ picked: target });
    }
    function onKey(e) {
      if (e.key === 'Escape') { swallow(e); finish({ cancelled: true }); return; }
      if (e.key === 'ArrowUp' && hovered) {
        swallow(e);
        var up = parentOf(hovered);
        if (up) { hovered = up; widened = true; draw(); }
        return;
      }
      if (e.key === 'Enter' && hovered) { swallow(e); finish({ picked: hovered }); }
    }
    function onKeyUp(e) {
      if (e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'Enter') swallow(e);
    }
    var listeners = [
      ['pointermove', onMove, { capture: true, passive: true }],
      ['mousemove', mute, true],
      ['pointerover', mute, true],
      ['pointerout', mute, true],
      ['pointerenter', mute, true],
      ['pointerleave', mute, true],
      ['mouseover', mute, true],
      ['mouseout', mute, true],
      ['mouseenter', mute, true],
      ['mouseleave', mute, true],
      ['pointerdown', mute, true],
      ['pointerup', mute, true],
      ['mousedown', swallow, true],
      ['mouseup', mute, true],
      ['click', onClick, true],
      ['dblclick', swallow, true],
      ['auxclick', swallow, true],
      ['contextmenu', swallow, true],
      ['keydown', onKey, true],
      ['keyup', onKeyUp, true],
      ['scroll', onScroll, { capture: true, passive: true }],
      ['resize', onScroll, { passive: true }],
    ];

    var api = { cancel: function () { finish({ cancelled: true }); } };
    function finish(outcome) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      listeners.forEach(function (l) { window.removeEventListener(l[0], l[1], l[2]); });
      try { host.remove(); } catch (e) {}
      if (sheet) {
        try { doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(function (s) { return s !== sheet; }); } catch (e) {}
      }
      if (styleEl) { try { styleEl.remove(); } catch (e) {} }
      if (window.__tauPick === api) {
        try { delete window.__tauPick; } catch (e) { window.__tauPick = undefined; }
      }
      if (outcome.picked) {
        window.__tauPickTarget = outcome.picked;
        resolve({ picked: describe(outcome.picked) });
      } else {
        resolve(outcome);
      }
    }
    listeners.forEach(function (l) { window.addEventListener(l[0], l[1], l[2]); });
    window.__tauPick = api;
    timer = setTimeout(function () { finish({ timedOut: true }); }, TIMEOUT);
  });
})()`;
}

/** The picked element as the model reads it, beside the observation. */
export function formatPicked(picked: PickedElement): string {
  const lines = ["Picked element:", `  tag: ${picked.openTag}`];
  lines.push(
    `  selector: ${picked.selector || picked.tag}${picked.inFrame ? ` (inside the frame ${picked.inFrame})` : ""}`,
  );
  lines.push(
    `  box: ${picked.box.w}x${picked.box.h} at (${picked.box.x}, ${picked.box.y}) in the viewport`,
  );
  if (picked.text) {
    const cut =
      picked.textLength > picked.text.length
        ? ` (first ${picked.text.length} of ${picked.textLength} characters)`
        : "";
    lines.push(`  text: "${picked.text}"${cut}`);
  }
  if (picked.crossOrigin) {
    lines.push(
      `  This is a cross-origin frame${picked.src ? ` (${picked.src})` : ""}: nothing inside it can be read or picked from this page.`,
    );
  }
  return lines.join("\n");
}
