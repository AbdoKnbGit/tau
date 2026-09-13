import type { UUID } from 'crypto'

/** Durable splice information; older transcripts only contain the endpoints. */
export type PreservedSegment = {
  headUuid: UUID
  anchorUuid: UUID
  tailUuid: UUID
  // Parallel tool results have branching disk parents. Save their exact order
  // so a single-parent walk cannot silently discard one of the branches.
  messageUuids?: UUID[]
}
