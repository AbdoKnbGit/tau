/**
 * Vision receipts: image measurement and citation tokens.
 *
 * Run: bun run src/services/browser/imageMeta.test.ts
 */

import {
  describeImage,
  formatVisionReceipt,
  hashBytes,
  imageDimensions,
} from "./imageMeta.js";

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

function uint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function uint16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...uint32(13),
    0x49, 0x48, 0x44, 0x52,
    ...uint32(width),
    ...uint32(height),
    8, 6, 0, 0, 0,
  ]);
}

/** FFD8, an APP0 segment that must be skipped, then the SOF0 frame header. */
function jpeg(
  width: number,
  height: number,
  options: { fillBytes?: boolean } = {},
): Uint8Array {
  const app0 = [
    0xff, 0xe0,
    ...uint16(16),
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ];
  const sofPrefix = options.fillBytes ? [0xff, 0xff, 0xff, 0xc0] : [0xff, 0xc0];
  return Uint8Array.from([
    0xff, 0xd8,
    ...app0,
    ...sofPrefix,
    ...uint16(17),
    8,
    ...uint16(height),
    ...uint16(width),
    3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
}

function main(): void {
  console.log("image measurement:");

  test("reads PNG dimensions out of IHDR", () => {
    const meta = imageDimensions(png(1280, 900));
    assert(meta?.width === 1280 && meta?.height === 900, JSON.stringify(meta));
    assert(meta?.format === "png", "format must be png");
  });

  test("reads JPEG dimensions past a skipped APP0 segment", () => {
    const meta = imageDimensions(jpeg(844, 594));
    assert(meta?.width === 844 && meta?.height === 594, JSON.stringify(meta));
    assert(meta?.format === "jpeg", "format must be jpeg");
  });

  test("tolerates JPEG marker fill bytes", () => {
    const meta = imageDimensions(jpeg(320, 240, { fillBytes: true }));
    assert(meta?.width === 320 && meta?.height === 240, JSON.stringify(meta));
  });

  test("returns null for bytes that are not an image", () => {
    assert(imageDimensions(Uint8Array.from([1, 2, 3, 4, 5])) === null, "garbage");
    assert(imageDimensions(new Uint8Array(0)) === null, "empty");
    assert(
      imageDimensions(new TextEncoder().encode("<html>not an image</html>")) === null,
      "html",
    );
  });

  test("truncated JPEG does not hang or throw", () => {
    const full = jpeg(100, 50);
    for (let cut = 2; cut < full.length; cut += 3) {
      imageDimensions(full.slice(0, cut));
    }
    assert(true, "unreachable");
  });

  console.log("content hashing:");

  test("same pixels hash the same, different pixels differ", () => {
    assert(hashBytes(png(10, 10)) === hashBytes(png(10, 10)), "stable");
    assert(hashBytes(png(10, 10)) !== hashBytes(png(11, 10)), "sensitive");
    assert(/^[0-9a-f]{8}$/.test(hashBytes(png(10, 10))), "8 hex chars");
  });

  test("describeImage carries bytes, hash and dimensions together", () => {
    const bytes = png(800, 600);
    const meta = describeImage(bytes);
    assert(meta.bytes === bytes.length, "byte count");
    assert(meta.width === 800 && meta.height === 600, "dimensions");
    assert(meta.hash.length === 8, "hash");
  });

  console.log("receipt wording:");

  test("an image in context gets a citable token", () => {
    const line = formatVisionReceipt(describeImage(png(1280, 900)), {
      step: 7,
      seen: true,
    });
    assert(line.startsWith("vision token shot#7:"), line);
    assert(line.includes("1280×900"), line);
  });

  test("an image only written to disk is explicitly not citable", () => {
    const line = formatVisionReceipt(describeImage(png(1280, 900)), {
      step: 8,
      seen: false,
      savedPath: "shots/home.png",
    });
    assert(line.includes("NOT SHOWN TO YOU"), line);
    assert(!line.includes("vision token shot#"), "must not mint a token");
    assert(line.includes("do not describe what it looks like"), line);
    assert(line.includes("shots/home.png"), line);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
