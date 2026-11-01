import React, { createContext, useContext, type ReactNode } from 'react';
import { useQueuedMessage } from '../../context/QueuedMessageContext.js';
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js';
import { Box } from '../../ink.js';
import type { Theme } from '../../utils/theme.js';

/**
 * True while messages are rendered to text for a file (/export and the transcript
 * dump). A file gets the full prompt and no box-drawing, whatever the screen shows.
 */
export const PlainTranscriptContext = createContext(false);

/** Below this the frame and its padding would take more than a quarter of the row. */
const MIN_FRAME_COLUMNS = 16;

/** The theme slot for the frame and the pointer. No /mode overlay touches it, so a
 *  /mode cross-fade never changes rows that have already reached the scrollback. */
export const PROMPT_FRAME_COLOR = 'borderActive' satisfies keyof Theme;

type Props = {
  addMargin: boolean;
  borderColor?: keyof Theme;
  /** Message-actions highlight. Applies with or without the frame. */
  backgroundColor?: keyof Theme;
  /** Fill used only when there is no frame, as the row has nothing else to mark it. */
  plainBackgroundColor?: keyof Theme;
  flexDirection?: 'row' | 'column';
  children: ReactNode;
};

/**
 * The box around a prompt once it has been sent, so a prompt can be told apart
 * from dense output at a glance. It hugs its text, which also keeps it from being
 * mistaken for the full-width input box below. Rows are laid out by Yoga like any
 * other, so inline images and diagrams move with it and a resize re-wraps it.
 */
export function UserPromptFrame({
  addMargin,
  borderColor = PROMPT_FRAME_COLOR,
  backgroundColor,
  plainBackgroundColor,
  flexDirection = 'column',
  children
}: Props): React.ReactNode {
  const isQueued = useQueuedMessage()?.isQueued ?? false;
  const isPlain = useContext(PlainTranscriptContext);
  const columns = useContext(TerminalSizeContext)?.columns;
  const marginTop = addMargin ? 1 : 0;
  // A queued prompt has not been sent yet, and the bottom slot is short of rows.
  if (isQueued || isPlain || columns !== undefined && columns < MIN_FRAME_COLUMNS) {
    return <Box flexDirection={flexDirection} marginTop={marginTop} backgroundColor={backgroundColor ?? plainBackgroundColor} paddingRight={1}>
        {children}
      </Box>;
  }
  return <Box flexDirection={flexDirection} flexShrink={0} alignSelf="flex-start" marginTop={marginTop} backgroundColor={backgroundColor} borderStyle="round" borderColor={borderColor} noSelectBorder paddingX={1}>
      {children}
    </Box>;
}

/**
 * The folded form of a prompt, or undefined where the full text belongs: Ctrl+O,
 * which is where a pasted text can be read back, and text written to a file.
 */
export function useFoldedPrompt(pastedDisplayText: string | undefined, isTranscriptMode: boolean | undefined): string | undefined {
  const isPlain = useContext(PlainTranscriptContext);
  return isTranscriptMode || isPlain ? undefined : pastedDisplayText;
}
