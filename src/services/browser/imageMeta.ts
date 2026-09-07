/**
 * Vision receipts.
 *
 * A screenshot the model never received is not evidence, and a screenshot it
 * did receive should be citable. Every capture is measured here — real pixel
 * dimensions read out of the encoded bytes, byte count, and a content hash —
 * so a claim about appearance can point at a specific image, and a capture
 * that was only written to disk is visibly marked as *not* seen.
 *
 * Dimensions are parsed rather than assumed: the requested clip, the device
 * scale factor and the capture scale all disagree with each other, and the
 * encoded header is the only thing that knows what was actually produced.
 */

import { createHash } from "crypto";

export interface ImageMeta {
  bytes: number;
  /** First 8 hex chars of the SHA-256 of the image bytes. */
  hash: string;
  width?: number;
  height?: number;
  format?: "png" | "jpeg";
}

/** Short, stable content hash. Same pixels twice produce the same token. */
export function hashBytes(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 8);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset]! << 24) |
      (buffer[offset + 1]! << 16) |
      (buffer[offset + 2]! << 8) |
      buffer[offset + 3]!) >>>
    0
  );
}

function readUint16BE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset]! << 8) | buffer[offset + 1]!;
}

function isPng(buffer: Uint8Array): boolean {
  if (buffer.length < 24) return false;
  return PNG_SIGNATURE.every((byte, index) => buffer[index] === byte);
}

/**
 * JPEG frame markers that carry the frame size. C4 (Huffman tables), C8
 * (reserved) and CC (arithmetic coding conditioning) share the range but are
 * not frame headers.
 */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Reads intrinsic dimensions out of PNG or JPEG bytes. Returns undefined
 * dimensions for anything else rather than guessing — a receipt that lies
 * about size is worse than one that stays quiet.
 */
export function imageDimensions(
  buffer: Uint8Array,
): { width: number; height: number; format: "png" | "jpeg" } | null {
  if (isPng(buffer)) {
    // Byte 8 starts the IHDR chunk: length(4) + type(4), then width, height.
    return {
      width: readUint32BE(buffer, 16),
      height: readUint32BE(buffer, 20),
      format: "png",
    };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = buffer[offset + 1]!;
    // Fill bytes: any run of 0xFF before the real marker byte.
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset++;
      marker = buffer[offset + 1]!;
    }
    offset += 2;
    // Standalone markers carry no payload length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 1 >= buffer.length) break;
    const segmentLength = readUint16BE(buffer, offset);
    if (segmentLength < 2) break;
    if (isStartOfFrame(marker)) {
      if (offset + 7 >= buffer.length) break;
      return {
        height: readUint16BE(buffer, offset + 3),
        width: readUint16BE(buffer, offset + 5),
        format: "jpeg",
      };
    }
    offset += segmentLength;
  }
  return null;
}

/** Measures a capture: bytes, content hash, and real dimensions when readable. */
export function describeImage(buffer: Uint8Array): ImageMeta {
  const dimensions = imageDimensions(buffer);
  return {
    bytes: buffer.length,
    hash: hashBytes(buffer),
    ...(dimensions
      ? {
          width: dimensions.width,
          height: dimensions.height,
          format: dimensions.format,
        }
      : {}),
  };
}

/**
 * The line the model reads. `seen` distinguishes an image that entered the
 * conversation (citable) from one that only reached disk (not citable) — the
 * whole point of the receipt.
 */
export function formatVisionReceipt(
  meta: ImageMeta,
  options: { step: number; seen: boolean; savedPath?: string },
): string {
  const size =
    meta.width && meta.height ? `${meta.width}×${meta.height}` : "size unknown";
  const kb = Math.max(1, Math.round(meta.bytes / 1024));
  const parts = [
    options.seen
      ? `vision token shot#${options.step}:${meta.hash}`
      : `NOT SHOWN TO YOU — no vision token`,
    size,
    `${kb}KB`,
  ];
  if (options.savedPath) parts.push(`saved ${options.savedPath}`);
  if (!options.seen) {
    parts.push(
      "the image went to disk only; do not describe what it looks like",
    );
  }
  return parts.join(" · ");
}
