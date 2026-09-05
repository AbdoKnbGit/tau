import { toString as qrToString } from 'qrcode'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text, useInput } from '../../ink.js'
import { subscribeClients } from '../../services/remote/bus.js'
import {
  isOn,
  NoLanError,
  RemoteCancelledError,
  turnOff,
  turnOn,
  type RemoteMode,
} from '../../services/remote/lifecycle.js'
import { listLanCandidates } from '../../services/remote/lan.js'
import { getRemoteState } from '../../services/remote/state.js'
import { TunnelUnavailableError } from '../../services/remote/tunnel.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args = '') => {
  const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase()

  if (sub === 'off') {
    const was = isOn()
    turnOff()
    onDone(was ? 'remote: stopped' : 'remote: not running')
    return null
  }

  if (sub === 'status') {
    const state = getRemoteState()
    onDone(
      state
        ? [
            `remote: ${state.mode}`,
            state.tunnelDown ? 'tunnel DOWN (LAN only)' : state.url,
            state.lanUrl ? `lan: ${state.lanUrl}` : null,
            `${state.clients} device(s)`,
          ]
            .filter(Boolean)
            .join(' · ')
        : 'remote: off',
    )
    return null
  }

  if (sub === 'local' || sub === 'global') {
    return <Pairing mode={sub} onDone={onDone} />
  }

  return <ModePicker onDone={onDone} />
}

// ─── Mode picker ─────────────────────────────────────────────────────

function ModePicker({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [idx, setIdx] = useState(0)
  const [mode, setMode] = useState<RemoteMode | null>(null)
  const lan = listLanCandidates()[0]?.address ?? null

  const items: { id: RemoteMode; label: string; hint: string }[] = [
    {
      id: 'local',
      label: 'Local  ·  same Wi-Fi',
      hint: lan
        ? `Serves on ${lan}. Instant, nothing leaves your network.`
        : 'No Wi-Fi/Ethernet address found right now.',
    },
    {
      id: 'global',
      label: 'Global  ·  anywhere',
      hint: 'Free Cloudflare tunnel over HTTPS. Works on cellular. Needs cloudflared.',
    },
  ]

  useInput((input, key) => {
    if (key.escape) {
      onDone('')
      return
    }
    if (key.upArrow || input === 'k') setIdx(i => (i + items.length - 1) % items.length)
    if (key.downArrow || input === 'j') setIdx(i => (i + 1) % items.length)
    if (key.return) setMode(items[idx]!.id)
  })

  if (mode) return <Pairing mode={mode} onDone={onDone} />

  return (
    <Dialog title="Remote · where will you be?" onCancel={() => onDone('')} color="permission">
      <Box flexDirection="column" paddingLeft={1}>
        {items.map((item, i) => (
          <Box key={item.id} flexDirection="column" marginBottom={i === 0 ? 1 : 0}>
            <Text color={i === idx ? 'permission' : undefined}>
              {i === idx ? '❯ ' : '  '}
              {item.label}
            </Text>
            <Text dimColor>{'    '}{item.hint}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>↑↓ to choose · Enter to start · Esc to cancel</Text>
        </Box>
      </Box>
    </Dialog>
  )
}

// ─── Pairing ─────────────────────────────────────────────────────────

function Pairing({
  mode,
  onDone,
}: {
  mode: RemoteMode
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [qrAscii, setQrAscii] = useState('')
  const [url, setUrl] = useState('')
  const [lanUrl, setLanUrl] = useState<string | null>(null)
  const [clients, setClients] = useState(getRemoteState()?.clients ?? 0)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState('')

  useEffect(() => {
    let cancelled = false

    void turnOn(mode, s => {
      if (!cancelled) setStage(s)
    })
      .then(state => {
        if (cancelled) return
        setUrl(state.url)
        setLanUrl(state.lanUrl)
        setClients(state.clients)
        return qrToString(state.url, { type: 'utf8', errorCorrectionLevel: 'L' })
      })
      .then(ascii => {
        if (cancelled || !ascii) return
        if (ascii.length === 0) {
          setError('QR rendered empty (terminal too narrow?)')
          return
        }
        setQrAscii(ascii)
      })
      .catch(err => {
        // The user asked for /remote off mid-start; closing quietly is the
        // answer, not an error dialog.
        if (cancelled || err instanceof RemoteCancelledError) return
        setError(
          err instanceof NoLanError || err instanceof TunnelUnavailableError
            ? err.message
            : `Could not start: ${err?.message ?? err}`,
        )
      })

    const unsubscribe = subscribeClients(setClients)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [mode])

  // Scanning the code is the whole interaction — once a device is on, hand the
  // terminal straight back instead of making the user reach over and press Esc.
  useEffect(() => {
    if (clients < 1) return
    const timer = setTimeout(() => {
      onDone(`remote: ${mode} · ${clients} device${clients === 1 ? '' : 's'} connected`)
    }, 700)
    return () => clearTimeout(timer)
  }, [clients, mode, onDone])

  // Esc closes the pane and leaves the server running — the point is to scan,
  // pocket the phone, and let the agent carry on.
  useInput((_input, key) => {
    if (key.escape) onDone(url ? `remote: ${mode} · ${url}` : '')
  })

  if (error) {
    return (
      <Dialog title="Remote · unavailable" onCancel={() => onDone('')} color="permission">
        <Box flexDirection="column" paddingLeft={1}>
          {error.split('\n').map((line, i) => (
            <Text key={i} color={i === 0 ? 'error' : undefined} dimColor={i > 0}>
              {line}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text dimColor>Esc to close</Text>
          </Box>
        </Box>
      </Dialog>
    )
  }

  const lines = qrAscii.split('\n').filter(l => l.length > 0)
  // A quick tunnel can take ~30s for the edge to route. Naming the stage is
  // the difference between "it is working" and "it has hung".
  const waiting = stage || (mode === 'global' ? 'Opening tunnel…' : 'Starting server…')

  return (
    <Dialog
      title={`Remote · ${mode} · scan with your phone`}
      onCancel={() => onDone('')}
      color="permission"
    >
      <Box flexDirection="column" paddingLeft={1}>
        <Text dimColor>
          {mode === 'local'
            ? 'Phone must be on the same Wi-Fi. Scan, then chat from the browser.'
            : 'Works from anywhere, including cellular. Scan to open.'}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {lines.length === 0 ? (
            <Text dimColor>{waiting}</Text>
          ) : (
            lines.map((line, i) => <Text key={i}>{line}</Text>)
          )}
        </Box>
        {url && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>{url}</Text>
            {lanUrl && <Text dimColor>also on this Wi-Fi: {lanUrl}</Text>}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>
            {clients > 0 ? (
              <Text color="success">{clients} device(s) connected</Text>
            ) : (
              'Waiting for a device…'
            )}
            {' · Esc keeps it running · /remote off to stop'}
          </Text>
        </Box>
      </Box>
    </Dialog>
  )
}
