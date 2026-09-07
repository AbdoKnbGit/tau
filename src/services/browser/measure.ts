/**
 * Measured facts about the rendered page.
 *
 * WHY: reading `Hero.tsx` tells you a class name was written; it does not tell
 * you which colour actually painted, whether the webfont loaded or silently
 * fell back, that a card overflows the viewport by 40px, or that three product
 * images 404'd. An agent that has only read the source and lost its screenshot
 * will describe the design it *expects*. This returns numbers instead, so a
 * claim about appearance can rest on something that was measured.
 *
 * Complements `VisualDesignAudit`, which scans source files and recommends
 * browser verification — this is that verification.
 *
 * Everything is bounded (element walks, array lengths, string slices) and
 * nothing throws: a page that blocks a property yields a smaller report, never
 * a failed action.
 */

/**
 * Colour maths, kept as source text so the page and the tests run the exact
 * same code. Building the page script from `Function.prototype.toString` would
 * break the moment the bundler renames a cross-referenced helper.
 */
const COLOR_HELPERS_JS = `
function parseCssColor(value) {
  if (!value) return null;
  var text = String(value).trim().toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  var rgb = text.match(/^rgba?\\(([^)]+)\\)$/);
  if (rgb) {
    var parts = rgb[1].split(/[\\s,\\/]+/).filter(function (p) { return p.length > 0; });
    if (parts.length < 3) return null;
    var channels = [];
    for (var i = 0; i < 3; i++) {
      var raw = parts[i];
      var n = raw.indexOf('%') >= 0 ? (parseFloat(raw) * 255) / 100 : parseFloat(raw);
      if (!isFinite(n)) return null;
      channels.push(Math.max(0, Math.min(255, n)));
    }
    var alpha = 1;
    if (parts.length > 3) {
      var rawAlpha = parts[3];
      alpha = rawAlpha.indexOf('%') >= 0 ? parseFloat(rawAlpha) / 100 : parseFloat(rawAlpha);
      if (!isFinite(alpha)) alpha = 1;
    }
    return [channels[0], channels[1], channels[2], Math.max(0, Math.min(1, alpha))];
  }
  var hex = text.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    var digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      var expanded = '';
      for (var j = 0; j < digits.length; j++) expanded += digits[j] + digits[j];
      digits = expanded;
    }
    if (digits.length !== 6 && digits.length !== 8) return null;
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
      digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1
    ];
  }
  return null;
}
function relativeLuminance(color) {
  var channel = function (value) {
    var c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}
function blendOver(foreground, background) {
  var alpha = foreground[3];
  if (alpha >= 1) return [foreground[0], foreground[1], foreground[2], 1];
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
    1
  ];
}
function contrastRatio(foreground, background) {
  var a = relativeLuminance(blendOver(foreground, background));
  var b = relativeLuminance(background);
  var light = Math.max(a, b);
  var dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}
function contrastThreshold(fontSizePx, fontWeight) {
  var large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  return large ? 3 : 4.5;
}
`;

export interface MeasuredColor {
  color: string;
  /** Share of measured painted area, 0-1. */
  share: number;
}

export interface MeasuredFont {
  family: string;
  elements: number;
  /**
   * False when the family did not resolve and the text is really rendering in
   * a fallback. Measured from text metrics, not from `document.fonts.check()`:
   * that returns true for any family with no `@font-face` rule, so it says
   * "available" for a font the machine has never heard of.
   */
  available: boolean;
}

export interface ContrastFinding {
  text: string;
  ratio: number;
  required: number;
  color: string;
  background: string;
  fontSize: number;
}

export interface MeasureResult {
  viewport: {
    width: number;
    height: number;
    dpr: number;
    scrollY: number;
    pageHeight: number;
  };
  document: { title: string; url: string; lang: string; charset: string };
  elements: { total: number; measured: number; visible: number };
  colors: {
    /** Resolved background of the page itself (body, falling back to html). */
    page?: string;
    backgrounds: MeasuredColor[];
    text: MeasuredColor[];
  };
  fonts: MeasuredFont[];
  contrast: { checked: number; failures: ContrastFinding[] };
  images: {
    total: number;
    broken: Array<{ src: string; alt: string }>;
    oversized: Array<{ src: string; natural: string; displayed: string }>;
  };
  overflow: Array<{ element: string; overflowPx: number }>;
  animations: { running: number; names: string[] };
  landmarks: Array<{ element: string; box: string }>;
  notes: string[];
}

/**
 * One expression returning a {@link MeasureResult}. Caps: 1500 elements walked,
 * 400 text nodes checked for contrast, 300 images, 10 entries per finding list.
 */
