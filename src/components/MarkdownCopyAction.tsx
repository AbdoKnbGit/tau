import React, { useContext, useEffect, useRef, useState } from 'react'
import { Button, Text } from '../ink.js'
import { copyClipboardText } from '../ink/termio/osc.js'
import { TerminalWriteContext } from '../ink/useTerminalNotification.js'

export function MarkdownButton({ label, onAction }: { label: string; onAction: () => void }): React.ReactNode {
  return <Button onAction={onAction}>
    {({ focused, hovered }: { focused: boolean; hovered: boolean }) =>
      <Text dimColor={!focused && !hovered} underline={focused || hovered}>[{label}]</Text>}
  </Button>
}

export function CopyAction({ label, text }: { label: string; text: () => string | null }): React.ReactNode {
  const writeRaw = useContext(TerminalWriteContext)
  const [status, setStatus] = useState('')
  const mounted = useRef(false)
  const busy = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const copy = async () => {
    if (busy.current) return
    busy.current = true
    try {
      const value = text()
      if (value === null) throw new Error('Source unavailable')
      const { sequence, path } = await copyClipboardText(value)
      if (sequence && writeRaw) writeRaw(sequence)
      if (mounted.current) setStatus(path === 'native' ? 'copied' : path === 'tmux-buffer' ? 'sent to tmux' : writeRaw ? 'sent via OSC 52' : 'unavailable')
    } catch {
      if (mounted.current) setStatus('unavailable; use /copy')
    } finally { busy.current = false }
  }
  return <MarkdownButton label={status ? `${label}: ${status}` : label} onAction={() => { void copy() }} />
}
