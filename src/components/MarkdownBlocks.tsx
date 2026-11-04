import type { Tokens } from 'marked'
import React, { useMemo, useState } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, NoSelect, Text } from '../ink.js'
import type { CliHighlight } from '../utils/cliHighlight.js'
import { markdownCodePreview } from '../utils/markdownCodePreview.js'
import { createMarkdownTableCopy } from '../utils/markdownTableCopy.js'
import { HighlightedCode } from './HighlightedCode.js'
import { CopyAction, MarkdownButton } from './MarkdownCopyAction.js'
import { MarkdownTable } from './MarkdownTable.js'

function codePath(language: string): string {
  const aliases: Record<string, string> = { typescript: 'ts', javascript: 'js', python: 'py', rust: 'rs', bash: 'sh', shell: 'sh', powershell: 'ps1', csharp: 'cs', 'c++': 'cpp' }
  return `./reply.${aliases[language.toLowerCase()] ?? language.toLowerCase()}`
}

export function MarkdownCodeBlock({ token }: { token: Tokens.Code }): React.ReactNode {
  const { columns } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)
  const preview = useMemo(() => markdownCodePreview(token.text, expanded, Math.max(1, columns - 6)), [token.text, expanded, columns])
  const language = (token.lang?.trim().split(/\s+/, 1)[0] ?? 'text').replace(/[^\w#+.-]/g, '').slice(0, 32) || 'text'
  return <Box flexDirection="column">
    <NoSelect fromLeftEdge><Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Text dimColor>{language} · {preview.totalLines} {preview.totalLines === 1 ? 'line' : 'lines'}</Text>
      <CopyAction label="Copy code" text={() => token.text} />
      {preview.foldable && <MarkdownButton label={expanded ? 'Show less' : 'Expand'} onAction={() => setExpanded(value => !value)} />}
    </Box></NoSelect>
    <HighlightedCode key={Math.max(1, columns - 6)} allowNative={false} code={preview.text} filePath={codePath(language)} width={Math.max(1, columns - 6)} />
    {preview.hidden && <NoSelect fromLeftEdge><Text dimColor>{expanded ? '… preview limit reached; Copy code keeps the complete source' : '… more source; expand or copy the complete code'}</Text></NoSelect>}
  </Box>
}

export function MarkdownTableBlock({ token, highlight }: { token: Tokens.Table; highlight: CliHighlight | null }): React.ReactNode {
  return <Box flexDirection="column">
    <NoSelect fromLeftEdge><Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      <CopyAction label="Copy table Markdown" text={() => token.raw} />
      <CopyAction label="Copy safe TSV" text={() => createMarkdownTableCopy(token)?.tsv ?? null} />
      <Text dimColor>TSV treats formula-like cells as text</Text>
    </Box></NoSelect>
    <MarkdownTable token={token} highlight={highlight} />
  </Box>
}
