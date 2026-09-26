export function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^(?:cell-)?(\d+)$/)
  if (match && match[1]) {
    const index = parseInt(match[1], 10)
    return isNaN(index) ? undefined : index
  }
  return undefined
}

/**
 * The id Read shows for a cell: its stored id, or `cell-N` for the cell at
 * position N when it has none.
 */
export function notebookCellDisplayId(
  cell: { id?: string | null },
  index: number,
): string {
  return cell.id ?? `cell-${index}`
}

/**
 * Index of the cell `cellId` names, matching what Read showed: a stored id,
 * or `cell-N` (or a bare N) for the cell at position N when it has no stored
 * id. A position never names a cell that has a stored id: Read never showed
 * it that way, and after an insert or delete the position may hold another
 * cell. Returns -1 when nothing matches.
 */
export function findNotebookCellIndex(
  cells: ReadonlyArray<{ id?: string | null }>,
  cellId: string,
): number {
  const byId = cells.findIndex(cell => cell.id === cellId)
  if (byId !== -1) return byId
  const position = parseCellId(cellId)
  if (position === undefined || position >= cells.length) return -1
  return cells[position]!.id == null ? position : -1
}
