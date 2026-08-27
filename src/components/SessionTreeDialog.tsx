import type { UUID } from 'crypto'
import figures from 'figures'
import React, { useCallback, useMemo, useState } from 'react'
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- this dialog owns its own arrow + typing search loop
import { Box, Text, useInput } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { LogOption } from '../types/logs.js'
import { formatRelativeTimeAgo } from '../utils/format.js'
import {
  type FlatTreeNode,
  flattenForest,
  renderTreePrefix,
  type SessionTreeNode,
} from '../utils/sessionTree.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import TextInput from './TextInput.js'

type Props = {
  forest: SessionTreeNode[]
  /** Session ID currently active in the REPL — gets a "← active" marker. */
  activeSessionId?: string
  onSelect: (sessionId: UUID, log: LogOption) => void
  /**
   * Persist a new title for one session (ctrl+R). Left out ⇒ no rename
   * affordance is shown.
   */
  onRename?: (sessionId: UUID, log: LogOption, title: string) => Promise<void>
  onCancel: () => void
}

const MAX_VISIBLE_ROWS = 14

// Some terminals deliver ctrl+R as the raw control character rather than
// input='r' + key.ctrl, so both forms are accepted.
const CTRL_R_RAW = String.fromCharCode(18)

/**
 * A title is "garbage" if it leads with junk that the user wouldn't
 * recognize: a `<lowercase-tag>` (local-command-caveat, system-reminder,
 * ide-context, etc.) or a `Caveat:` prefix. These come from older /branch
 * runs that titled themselves with the slash-command wrapper instead of
 * the user's first real prompt. firstPrompt (extracted by tau's lite-load
 * path) skips the same junk, so it's the better fallback.
 */
function looksLikeJunkTitle(title: string | undefined): boolean {
  if (!title) return true
  const trimmed = title.trim()
  if (trimmed.length === 0) return true
  if (trimmed.startsWith('<')) return true
  if (trimmed.toLowerCase().startsWith('caveat:')) return true
  return false
}

function displayTitle(log: {
  customTitle?: string
  firstPrompt?: string
}): string {
  const custom = log.customTitle?.trim()
  if (custom && !looksLikeJunkTitle(custom)) return custom
  const first = log.firstPrompt?.trim()
  if (first && !looksLikeJunkTitle(first)) {
    // Preserve the suffix (e.g. " (Branch 2)") if the saved title had it,
    // since that's how the user distinguishes siblings at a glance.
    if (custom) {
      const suffixMatch = custom.match(/\s\((Branch|Clone|Imported)[^)]*\)$/)
      if (suffixMatch) return `${first}${suffixMatch[0]}`
    }
    return first
  }
  return custom || first || '(untitled)'
}

