import * as React from 'react';
import { Box, type ClickEvent } from '../../ink.js';
import type { AgentColorName } from '../../tools/AgentTool/agentColorManager.js';
import type { PromptInputMode } from '../../types/textInputTypes.js';
import type { Theme } from '../../utils/theme.js';
import { PROMPT_INDICATOR_COLUMNS, PromptInputModeIndicator } from './PromptInputModeIndicator.js';

/** Padding inside the framed prompt box, on each side. */
export const PROMPT_FRAME_PADDING_X = 1;
// borderStyle="round" draws one column on each side.
const PROMPT_FRAME_BORDER_COLUMNS = 1;
// The banner row has no right border, so its text would reach the terminal's
// last column; it keeps one column clear there, as the prompt always has.
const BANNER_EDGE_COLUMNS = 1;

/**
 * 'framed' is the round prompt box. 'banner' is the borderless row shown under
 * an agent or teammate banner: the indicator and the text, nothing else.
 */
export type PromptInputLayout = 'framed' | 'banner';

/**
 * Columns the prompt's text gets in a row `rowColumns` wide. The input's cursor
 * model wraps lines at exactly this width, so it must equal what the layout
 * leaves for the text. Any wider and the terminal wraps those lines a second
 * time, so words jump between rows as spaces are typed.
 */
export function promptTextColumns(rowColumns: number, layout: PromptInputLayout): number {
  const chrome = layout === 'framed' ? 2 * (PROMPT_FRAME_BORDER_COLUMNS + PROMPT_FRAME_PADDING_X) + PROMPT_INDICATOR_COLUMNS : PROMPT_INDICATOR_COLUMNS + BANNER_EDGE_COLUMNS;
  // The cursor model keeps one column for the cursor, so two is the least
  // that still leaves room for a character.
  return Math.max(2, rowColumns - chrome);
}
type Props = {
  borderColor: keyof Theme;
  mode: PromptInputMode;
  isLoading: boolean;
  viewingAgentName?: string;
  viewingAgentColor?: AgentColorName;
  /** Receives clicks on the text only, so the event's local column and row are text positions. */
  onTextClick?: (event: ClickEvent) => void;
  children: React.ReactNode;
};

/** The round prompt box: border, padding, mode indicator, then the text input. */
export function PromptInputFrame({
  borderColor,
  mode,
  isLoading,
  viewingAgentName,
  viewingAgentColor,
  onTextClick,
  children
}: Props): React.ReactNode {
  return <Box flexDirection="row" alignItems="flex-start" justifyContent="flex-start" borderColor={borderColor} borderStyle="round" width="100%">
      <Box flexDirection="row" flexGrow={1} flexShrink={1} paddingX={PROMPT_FRAME_PADDING_X}>
        <PromptInputModeIndicator mode={mode} isLoading={isLoading} viewingAgentName={viewingAgentName} viewingAgentColor={viewingAgentColor} />
        <Box flexGrow={1} flexShrink={1} onClick={onTextClick}>
          {children}
        </Box>
      </Box>
    </Box>;
}
