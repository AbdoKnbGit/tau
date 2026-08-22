/**
 * Write replaces the file with the requested bytes. `currentContent` is the
 * normalized read representation, so the exact full-file CRLF signal prevents
 * a mixed-ending file from being mistaken for a byte-identical no-op.
 */
export function isFileWriteNoOp(
  currentContent: string,
  currentHasCRLF: boolean,
  requestedContent: string,
): boolean {
  return !currentHasCRLF && currentContent === requestedContent
}

export function getFileWriteNoOpMessage(filePath: string): string {
  return `The file ${filePath} already has the requested content. Nothing changed; do not retry this write.`
}
