import type { Span } from 'grok-mermaid'
import type { Tokens } from 'marked'
import React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Ansi, Box, Text, useTheme } from '../ink.js'
import {
  describeMermaidFallback,
  describeMermaidOmissions,
  fitMermaidArt,
} from '../utils/mermaidDiagram.js'
import type { Theme } from '../utils/theme.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { highlightCode } from './StructuredDiff/colorDiff.js'

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
}

/** The block exactly as a code fence renders without diagrams. */
function MermaidSource({ token }: { token: Tokens.Code }): React.ReactNode {
  const [theme] = useTheme()
  return <Ansi>{highlightCode(token.text, token.lang || null, theme)}</Ansi>
}

function MermaidArtOrReason({ token, showSource }: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const drawing = fitMermaidArt(token.text, columns)
  if (drawing.art === null) {
    const reason = describeMermaidFallback(drawing.fallback)
    // One line in the normal view; the ctrl+o view shows the source.
    if (!showSource) {
      return (
        <Text dimColor>
          {reason} <CtrlOToExpand />
        </Text>
      )
    }
    return (
      <Box flexDirection="column">
        <MermaidSource token={token} />
        <Text dimColor>{reason}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {drawing.art.rows.map((row, i) => (
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
      {drawing.art.omitted > 0 && (
        <Text dimColor>{describeMermaidOmissions(drawing.art.omitted)}</Text>
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
  function MermaidDiagram({ token, showSource }: Props): React.ReactNode {
    return (
      <MermaidDiagramBoundary token={token}>
        <MermaidArtOrReason token={token} showSource={showSource} />
      </MermaidDiagramBoundary>
    )
  },
  // Streaming re-lexes finished blocks into new token objects; only the text,
  // the language and the view decide what is shown.
  (prev, next) =>
    prev.token.text === next.token.text &&
    prev.token.lang === next.token.lang &&
    prev.showSource === next.showSource,
)
