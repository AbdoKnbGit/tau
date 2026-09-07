/**
 * Extraction that carries its own provenance.
 *
 * WHY: a scrape that returns plain values invites two silent failures. First,
 * the wrong element — an observed run pulled `a` from each product card and got
 * the wishlist anchor, so every "product link" was really
 * `/customer/account/login/?return=…`; the final table looked perfect because
 * the bad column was quietly dropped. Second, mixed sources — scraped prices
 * presented alongside specifications the model supplied from memory, with no
 * way for a reader to tell which was which.
 *
 * So every value comes back with the selector that produced it and the page it
 * came from, and the obvious extraction mistakes are detected in-page and
 * reported rather than left to look like data.
 */

/** Shared with the page: what makes a link the wrong link. */
const HREF_HELPERS_JS = `
function classifyHref(href) {
  var value = String(href || '').trim();
  if (!value) return { suspicious: true, label: 'empty href' };
  if (value === '#' || value.indexOf('javascript:') === 0) {
    return { suspicious: true, label: 'placeholder href (' + value.slice(0, 12) + ')' };
  }
  var lower = value.toLowerCase();
  var path = lower;
  var query = '';
  var mark = lower.indexOf('?');
  if (mark >= 0) { path = lower.slice(0, mark); query = lower.slice(mark + 1); }
  var accountPattern = /(^|[\\/._-])(login|signin|sign-in|log-in|register|signup|sign-up|account|auth|logout|wishlist|favou?rite)([\\/._-]|$)/;
  if (accountPattern.test(path)) {
    return { suspicious: true, label: 'account/login URL, not an item URL' };
  }
  if (/(^|[\\/._-])(cart|panier|basket)([\\/._-]|$)/.test(path) && /add/.test(path)) {
    return { suspicious: true, label: 'add-to-cart URL' };
  }
  if (/(^|&)(return|redirect|redirect_uri|next|continue|callback)=/.test(query)) {
    return { suspicious: true, label: 'redirect URL carrying a return target' };
  }
  return { suspicious: false };
}
`;

export interface ExtractedField {
  value: string;
  matched: boolean;
  /** How many elements the selector matched inside this row. */
  count: number;
  warn?: string;
}

export interface ExtractRow {
  index: number;
  fields: Record<string, ExtractedField>;
}

export interface FieldProvenance {
  field: string;
  selector: string;
  /** Rows in which the selector matched at least one element. */
  matchedRows: number;
  distinctValues: number;
  warnings: string[];
}

export interface ExtractResult {
  ok: boolean;
  error?: string;
  url: string;
  title: string;
  container?: string;
  rowsFound: number;
  rows: ExtractRow[];
  provenance: FieldProvenance[];
  /** Repeating structures on the page, offered when the container matched nothing. */
  suggestions?: Array<{ selector: string; count: number }>;
}

/**
 * A field selector is `css`, `css@attr`, `@attr` (the row element itself) or
 * `.` (the row's own text).
 */
