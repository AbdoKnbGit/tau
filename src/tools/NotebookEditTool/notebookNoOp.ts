type NotebookCellLike = {
  source: string | string[]
  cell_type: 'code' | 'markdown'
}

type NotebookReadStateLike = {
  timestamp: number
}

export function isNotebookReplaceNoOp(
  cell: NotebookCellLike,
  newSource: string,
  requestedType?: 'code' | 'markdown',
): boolean {
  const currentSource = Array.isArray(cell.source)
    ? cell.source.join('')
    : cell.source
  return (
    currentSource === newSource &&
    (requestedType === undefined || requestedType === cell.cell_type)
  )
}

export function getNotebookNoOpMessage(cellId: string | undefined): string {
  return `Cell ${cellId} already has the requested source and type. Nothing changed; do not retry this edit.`
}

/**
 * Revalidate after every asynchronous pre-write hook. The timestamp protects
 * the model's earlier Read snapshot; exact pre/post-hook bytes additionally
 * catch writes inside the await window on coarse-mtime filesystems.
 */
export function notebookChangedSinceRead(
  currentContent: string,
  currentMtime: number,
  lastRead: NotebookReadStateLike | undefined,
  contentBeforeHooks?: string,
): boolean {
  // This exact byte comparison closes the await window even when the
  // filesystem timestamp has coarse resolution.
  if (
    contentBeforeHooks !== undefined &&
    currentContent !== contentBeforeHooks
  ) {
    return true
  }
  if (!lastRead) return true
  return currentMtime > lastRead.timestamp
}
