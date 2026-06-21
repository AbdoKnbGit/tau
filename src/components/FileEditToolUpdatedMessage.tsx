import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { count } from '../utils/array.js'
import {
  countDiffRows,
  MAX_DIFF_LINES_TO_RENDER,
  truncateHunks,
} from '../utils/diffTruncate.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { MessageResponse } from './MessageResponse.js'
import { StructuredDiffList } from './StructuredDiffList.js'

type Props = {
  filePath: string
  structuredPatch: StructuredPatchHunk[]
  firstLine: string | null
  fileContent?: string
  style?: 'condensed'
  verbose: boolean
  previewHint?: string
}

/**
 * Diff view shared by Update (FileEditTool) and Write-overwrite (FileWriteTool)
 * so both render identically. The diff stacks vertically (flexDirection column —
 * Ink Box defaults to row) and caps at MAX_DIFF_LINES_TO_RENDER rows in the
 * normal view, appending a "+N lines (ctrl+o to expand)" hint. ctrl+o / verbose
 * shows the full diff; each tool's isResultTruncated wires up the affordance.
 */
export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  firstLine,
  fileContent,
  style,
  verbose,
  previewHint,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const numAdditions = structuredPatch.reduce(
    (acc, hunk) => acc + count(hunk.lines, l => l.startsWith('+')),
    0,
  )
  const numRemovals = structuredPatch.reduce(
    (acc, hunk) => acc + count(hunk.lines, l => l.startsWith('-')),
    0,
  )

  const text = (
    <Text color="brandBright">
      {numAdditions > 0 ? (
        <>
          Added <Text bold>{numAdditions}</Text>{' '}
          {numAdditions > 1 ? 'lines' : 'line'}
        </>
      ) : null}
      {numAdditions > 0 && numRemovals > 0 ? ', ' : null}
      {numRemovals > 0 ? (
        <>
          {numAdditions === 0 ? 'R' : 'r'}emoved <Text bold>{numRemovals}</Text>
          {' '}
          {numRemovals > 1 ? 'lines' : 'line'}
        </>
      ) : null}
    </Text>
  )

  // Plan files: just the hint in regular mode. Subagent/condensed view: just
  // the summary line, no diff.
  if (previewHint) {
    if (style !== 'condensed' && !verbose) {
      return (
        <MessageResponse>
          <Text dimColor>{previewHint}</Text>
        </MessageResponse>
      )
    }
  } else if (style === 'condensed' && !verbose) {
    return text
  }

  const totalRows = countDiffRows(structuredPatch)
  const shouldTruncate = !verbose && totalRows > MAX_DIFF_LINES_TO_RENDER
  const hunks = shouldTruncate
    ? truncateHunks(structuredPatch, MAX_DIFF_LINES_TO_RENDER)
    : structuredPatch
  const omitted = totalRows - countDiffRows(hunks)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {text}
        <Box
          flexDirection="column"
          borderColor="brandDim"
          borderStyle="round"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={1}
        >
          <StructuredDiffList
            hunks={hunks}
            dim={false}
            width={columns - 12}
            filePath={filePath}
            firstLine={firstLine}
            fileContent={fileContent}
          />
        </Box>
        {shouldTruncate && (
          <Text dimColor>
            … +{omitted} {omitted === 1 ? 'line' : 'lines'} <CtrlOToExpand />
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}