export function parseFieldSpec(spec: string): { selector: string; attribute?: string } {
  const trimmed = String(spec ?? "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at === 0) return { selector: ".", attribute: trimmed.slice(1) };
  if (at > 0) {
    return { selector: trimmed.slice(0, at).trim() || ".", attribute: trimmed.slice(at + 1) };
  }
  return { selector: trimmed || "." };
}

/**
 * Builds the in-page extractor. Selectors travel as JSON data on `window`, never
 * as concatenated code, so a selector containing quotes or backslashes cannot
 * become script.
 */
export function buildExtractScript(config: {
  container?: string;
  fields: Record<string, string>;
  limit: number;
}): string {
  const payload = JSON.stringify({
    container: config.container ?? null,
    fields: Object.entries(config.fields).map(([name, spec]) => ({
      name,
      spec,
      ...parseFieldSpec(spec),
    })),
    limit: config.limit,
  });
  return `(function(){
${HREF_HELPERS_JS}
  var config = ${payload};
  var out = {
    ok: true,
    url: location.href,
    title: document.title || '',
    container: config.container || undefined,
    rowsFound: 0,
    rows: [],
    provenance: []
  };
  var clean = function (text) {
    return String(text == null ? '' : text).replace(/\\s+/g, ' ').trim().slice(0, 300);
  };
  var readValue = function (element, attribute) {
    if (!element) return '';
    if (!attribute) {
      var text = element.innerText != null && element.innerText !== ''
        ? element.innerText
        : element.textContent;
      return clean(text);
    }
    // href/src resolve to absolute URLs through the property, which is what a
    // caller actually wants; everything else reads the literal attribute.
    if ((attribute === 'href' || attribute === 'src') && typeof element[attribute] === 'string') {
      return clean(element[attribute]);
    }
    if (typeof element.getAttribute === 'function') {
      var attributeValue = element.getAttribute(attribute);
      if (attributeValue != null) return clean(attributeValue);
    }
    var direct = element[attribute];
    return typeof direct === 'string' || typeof direct === 'number' ? clean(direct) : '';
  };
  var suggestContainers = function () {
    var counts = {};
    var nodes;
    try { nodes = document.body ? document.body.querySelectorAll('*') : []; } catch (e) { return []; }
    var cap = nodes.length < 4000 ? nodes.length : 4000;
    for (var i = 0; i < cap; i++) {
      var node = nodes[i];
      if (typeof node.className !== 'string' || !node.className.trim()) continue;
      var classes = node.className.trim().split(/\\s+/).slice(0, 2).join('.');
      if (!classes) continue;
      var selector = node.tagName.toLowerCase() + '.' + classes;
      counts[selector] = (counts[selector] || 0) + 1;
    }
    var rows = [];
    for (var name in counts) if (Object.prototype.hasOwnProperty.call(counts, name)) {
      if (counts[name] >= 3) rows.push({ selector: name, count: counts[name] });
    }
    rows.sort(function (a, b) { return b.count - a.count; });
    return rows.slice(0, 8);
  };
  try {
    var containers;
    if (config.container) {
      try {
        containers = Array.prototype.slice.call(document.querySelectorAll(config.container));
      } catch (e) {
        return {
          ok: false,
          error: 'Invalid container selector: ' + (e && e.message ? e.message : String(e)),
          url: location.href, title: document.title || '', rowsFound: 0, rows: [], provenance: []
        };
      }
    } else {
      containers = [document.body].filter(Boolean);
    }
    out.rowsFound = containers.length;
    if (containers.length === 0) {
      out.suggestions = suggestContainers();
      return out;
    }
    var limited = containers.slice(0, config.limit);
    var stats = {};
    for (var f = 0; f < config.fields.length; f++) {
      stats[config.fields[f].name] = { matchedRows: 0, values: {}, warnings: {} };
    }
    for (var r = 0; r < limited.length; r++) {
      var row = { index: r, fields: {} };
      for (var g = 0; g < config.fields.length; g++) {
        var field = config.fields[g];
        var stat = stats[field.name];
        var matches = [];
        if (field.selector === '.') {
          matches = [limited[r]];
        } else {
          try {
            matches = Array.prototype.slice.call(limited[r].querySelectorAll(field.selector));
          } catch (e) {
            row.fields[field.name] = {
              value: '', matched: false, count: 0,
              warn: 'invalid selector: ' + (e && e.message ? e.message : String(e))
            };
            stat.warnings['invalid selector'] = 1;
            continue;
          }
        }
        var value = readValue(matches[0], field.attribute);
        var entry = { value: value, matched: matches.length > 0, count: matches.length };
        if (matches.length > 1) {
          entry.warn = 'selector matched ' + matches.length + ' elements in this row; took the first';
          stat.warnings['ambiguous selector (matched more than one element per row)'] = 1;
        }
        if (matches.length > 0 && value === '') {
          entry.warn = (entry.warn ? entry.warn + '; ' : '') + 'element found but its '
            + (field.attribute ? field.attribute + ' attribute' : 'text') + ' is empty';
          stat.warnings['matched an element but read an empty value'] = 1;
        }
        if (field.attribute === 'href' && value) {
          var verdict = classifyHref(value);
          if (verdict.suspicious) {
            entry.warn = (entry.warn ? entry.warn + '; ' : '') + verdict.label;
            stat.warnings['href points at ' + verdict.label] = 1;
          }
        }
        if (matches.length > 0) {
          stat.matchedRows++;
          stat.values[value] = 1;
        }
        row.fields[field.name] = entry;
      }
      out.rows.push(row);
    }
    for (var p = 0; p < config.fields.length; p++) {
      var spec = config.fields[p];
      var summary = stats[spec.name];
      var distinct = Object.keys(summary.values).length;
      var warnings = Object.keys(summary.warnings);
      if (summary.matchedRows === 0) {
        warnings.unshift('matched nothing in any row');
      } else if (limited.length > 1 && distinct === 1 && summary.matchedRows === limited.length) {
        warnings.unshift('identical in all ' + limited.length + ' rows — the selector may be reaching outside the row');
      }
      out.provenance.push({
        field: spec.name,
        selector: spec.spec,
        matchedRows: summary.matchedRows,
        distinctValues: distinct,
        warnings: warnings
      });
    }
    return out;
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
      url: location.href, title: document.title || '', rowsFound: 0, rows: [], provenance: []
    };
  }
})()`;
}

/**
 * Model-facing rendering: the rows, then where every column came from. The
 * provenance block is not optional — it is the reason this action exists.
 */
export function formatExtract(result: ExtractResult, fieldOrder: string[]): string {
  if (!result.ok) {
    return `Extraction failed: ${result.error ?? "unknown error"}`;
  }
  const lines: string[] = [];
  lines.push(
    `${result.rows.length} row(s) from ${result.rowsFound} match(es) of ${result.container ?? "the document"} on ${result.url}`,
  );
  if (result.rows.length === 0) {
    lines.push("");
    lines.push("No rows matched that container selector.");
    if (result.suggestions && result.suggestions.length > 0) {
      lines.push("Repeating structures on this page you could use instead:");
      for (const suggestion of result.suggestions) {
        lines.push(`  ${suggestion.selector} × ${suggestion.count}`);
      }
    }
    return lines.join("\n");
  }
  lines.push("");
  for (const row of result.rows) {
    const cells = fieldOrder.map(name => {
      const field = row.fields[name];
      if (!field) return `${name}=`;
      const flag = field.warn ? " ⚠" : "";
      return `${name}=${JSON.stringify(field.value)}${flag}`;
    });
    lines.push(`[${row.index}] ${cells.join("  ")}`);
  }
  lines.push("");
  lines.push("Provenance (every value above came from exactly this):");
  for (const entry of result.provenance) {
    const base = `  ${entry.field} ← ${entry.selector} · matched ${entry.matchedRows}/${result.rows.length} rows · ${entry.distinctValues} distinct`;
    lines.push(base);
    for (const warning of entry.warnings) lines.push(`      ⚠ ${warning}`);
  }
  const rowWarnings = result.rows.flatMap(row =>
    Object.entries(row.fields)
      .filter(([, field]) => field.warn)
      .map(([name, field]) => `  [${row.index}] ${name}: ${field.warn}`),
  );
  if (rowWarnings.length > 0) {
    lines.push("");
    lines.push("Per-row problems:");
    lines.push(...rowWarnings.slice(0, 20));
    if (rowWarnings.length > 20) {
      lines.push(`  … and ${rowWarnings.length - 20} more`);
    }
  }
  lines.push("");
  lines.push(
    "Anything not in the table above did not come from this page. Do not add specifications, prices or links from memory.",
  );
  return lines.join("\n");
}

/** The href classifier the page runs, compiled lazily for tests. */
let hrefHelpers: { classifyHref: (href: string) => { suspicious: boolean; label?: string } } | undefined;

export function getHrefHelpers(): NonNullable<typeof hrefHelpers> {
  if (!hrefHelpers) {
    hrefHelpers = new Function(
      `${HREF_HELPERS_JS}\nreturn { classifyHref: classifyHref };`,
    )() as NonNullable<typeof hrefHelpers>;
  }
  return hrefHelpers;
}