export const MEASURE_SCRIPT = `(function(){
${COLOR_HELPERS_JS}
  var notes = [];
  var out = {
    viewport: { width: 0, height: 0, dpr: 1, scrollY: 0, pageHeight: 0 },
    document: { title: '', url: '', lang: '', charset: '' },
    elements: { total: 0, measured: 0, visible: 0 },
    colors: { backgrounds: [], text: [] },
    fonts: [],
    contrast: { checked: 0, failures: [] },
    images: { total: 0, broken: [], oversized: [] },
    overflow: [],
    animations: { running: 0, names: [] },
    landmarks: [],
    notes: notes
  };
  var describe = function (el) {
    try {
      var cls = typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      return (el.tagName || '?').toLowerCase() + (el.id ? '#' + el.id : '') + cls;
    } catch (e) { return '?'; }
  };
  var shortSrc = function (value) {
    var src = String(value || '');
    if (src.indexOf('data:') === 0) return 'data:' + src.slice(5, 20) + '…';
    return src.length > 120 ? src.slice(0, 117) + '…' : src;
  };
  var key = function (color) {
    return 'rgb(' + Math.round(color[0]) + ', ' + Math.round(color[1]) + ', ' + Math.round(color[2]) + ')';
  };
  var top = function (map, limit, total) {
    var rows = [];
    for (var name in map) if (Object.prototype.hasOwnProperty.call(map, name)) {
      rows.push({ color: name, share: total > 0 ? map[name] / total : 0 });
    }
    rows.sort(function (a, b) { return b.share - a.share; });
    return rows.slice(0, limit).map(function (row) {
      return { color: row.color, share: Math.round(row.share * 1000) / 1000 };
    });
  };
  try {
    var doc = document;
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    out.viewport = {
      width: vw,
      height: vh,
      dpr: window.devicePixelRatio || 1,
      scrollY: Math.round(window.scrollY || 0),
      pageHeight: doc.documentElement ? doc.documentElement.scrollHeight : 0
    };
    out.document = {
      title: doc.title || '',
      url: location.href,
      lang: (doc.documentElement && doc.documentElement.lang) || '',
      charset: doc.characterSet || ''
    };
    var all = doc.body ? doc.body.querySelectorAll('*') : [];
    out.elements.total = all.length;
    var cap = all.length < 1500 ? all.length : 1500;
    if (all.length > cap) notes.push('walked the first ' + cap + ' of ' + all.length + ' elements');
    var bgArea = {}, bgTotal = 0, textArea = {}, textTotal = 0, fontUse = {};
    var visible = 0, checkedText = 0;
    var backgroundOf = function (el) {
      var node = el, guard = 0;
      while (node && guard++ < 8) {
        var style;
        try { style = getComputedStyle(node); } catch (e) { return [255, 255, 255, 1]; }
        var color = parseCssColor(style.backgroundColor);
        if (color && color[3] > 0.05) return [color[0], color[1], color[2], 1];
        node = node.parentElement;
      }
      return [255, 255, 255, 1];
    };
    var hasOwnText = function (el) {
      var kids = el.childNodes, seen = 0;
      for (var n = 0; n < kids.length && n < 12; n++) {
        var node = kids[n];
        if (node.nodeType === 3 && String(node.nodeValue || '').trim().length > 1) seen++;
      }
      return seen > 0;
    };
    for (var i = 0; i < cap; i++) {
      var el = all[i];
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden') continue;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!(rect.width > 0 && rect.height > 0)) continue;
      visible++;
      var area = rect.width * rect.height;
      var background = parseCssColor(cs.backgroundColor);
      if (background && background[3] > 0.05) {
        var bgName = key(background);
        bgArea[bgName] = (bgArea[bgName] || 0) + area;
        bgTotal += area;
      }
      var family = String(cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
      if (family) fontUse[family] = (fontUse[family] || 0) + 1;
      if (rect.right > vw + 1 && cs.position !== 'fixed' && cs.position !== 'sticky' && out.overflow.length < 10) {
        out.overflow.push({ element: describe(el), overflowPx: Math.round(rect.right - vw) });
      }
      if (hasOwnText(el)) {
        var textColor = parseCssColor(cs.color);
        if (textColor) {
          var textName = key(textColor);
          var textWeight = rect.width * rect.height;
          textArea[textName] = (textArea[textName] || 0) + textWeight;
          textTotal += textWeight;
          if (checkedText < 400) {
            checkedText++;
            var bg = backgroundOf(el);
            var size = parseFloat(cs.fontSize) || 16;
            var weight = parseInt(cs.fontWeight, 10);
            if (!isFinite(weight)) weight = cs.fontWeight === 'bold' ? 700 : 400;
            var ratio = contrastRatio(textColor, bg);
            var required = contrastThreshold(size, weight);
            if (ratio < required && out.contrast.failures.length < 8) {
              out.contrast.failures.push({
                text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
                ratio: Math.round(ratio * 100) / 100,
                required: required,
                color: key(textColor),
                background: key(bg),
                fontSize: Math.round(size * 10) / 10
              });
            }
          }
        }
      }
    }
    out.elements.measured = cap;
    out.elements.visible = visible;
    out.contrast.checked = checkedText;
    out.colors.backgrounds = top(bgArea, 6, bgTotal);
    out.colors.text = top(textArea, 5, textTotal);
    // The page's own background is not inside body's descendants, so the walk
    // above can never see it — and it is the colour a reader would name first.
    try {
      var pageBg = null;
      var roots = [doc.body, doc.documentElement];
      for (var b = 0; b < roots.length && !pageBg; b++) {
        if (!roots[b]) continue;
        var rootColor = parseCssColor(getComputedStyle(roots[b]).backgroundColor);
        if (rootColor && rootColor[3] > 0.05) pageBg = key(rootColor);
      }
      if (pageBg) out.colors.page = pageBg;
    } catch (e) { /* page background is best-effort */ }
    var families = [];
    for (var name in fontUse) if (Object.prototype.hasOwnProperty.call(fontUse, name)) {
      families.push({ family: name, elements: fontUse[name] });
    }
    families.sort(function (a, b) { return b.elements - a.elements; });
    // Availability by text metrics: a family that did not resolve renders
    // identically to its fallback, so identical widths against EVERY generic
    // baseline mean the requested font is not the one on screen.
    var measureContext = null;
    try {
      var canvas = doc.createElement('canvas');
      measureContext = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    } catch (e) { measureContext = null; }
    var probeText = 'mmmmmwwwwwiiiii0123456789';
    var widthIn = function (fontSpec) {
      if (!measureContext) return null;
      try {
        measureContext.font = '72px ' + fontSpec;
        return measureContext.measureText(probeText).width;
      } catch (e) { return null; }
    };
    var generics = { serif: 1, 'sans-serif': 1, monospace: 1, cursive: 1, fantasy: 1, 'system-ui': 1, 'ui-monospace': 1, 'ui-sans-serif': 1, 'ui-serif': 1, inherit: 1, initial: 1 };
    out.fonts = families.slice(0, 6).map(function (row) {
      var available = true;
      var quoted = '"' + String(row.family).replace(/["\\\\]/g, '') + '"';
      if (!Object.prototype.hasOwnProperty.call(generics, row.family.toLowerCase()) && measureContext) {
        var baselines = ['monospace', 'sans-serif', 'serif'];
        var differs = false;
        for (var g = 0; g < baselines.length; g++) {
          var base = widthIn(baselines[g]);
          var withFamily = widthIn(quoted + ', ' + baselines[g]);
          if (base == null || withFamily == null) { differs = true; break; }
          if (Math.abs(withFamily - base) > 0.5) { differs = true; break; }
        }
        available = differs;
      }
      return { family: row.family, elements: row.elements, available: available };
    });
    var images = doc.images || [];
    out.images.total = images.length;
    var imageCap = images.length < 300 ? images.length : 300;
    for (var k = 0; k < imageCap; k++) {
      var img = images[k];
      try {
        if (img.complete && img.naturalWidth === 0) {
          if (out.images.broken.length < 10) {
            out.images.broken.push({ src: shortSrc(img.currentSrc || img.src), alt: String(img.alt || '').slice(0, 40) });
          }
          continue;
        }
        var box = img.getBoundingClientRect();
        if (box.width > 0 && img.naturalWidth > box.width * (window.devicePixelRatio || 1) * 2) {
          if (out.images.oversized.length < 6) {
            out.images.oversized.push({
              src: shortSrc(img.currentSrc || img.src),
              natural: img.naturalWidth + '×' + img.naturalHeight,
              displayed: Math.round(box.width) + '×' + Math.round(box.height)
            });
          }
        }
      } catch (e) { /* one bad image must not end the measurement */ }
    }
    try {
      if (typeof doc.getAnimations === 'function') {
        var running = doc.getAnimations();
        out.animations.running = running.length;
        var names = {};
        for (var a = 0; a < running.length && a < 40; a++) {
          var anim = running[a];
          var label = anim.animationName || anim.transitionProperty
            || (anim.effect && anim.effect.target ? describe(anim.effect.target) : '')
            || 'animation';
          names[label] = 1;
        }
        out.animations.names = Object.keys(names).slice(0, 6);
      } else {
        notes.push('this engine has no document.getAnimations()');
      }
    } catch (e) { /* animation inspection is best-effort */ }
    try {
      var marks = doc.querySelectorAll('header,nav,main,footer,h1,[role="main"],[role="banner"],[role="navigation"]');
      for (var m = 0; m < marks.length && out.landmarks.length < 8; m++) {
        var mark = marks[m];
        var markBox = mark.getBoundingClientRect();
        if (!(markBox.width > 0 && markBox.height > 0)) continue;
        out.landmarks.push({
          element: describe(mark),
          box: Math.round(markBox.x) + ',' + Math.round(markBox.y) + ' ' + Math.round(markBox.width) + '×' + Math.round(markBox.height)
        });
      }
    } catch (e) { /* landmarks are best-effort */ }
  } catch (e) {
    notes.push('measurement stopped early: ' + (e && e.message ? e.message : 'unknown error'));
  }
  return out;
})()`;