function rowText(row: FlatTreeNode, title: string): string {
  const tag = row.node.log.tag ?? ''
  return `${title} ${tag} ${row.node.sessionId}`.toLowerCase()
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

function isPrintable(ch: string): boolean {
  const code = ch.charCodeAt(0)
  // Printable ASCII range plus everything above 0x7F (Unicode letters etc).
  return (code >= 32 && code !== 127) || code > 127
}

export function SessionTreeDialog({
  forest,
  activeSessionId,
  onSelect,
  onRename,
  onCancel,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [query, setQuery] = useState('')
  // sessionId → title renamed during this dialog. The forest is built once
  // from disk, so renamed rows would otherwise keep showing the old title.
  const [renamedTitles, setRenamedTitles] = useState<Record<string, string>>({})
  const [renameTarget, setRenameTarget] = useState<FlatTreeNode | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameCursorOffset, setRenameCursorOffset] = useState(0)
  const [renameError, setRenameError] = useState<string | null>(null)
  const isRenaming = renameTarget !== null

  const titleFor = useCallback(
    (node: SessionTreeNode): string =>
      renamedTitles[node.sessionId] ?? displayTitle(node.log),
    [renamedTitles],
  )

  const allRows = useMemo(() => flattenForest(forest), [forest])

  // Filter by query — keep ancestors of any matching row so the tree stays
  // structurally valid (a child shouldn't render without its parent above it).
  const filteredRows = useMemo(() => {
    if (!query.trim()) return allRows
    const needle = query.trim().toLowerCase()
    const keepIds = new Set<string>()
    for (const row of allRows) {
      if (rowText(row, titleFor(row.node)).includes(needle)) {
        keepIds.add(row.node.sessionId)
      }
    }
    const ancestors = new Set<string>()
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i]!
      if (!keepIds.has(row.node.sessionId)) continue
      let targetDepth = row.depth - 1
      for (let j = i - 1; j >= 0 && targetDepth >= 0; j--) {
        const candidate = allRows[j]!
        if (candidate.depth === targetDepth) {
          ancestors.add(candidate.node.sessionId)
          targetDepth--
        }
      }
    }
    return allRows.filter(
      r => keepIds.has(r.node.sessionId) || ancestors.has(r.node.sessionId),
    )
  }, [allRows, query, titleFor])

  const initialIndex = useMemo(() => {
    if (!activeSessionId) return 0
    const idx = filteredRows.findIndex(
      r => r.node.sessionId === activeSessionId,
    )
    return idx >= 0 ? idx : 0
  }, [filteredRows, activeSessionId])
  const [cursor, setCursor] = useState(initialIndex)
  const safeCursor = Math.max(0, Math.min(cursor, filteredRows.length - 1))

  const handleConfirm = useCallback(() => {
    const row = filteredRows[safeCursor]
    if (!row) return
    onSelect(row.node.sessionId as UUID, row.node.log)
  }, [filteredRows, safeCursor, onSelect])

  const cancelRename = useCallback(() => {
    setRenameTarget(null)
    setRenameValue('')
    setRenameCursorOffset(0)
    setRenameError(null)
  }, [])

  const startRename = useCallback(() => {
    const row = filteredRows[safeCursor]
    if (!row) return
    // Seed with the existing custom title so a tweak doesn't mean retyping,
    // but never with a first-prompt fallback or a junk `<tag>` title — those
    // stay as the placeholder instead.
    const saved = row.node.log.customTitle?.trim()
    const seed =
      renamedTitles[row.node.sessionId] ??
      (saved && !looksLikeJunkTitle(saved) ? saved : '')
    setRenameTarget(row)
    setRenameValue(seed)
    setRenameCursorOffset(seed.length)
    setRenameError(null)
  }, [filteredRows, safeCursor, renamedTitles])

  const submitRename = useCallback(
    async (value: string) => {
      if (!renameTarget || !onRename) return
      const title = value.trim()
      if (!title) {
        cancelRename()
        return
      }
      const { sessionId, log } = renameTarget.node
      try {
        await onRename(sessionId as UUID, log, title)
        setRenamedTitles(prev => ({ ...prev, [sessionId]: title }))
        cancelRename()
      } catch (error) {
        setRenameError(
          error instanceof Error ? error.message : String(error ?? 'failed'),
        )
      }
    },
    [renameTarget, onRename, cancelRename],
  )

  // Esc leaves the rename field without closing the whole dialog. Dialog's own
  // confirm:no is disabled below (isCancelActive) while this one is live.
  useKeybinding('confirm:no', cancelRename, {
    context: 'Settings',
    isActive: isRenaming,
  })

  useInput((input, key) => {
    if (
      onRename &&
      ((key.ctrl && input.toLowerCase() === 'r') || input === CTRL_R_RAW)
    ) {
      startRename()
      return
    }
    if (key.upArrow) {
      setCursor(c => (c <= 0 ? filteredRows.length - 1 : c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => (c >= filteredRows.length - 1 ? 0 : c + 1))
      return
    }
    if (key.return) {
      handleConfirm()
      return
    }
    if (key.pageUp) {
      setCursor(c => Math.max(0, c - MAX_VISIBLE_ROWS))
      return
    }
    if (key.pageDown) {
      setCursor(c => Math.min(filteredRows.length - 1, c + MAX_VISIBLE_ROWS))
      return
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1))
      setCursor(0)
      return
    }
    if (input && !key.ctrl && !key.meta && !key.escape) {
      let printable = ''
      for (const ch of input) {
        if (isPrintable(ch)) printable += ch
      }
      if (printable.length === 0) return
      setQuery(q => q + printable)
      setCursor(0)
    }
  }, { isActive: !isRenaming })

  const startRow = Math.max(
    0,
    Math.min(
      safeCursor - Math.floor(MAX_VISIBLE_ROWS / 2),
      filteredRows.length - MAX_VISIBLE_ROWS,
    ),
  )
  const endRow = Math.min(startRow + MAX_VISIBLE_ROWS, filteredRows.length)

  const renderRow = (row: FlatTreeNode, isCursor: boolean): React.ReactNode => {
    const log = row.node.log
    const title = titleFor(row.node)
    const meta = `${log.messageCount} msgs · ${formatRelativeTimeAgo(log.modified, { style: 'short' })}`
    const isActive = row.node.sessionId === activeSessionId
    const prefix = renderTreePrefix(row)
    const cursorMark = isCursor ? `${figures.pointer} ` : '  '
    const activeMark = isActive ? '  ← active' : ''
    const overhead =
      cursorMark.length + prefix.length + meta.length + activeMark.length + 5
    const maxTitle = Math.max(10, columns - overhead)
    const safeTitle = truncate(title, maxTitle)
    return (
      <Box key={row.node.sessionId}>
        <Text color={isCursor ? 'cyan' : undefined}>{cursorMark}</Text>
        <Text dimColor>{prefix}</Text>
        <Text bold={isCursor} color={isActive ? 'green' : undefined}>
          {safeTitle}
        </Text>
        <Text dimColor>{`  [${meta}]`}</Text>
        {isActive && <Text color="green">{activeMark}</Text>}
      </Box>
    )
  }

  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return <Text>Press {exitState.keyName} again to exit</Text>
    }
    if (isRenaming) {
      return (
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="save" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description="cancel"
          />
        </Byline>
      )
    }
    return (
      <Byline>
        <KeyboardShortcutHint shortcut="↑/↓" action="navigate" />
        <KeyboardShortcutHint shortcut="Enter" action="resume" />
        {onRename && (
          <KeyboardShortcutHint shortcut="Ctrl+R" action="rename" />
        )}
        <KeyboardShortcutHint shortcut="type" action="search" />
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Confirmation"
          fallback="Esc"
          description="cancel"
        />
      </Byline>
    )
  }

  const subtitle = isRenaming
    ? 'Rename session'
    : filteredRows.length === allRows.length
      ? `${allRows.length} session${allRows.length === 1 ? '' : 's'} in this project`
      : `${filteredRows.length} of ${allRows.length} sessions match "${query}"`

  return (
    <Dialog
      title="Session Tree"
      subtitle={subtitle}
      color="permission"
      onCancel={onCancel}
      inputGuide={renderInputGuide}
      isCancelActive={!isRenaming}
    >
      {filteredRows.length === 0 ? (
        <Text dimColor>No sessions match "{query}"</Text>
      ) : (
        <Box flexDirection="column">
          {filteredRows
            .slice(startRow, endRow)
            .map((row, i) => renderRow(row, startRow + i === safeCursor))}
          {filteredRows.length > MAX_VISIBLE_ROWS && (
            <Text dimColor>
              {' '}
              ({safeCursor + 1}/{filteredRows.length})
            </Text>
          )}
        </Box>
      )}
      {renameTarget && (
        <Box flexDirection="column">
          <Text bold>Rename session:</Text>
          <Box paddingTop={1}>
            <TextInput
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={value => void submitRename(value)}
              placeholder={truncate(
                titleFor(renameTarget.node),
                Math.max(20, columns - 12),
              )}
              columns={columns}
              cursorOffset={renameCursorOffset}
              onChangeCursorOffset={setRenameCursorOffset}
              showCursor
            />
          </Box>
          {renameError && <Text color="error">{renameError}</Text>}
        </Box>
      )}
    </Dialog>
  )
}
