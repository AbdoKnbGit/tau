import type { Span } from 'grok-mermaid'
import type { Tokens } from 'marked'
import React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, NoSelect, Text } from '../ink.js'
import { stripVTControlCharacters } from 'node:util'
import { markdownCodePreview } from '../utils/markdownCodePreview.js'
import {
  describeMermaidFallback,
  describeMermaidOmissions,
  fitMermaidArt,
} from '../utils/mermaidDiagram.js'
import type { Theme } from '../utils/theme.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { CopyAction, MarkdownButton } from './MarkdownCopyAction.js'

/**
 * Lets a render tree keep mermaid blocks as source. /export and the transcript
 * opened in an editor write text files, where the source is what belongs; the
 * live transcript leaves this at true.
 */
export const MermaidDiagramsContext = React.createContext(true)

const SPAN_COLORS: { readonly [K in Span['cls']]?: keyof Theme } = {
  border: 'promptBorder',
  edge: 'suggestion',
  edgeLabel: 'inactive',
  title: 'suggestion',
}

type Props = {
  token: Tokens.Code
  /** Show the source of a block that is not drawn, as the ctrl+o view does. */
  showSource: boolean
  interactive?: boolean
}

function MermaidSource({ token }: { token: Tokens.Code }): React.ReactNode {
  const { columns } = useTerminalSize()
  const preview = React.useMemo(() => markdownCodePreview(token.text, true, columns), [token.text, columns])
  const visible = stripVTControlCharacters(preview.text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '')
  return <Box flexDirection="column">
    <Text>{visible}</Text>
    {preview.hidden && <Text dimColor>Source preview truncated</Text>}
  </Box>
}

function MermaidArtOrReason({ token, showSource, interactive }: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [peek, setPeek] = React.useState(false)
  const drawing = fitMermaidArt(token.text, columns)
  const art = drawing.art
  const sourceVisible = (interactive && peek) || (showSource && !art)
  return (
    <Box flexDirection="column">
      {interactive && <NoSelect fromLeftEdge><Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <MarkdownButton label={peek ? (art ? 'Show diagram' : 'Hide source') : 'Show source'} onAction={() => setPeek(open => !open)} />
        <CopyAction label="Copy diagram source" text={() => token.text} />
        {art && <CopyAction label="Copy diagram art" text={() => art.rows.map(row => row.map(span => span.text).join('')).join('\n')} />}
      </Box></NoSelect>}
      {sourceVisible && <MermaidSource token={token} />}
      {!art && <Text dimColor>{describeMermaidFallback(drawing.fallback)}{!sourceVisible && <> <CtrlOToExpand /></>}</Text>}
      {!sourceVisible && art?.rows.map((row, i) => (
        // truncate-end: if a resize race leaves a row too wide, it is clipped
        // instead of wrapping into the next one.
        <Text key={i} wrap="truncate-end">
          {row.length === 0
            ? ' '
            : row.map((span, j) => {
                const color = SPAN_COLORS[span.cls]
                return color ? (
                  <Text key={j} color={color}>
                    {span.text}
                  </Text>
                ) : (
                  span.text
                )
              })}
        </Text>
      ))}
      {!sourceVisible && art && art.omitted > 0 && (
        <Text dimColor>{describeMermaidOmissions(art.omitted)}</Text>
      )}
    </Box>
  )
}

type BoundaryProps = { token: Tokens.Code; children: React.ReactNode }
type BoundaryState = { failed: boolean }

/**
 * A render-path exception exits tau (the Ink root's componentDidCatch), so a
 * failure while drawing falls back to the source here instead.
 */
class MermaidDiagramBoundary extends React.Component<
  BoundaryProps,
  BoundaryState
> {
  override state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  override render(): React.ReactNode {
    return this.state.failed ? (
      <MermaidSource token={this.props.token} />
    ) : (
      this.props.children
    )
  }
}

/**
 * A finished top-level ```mermaid block: box art when it can be drawn safely
 * at the current terminal width, otherwise the reason it is not drawn.
 */
export const MermaidDiagram = React.memo(
  function MermaidDiagram(props: Props): React.ReactNode {
    return (
      <MermaidDiagramBoundary token={props.token}>
        <MermaidArtOrReason {...props} />
      </MermaidDiagramBoundary>
    )
  },
  // Streaming re-lexes finished blocks into new token objects; only the text,
  // the language and the view decide what is shown.
  (prev, next) =>
    prev.token.text === next.token.text &&
    prev.token.lang === next.token.lang &&
    prev.interactive === next.interactive &&
    prev.showSource === next.showSource,
)