/** Compact, model-facing rendering. Only sections with findings are printed. */
export function formatMeasure(result: MeasureResult): string {
  const lines: string[] = [];
  const view = result.viewport;
  lines.push(
    `Viewport ${view.width}×${view.height} @${view.dpr}x · page ${view.pageHeight}px tall · scrolled to ${view.scrollY}`,
  );
  lines.push(
    `Elements: ${result.elements.visible} visible of ${result.elements.total} (measured ${result.elements.measured})`,
  );
  if (result.colors.page) {
    lines.push(`Page background: ${result.colors.page}`);
  }
  if (result.colors.backgrounds.length > 0) {
    lines.push(
      `Painted backgrounds (elements, by area): ${result.colors.backgrounds
        .map(color => `${color.color} ${Math.round(color.share * 100)}%`)
        .join(", ")}`,
    );
  }
  if (result.colors.text.length > 0) {
    lines.push(
      `Text colors: ${result.colors.text.map(color => color.color).join(", ")}`,
    );
  }
  if (result.fonts.length > 0) {
    lines.push(
      `Fonts: ${result.fonts
        .map(
          font =>
            `${font.family} (${font.elements}${font.available ? "" : ", NOT AVAILABLE — falling back"})`,
        )
        .join(", ")}`,
    );
  }
  if (result.contrast.failures.length > 0) {
    lines.push(`Contrast failures (${result.contrast.checked} text nodes checked):`);
    for (const failure of result.contrast.failures) {
      lines.push(
        `  ${failure.ratio}:1 (needs ${failure.required}:1) ${failure.color} on ${failure.background} at ${failure.fontSize}px — "${failure.text}"`,
      );
    }
  } else if (result.contrast.checked > 0) {
    lines.push(`Contrast: no failures in ${result.contrast.checked} text nodes`);
  }
  if (result.images.broken.length > 0) {
    lines.push(`Broken images (${result.images.broken.length} of ${result.images.total}):`);
    for (const image of result.images.broken) {
      lines.push(`  ${image.src}${image.alt ? ` [alt: ${image.alt}]` : " [no alt]"}`);
    }
  }
  if (result.images.oversized.length > 0) {
    lines.push("Oversized images (intrinsic ≫ displayed):");
    for (const image of result.images.oversized) {
      lines.push(`  ${image.src} ${image.natural} shown at ${image.displayed}`);
    }
  }
  if (result.overflow.length > 0) {
    lines.push("Horizontal overflow past the viewport:");
    for (const item of result.overflow) {
      lines.push(`  ${item.element} +${item.overflowPx}px`);
    }
  }
  if (result.animations.running > 0) {
    lines.push(
      `Animations running: ${result.animations.running}${result.animations.names.length > 0 ? ` (${result.animations.names.join(", ")})` : ""}`,
    );
  }
  if (result.landmarks.length > 0) {
    lines.push(
      `Landmarks: ${result.landmarks.map(mark => `${mark.element} ${mark.box}`).join(" · ")}`,
    );
  }
  for (const note of result.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

/**
 * The same colour maths the page runs, for tests. Compiled lazily so importing
 * this module stays side-effect free.
 */
let helpers:
  | {
      parseCssColor: (value: string) => [number, number, number, number] | null;
      relativeLuminance: (color: number[]) => number;
      contrastRatio: (foreground: number[], background: number[]) => number;
      contrastThreshold: (fontSizePx: number, fontWeight: number) => number;
    }
  | undefined;

export function getColorHelpers(): NonNullable<typeof helpers> {
  if (!helpers) {
    helpers = new Function(
      `${COLOR_HELPERS_JS}\nreturn { parseCssColor: parseCssColor, relativeLuminance: relativeLuminance, contrastRatio: contrastRatio, contrastThreshold: contrastThreshold };`,
    )() as NonNullable<typeof helpers>;
  }
  return helpers;
}
