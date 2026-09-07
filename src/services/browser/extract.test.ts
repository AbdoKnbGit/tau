/**
 * Provenance-carrying extraction.
 *
 * The headline case is the observed one: a product scrape whose "link" column
 * was really the wishlist anchor's login redirect, shipped as data because
 * nothing checked.
 *
 * Run: bun run src/services/browser/extract.test.ts
 */

import {
  buildExtractScript,
  formatExtract,
  getHrefHelpers,
  parseFieldSpec,
  type ExtractResult,
} from "./extract.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, hint: string): void {
  if (!condition) throw new Error(hint);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error: unknown) {
    failed++;
    console.log(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface FakeNode {
  text?: string;
  attrs?: Record<string, string>;
  href?: string;
}

function node(spec: FakeNode): Record<string, unknown> {
  return {
    innerText: spec.text ?? "",
    textContent: spec.text ?? "",
    href: spec.href,
    getAttribute(name: string): string | null {
      if (name === "href" && spec.href !== undefined) return spec.href;
      return spec.attrs?.[name] ?? null;
    },
  };
}

/** A row whose querySelectorAll is a lookup table, keyed by selector string. */
function row(children: Record<string, FakeNode[]>): Record<string, unknown> {
  return {
    innerText: "",
    textContent: "",
    querySelectorAll(selector: string): unknown[] {
      if (selector === "!invalid") throw new Error("not a valid selector");
      return (children[selector] ?? []).map(node);
    },
  };
}

function runExtract(options: {
  rows: Record<string, unknown>[];
  container?: string;
  fields: Record<string, string>;
  limit?: number;
  allElements?: Array<{ tagName: string; className: string }>;
  containerThrows?: boolean;
}): ExtractResult {
  const doc = {
    title: "Search results",
    body: {
      querySelectorAll: () => options.allElements ?? [],
    },
    querySelectorAll(selector: string): unknown[] {
      if (options.containerThrows) throw new Error("bad selector");
      return selector === options.container ? options.rows : [];
    },
  };
  const loc = { href: "https://shop.example/catalog/?q=rtx+5080" };
  const source = buildExtractScript({
    container: options.container,
    fields: options.fields,
    limit: options.limit ?? 10,
  });
  const run = new Function("window", "document", "location", `return ${source};`) as (
    w: unknown,
    d: unknown,
    l: unknown,
  ) => ExtractResult;
  return run({}, doc, loc);
}

function main(): void {
  console.log("field specs:");

  test("parses text, attribute and self forms", () => {
    assert(parseFieldSpec(".prc").selector === ".prc", "text");
    assert(parseFieldSpec(".prc").attribute === undefined, "no attribute");
    assert(parseFieldSpec("a@href").attribute === "href", "attribute");
    assert(parseFieldSpec("a@href").selector === "a", "selector part");
    assert(parseFieldSpec("@data-id").selector === ".", "self attribute");
    assert(parseFieldSpec("@data-id").attribute === "data-id", "self attribute name");
    assert(parseFieldSpec(".").selector === ".", "self text");
    assert(parseFieldSpec("").selector === ".", "empty means self");
  });

  console.log("href classification:");
  const { classifyHref } = getHrefHelpers();

  test("flags the login redirect that looked like a product link", () => {
    const verdict = classifyHref(
      "/customer/account/login/?tkWl=HP246CL62PBVMNAFAMZ&return=%2Fcatalog%2F%3Fq%3Drtx",
    );
    assert(verdict.suspicious, "must be flagged");
    assert(verdict.label!.includes("account"), verdict.label!);
  });

  test("flags placeholders, wishlists and redirect parameters", () => {
    assert(classifyHref("#").suspicious, "hash");
    assert(classifyHref("javascript:void(0)").suspicious, "javascript");
    assert(classifyHref("").suspicious, "empty");
    assert(classifyHref("/wishlist/add/123").suspicious, "wishlist");
    assert(classifyHref("/go?redirect=/checkout").suspicious, "redirect param");
    assert(classifyHref("/cart/add?sku=9").suspicious, "add to cart");
  });

  test("leaves real item URLs alone", () => {
    assert(!classifyHref("https://shop.example/zotac-rtx-5080-amp.html").suspicious, "product");
    assert(!classifyHref("/catalog/?q=rtx+5080&page=2").suspicious, "paged listing");
    assert(!classifyHref("/accounts-ledger-book-a4").suspicious, "word starting with account");
    assert(!classifyHref("/products/logitech-signature-keyboard").suspicious, "signature ≠ signin");
  });

  console.log("extraction:");

  test("returns values with their selectors and no warnings when clean", () => {
    const result = runExtract({
      container: "article.prd",
      fields: { name: ".name", price: ".prc" },
      rows: [
        row({ ".name": [{ text: "ZOTAC RTX 5080" }], ".prc": [{ text: "KSh 250,000" }] }),
        row({ ".name": [{ text: "PNY RTX 5080" }], ".prc": [{ text: "KSh 268,000" }] }),
      ],
    });
    assert(result.ok && result.rows.length === 2, JSON.stringify(result));
    assert(result.rows[0]!.fields.name!.value === "ZOTAC RTX 5080", "value");
    assert(result.provenance.every(entry => entry.warnings.length === 0), JSON.stringify(result.provenance));
    assert(result.provenance[0]!.selector === ".name", "selector recorded");
  });

  test("catches the wishlist-anchor bug in the row and in the provenance", () => {
    const result = runExtract({
      container: "article.prd",
      fields: { name: ".name", link: "a@href" },
      rows: [
        row({
          ".name": [{ text: "ZOTAC RTX 5080" }],
          a: [{ href: "/customer/account/login/?tkWl=ABC&return=%2Fcatalog" }],
        }),
        row({
          ".name": [{ text: "PNY RTX 5080" }],
          a: [{ href: "/customer/account/login/?tkWl=DEF&return=%2Fcatalog" }],
        }),
      ],
    });
    const linkField = result.rows[0]!.fields.link!;
    assert(linkField.warn !== undefined, "row must carry the warning");
    assert(linkField.warn!.includes("account"), linkField.warn!);
    const linkProvenance = result.provenance.find(entry => entry.field === "link")!;
    assert(linkProvenance.warnings.length > 0, "provenance must carry it too");
    assert(
      formatExtract(result, ["name", "link"]).includes("⚠"),
      "the rendered table must show the flag",
    );
  });

  test("reports a selector that matched nothing anywhere", () => {
    const result = runExtract({
      container: "article.prd",
      fields: { price: ".price-that-does-not-exist" },
      rows: [row({}), row({})],
    });
    const provenance = result.provenance[0]!;
    assert(provenance.matchedRows === 0, "no matches");
    assert(provenance.warnings[0]!.includes("matched nothing"), provenance.warnings[0]!);
  });

  test("reports a value that is identical in every row", () => {
    const result = runExtract({
      container: ".card",
      fields: { price: ".global-banner" },
      rows: [
        row({ ".global-banner": [{ text: "Free delivery" }] }),
        row({ ".global-banner": [{ text: "Free delivery" }] }),
        row({ ".global-banner": [{ text: "Free delivery" }] }),
      ],
    });
    assert(
      result.provenance[0]!.warnings.some(w => w.includes("identical in all 3 rows")),
      JSON.stringify(result.provenance[0]!.warnings),
    );
  });

  test("reports an ambiguous selector and takes the first match", () => {
    const result = runExtract({
      container: ".card",
      fields: { price: "span" },
      rows: [row({ span: [{ text: "old 300" }, { text: "now 250" }] })],
    });
    const field = result.rows[0]!.fields.price!;
    assert(field.value === "old 300", field.value);
    assert(field.count === 2, String(field.count));
    assert(field.warn!.includes("matched 2 elements"), field.warn!);
  });

  test("distinguishes a missing element from an empty one", () => {
    const result = runExtract({
      container: ".card",
      fields: { price: ".prc" },
      rows: [row({ ".prc": [{ text: "   " }] })],
    });
    const field = result.rows[0]!.fields.price!;
    assert(field.matched, "the element exists");
    assert(field.value === "", "but reads empty");
    assert(field.warn!.includes("empty"), field.warn!);
  });

  test("offers repeating structures when the container matched nothing", () => {
    const result = runExtract({
      container: "article.prd",
      fields: { name: ".name" },
      rows: [],
      allElements: [
        ...Array.from({ length: 12 }, () => ({ tagName: "ARTICLE", className: "core prd" })),
        ...Array.from({ length: 4 }, () => ({ tagName: "DIV", className: "banner" })),
        { tagName: "DIV", className: "" },
      ],
    });
    assert(result.rows.length === 0, "no rows");
    assert(result.suggestions !== undefined && result.suggestions.length > 0, "must suggest");
    assert(result.suggestions![0]!.selector === "article.core.prd", JSON.stringify(result.suggestions));
    assert(result.suggestions![0]!.count === 12, "with counts");
    const text = formatExtract(result, ["name"]);
    assert(text.includes("Repeating structures"), text);
  });

  test("an invalid container selector fails loudly instead of returning zero rows", () => {
    const result = runExtract({
      container: "article[",
      fields: { name: ".name" },
      rows: [],
      containerThrows: true,
    });
    assert(!result.ok, "must not claim success");
    assert(result.error!.includes("Invalid container selector"), result.error!);
  });

  test("an invalid field selector is reported per field, not fatal", () => {
    const result = runExtract({
      container: ".card",
      fields: { good: ".name", bad: "!invalid" },
      rows: [row({ ".name": [{ text: "Item" }] })],
    });
    assert(result.ok, "the row still extracts");
    assert(result.rows[0]!.fields.good!.value === "Item", "good field survives");
    assert(result.rows[0]!.fields.bad!.warn!.includes("invalid selector"), result.rows[0]!.fields.bad!.warn!);
  });

  test("selectors containing quotes travel as data, not as code", () => {
    const source = buildExtractScript({
      container: 'input[name="q"]',
      fields: { v: 'input[name="q"]@value' },
      limit: 5,
    });
    assert(source.includes('input[name=\\"q\\"]'), "must be JSON-escaped inside the script");
    const result = runExtract({
      container: 'input[name="q"]',
      fields: { v: "@value" },
      rows: [{ getAttribute: (name: string) => (name === "value" ? "rtx 5080" : null), querySelectorAll: () => [] }],
    });
    assert(result.rows[0]!.fields.v!.value === "rtx 5080", JSON.stringify(result.rows[0]));
  });

  test("the limit caps extracted rows but reports how many matched", () => {
    const result = runExtract({
      container: ".card",
      fields: { name: ".name" },
      limit: 2,
      rows: Array.from({ length: 9 }, (_, index) =>
        row({ ".name": [{ text: `Item ${index}` }] }),
      ),
    });
    assert(result.rowsFound === 9, String(result.rowsFound));
    assert(result.rows.length === 2, String(result.rows.length));
  });

  console.log("rendering:");

  test("the rendered block always states the boundary of the data", () => {
    const result = runExtract({
      container: ".card",
      fields: { name: ".name" },
      rows: [row({ ".name": [{ text: "ZOTAC RTX 5080" }] })],
    });
    const text = formatExtract(result, ["name"]);
    assert(text.includes("Provenance"), text);
    assert(text.includes("did not come from this page"), text);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
