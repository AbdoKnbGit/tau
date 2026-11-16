import { toString as qrToString } from 'qrcode'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../../components/design-system/Dialog.js'
import type { ExitState } from '../../hooks/useExitOnCtrlCD.js'
import { Box, Text, useInput } from '../../ink.js'
import { subscribeClients } from '../../services/remote/bus.js'
import type { TrustedDevice } from '../../services/remote/devices.js'
import {
  forgetDevice,
  InvalidRemoteHostError,
  InvalidRemotePortError,
  isOn,
  listConnections,
  listRememberedDevices,
  NoLanError,
  RemoteCancelledError,
  subscribeConnections,
  trustConnection,
  turnOff,
  turnOn,
  WslNatError,
  type RemoteMode,
} from '../../services/remote/lifecycle.js'
import { resolveLanReach, type LanReach } from '../../services/remote/reach.js'
import {
  isRememberable,
  RemotePortBusyError,
  type RemoteConnection,
} from '../../services/remote/server.js'
import { getRemoteState, type RemoteState } from '../../services/remote/state.js'
import { TunnelUnavailableError } from '../../services/remote/tunnel.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

/**
 * The link without its #token. Text handed to onDone stays in the transcript
 * and reaches the model like any message, so it must never carry the session
 * token — in global mode that would be a working public link to the session.
 * The dialogs themselves still show the full link to scan or copy.
 */
function address(url: string): string {
  return url.replace(/#.*$/, '')
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function guide(text: string): (exit: ExitState) => React.ReactNode {
  return exit => (exit.pending ? `Press ${exit.keyName} again to exit` : text)
}

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
    const remembered = listRememberedDevices().length
    onDone(
      [
        state ? `remote: ${state.mode}` : 'remote: off',
        state &&
          (state.tunnelDown
            ? state.lanUrl
              ? 'tunnel DOWN (LAN only)'
              : 'tunnel DOWN'
            : address(state.url)),
        state?.lanUrl ? `lan: ${address(state.lanUrl)}` : null,
        state ? `${state.clients} device(s)` : null,
        remembered > 0 ? plural(remembered, 'remembered phone') : null,
      ]
        .filter(Boolean)
        .join(' · '),
    )
    return null
  }

  if (sub === 'devices' || sub === 'phones') {
    return <Devices onDone={onDone} />
  }

  if (sub === 'local' || sub === 'global') {
    return <Pairing mode={sub} onDone={onDone} />
  }

  return <ModePicker onDone={onDone} />
}

// ─── Mode picker ─────────────────────────────────────────────────────

function localHint(reach: LanReach | null): string {
  if (!reach) return 'Looking for your Wi-Fi address…'
  switch (reach.kind) {
    case 'lan':
      return `Serves on ${reach.address}. Instant, nothing leaves your network.`
    case 'wsl-nat':
      return 'Your phone cannot reach it: WSL 2 networking hides this session from your Wi-Fi.'
    case 'invalid-override':
      return 'TAU_REMOTE_HOST is not a bare IP address or hostname.'
    case 'none':
      return 'No Wi-Fi/Ethernet address found right now.'
  }
}

function ModePicker({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [idx, setIdx] = useState(0)
  const [mode, setMode] = useState<RemoteMode | null>(null)
  const [reach, setReach] = useState<LanReach | null>(null)
  const moved = useRef(false)

  useEffect(() => {
    let live = true
    void resolveLanReach().then(result => {
      if (!live) return
      setReach(result)
      // Under WSL 2 NAT only global can work, so start on it — unless the
      // user has already picked a row while this was resolving.
      if (result.kind === 'wsl-nat' && !moved.current) setIdx(1)
    })
    return () => {
      live = false
    }
  }, [])

  const items: { id: RemoteMode; label: string; hint: string }[] = [
    {
      id: 'local',
      label: 'Local  ·  same Wi-Fi',
      hint: localHint(reach),
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
    if (key.upArrow || input === 'k') {
      moved.current = true
      setIdx(i => (i + items.length - 1) % items.length)
    }
    if (key.downArrow || input === 'j') {
      moved.current = true
      setIdx(i => (i + 1) % items.length)
    }
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

/** Errors whose message already tells the user what to do. */
const EXPLAINED = [
  NoLanError,
  WslNatError,
  InvalidRemoteHostError,
  InvalidRemotePortError,
  RemotePortBusyError,
  TunnelUnavailableError,
]

function portNote(state: RemoteState): string | null {
  if (!state.preferredPortBusy) return null
  return `Port 7777 is taken, so this session uses ${state.port}. Phones remembered on :7777 will not find it.`
}

function Pairing({
  mode: requested,
  onDone,
}: {
  mode: RemoteMode
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  // State rather than the prop: local mode's error screen can hand over to
  // global without closing the dialog.
  const [mode, setMode] = useState<RemoteMode>(requested)
  const [qrAscii, setQrAscii] = useState('')
  const [url, setUrl] = useState('')
  const [lanUrl, setLanUrl] = useState<string | null>(null)
  const [otherHosts, setOtherHosts] = useState<string[]>([])
  const [portWarning, setPortWarning] = useState<string | null>(null)
  const [clients, setClients] = useState(getRemoteState()?.clients ?? 0)
  const [error, setError] = useState<string | null>(null)
  // Local mode cannot work here but global can (WSL 2 NAT).
  const [offerGlobal, setOfferGlobal] = useState(false)
  const [stage, setStage] = useState('')
  // Phones that scanned this code and could be remembered, oldest first.
  const [asking, setAsking] = useState<RemoteConnection[]>([])
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  // A scan with nothing to ask: through the tunnel, or a phone already remembered.
  const [arrived, setArrived] = useState<RemoteConnection | null>(null)
  const [remembered] = useState(() => listRememberedDevices().length)

  useEffect(() => {
    let cancelled = false

    void turnOn(mode, s => {
      if (!cancelled) setStage(s)
    })
      .then(state => {
        if (cancelled) return
        setUrl(state.url)
        setLanUrl(state.lanUrl)
        setOtherHosts(state.otherHosts)
        setClients(state.clients)
        setPortWarning(portNote(state))
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
        setOfferGlobal(err instanceof WslNatError)
        setError(
          EXPLAINED.some(kind => err instanceof kind)
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

  // Only phones that arrive by scanning while this dialog is open count. One
  // already connected, or a remembered phone reconnecting on its own, is not
  // the scan this dialog is waiting for — closing on those used to flash the
  // code for 0.7 s when you opened it to pair a second phone.
  useEffect(
    () =>
      subscribeConnections(event => {
        const phone = event.connection
        if (event.type === 'left') {
          setAsking(list => list.filter(c => c.id !== phone.id))
          return
        }
        if (event.type !== 'joined' || !phone.scanned) return
        if (isRememberable(phone)) setAsking(list => [...list, phone])
        else setArrived(phone)
      }),
    [],
  )

  const current = asking[0] ?? null

  // Nothing to ask: scanning is the whole interaction, so hand the terminal
  // straight back instead of making the user reach over and press Esc.
  useEffect(() => {
    if (!arrived || current || saving) return
    const timer = setTimeout(() => {
      const how = arrived.kind === 'device' ? ' (remembered)' : ''
      onDone(`remote: ${mode} · ${arrived.name}${how} connected`)
    }, 700)
    return () => clearTimeout(timer)
  }, [arrived, current, saving, mode, onDone])

  // Remembered and nobody else waiting: let the confirmation register, then close.
  useEffect(() => {
    if (!outcome?.ok || current || saving) return
    const timer = setTimeout(() => onDone(`remote: ${mode} · ${outcome.text}`), 1200)
    return () => clearTimeout(timer)
  }, [outcome, current, saving, mode, onDone])

  const remember = (phone: RemoteConnection): void => {
    setSaving(true)
    void trustConnection(phone.id).then(result => {
      setSaving(false)
      setAsking(list => list.filter(c => c.id !== phone.id))
      setOutcome(
        result.ok
          ? { ok: true, text: `${result.device.name} remembered` }
          : { ok: false, text: `${phone.name} was not remembered: ${result.reason}.` },
      )
    })
  }

  const decline = (phone: RemoteConnection): void => {
    const rest = asking.filter(c => c.id !== phone.id)
    setAsking(rest)
    if (rest.length === 0 && !outcome) onDone(`remote: ${mode} · ${phone.name} connected`)
  }

  // Esc and N arrive through the Dialog's onCancel (its Confirmation
  // keybindings claim them); Y and G are plain input.
  useInput(input => {
    const letter = input.toLowerCase()
    if (current && !saving && letter === 'y') {
      remember(current)
      return
    }
    if (offerGlobal && letter === 'g') {
      setOfferGlobal(false)
      setError(null)
      setStage('')
      setMode('global')
    }
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
          {offerGlobal && (
            <Box marginTop={1} flexDirection="column">
              <Text>Press G to use Global instead. It works from anywhere, including cellular.</Text>
              <Text dimColor>
                To stay on Wi-Fi: switch WSL to mirrored networking (Windows 11 22H2+) and allow
                port 7777 in the Hyper-V firewall, or forward port 7777 from Windows and start
                Tau with TAU_REMOTE_HOST set to the Wi-Fi address of this PC and TAU_REMOTE_PORT=7777.
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>{offerGlobal ? 'G for Global · Esc to close' : 'Esc to close'}</Text>
          </Box>
        </Box>
      </Dialog>
    )
  }

  if (current) {
    return (
      <Dialog
        title={`Remote · ${mode} · phone connected`}
        onCancel={() =>
          saving ? onDone(`remote: ${mode} · ${current.name} connected`) : decline(current)
        }
        color="permission"
        inputGuide={guide(saving ? 'Esc to close' : 'Y remember · N only this time')}
      >
        <Box flexDirection="column" paddingLeft={1}>
          {outcome && (
            <Box marginBottom={1}>
              <Text color={outcome.ok ? 'success' : 'error'}>
                {outcome.ok ? `${outcome.text}.` : outcome.text}
              </Text>
            </Box>
          )}
          <Text>
            <Text bold>{current.name}</Text> connected from {current.address}.
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Remember this phone?</Text>
            <Text dimColor>
              It will reconnect to later sessions on this computer without a QR code, whenever
              /remote local is on. Forget it any time with /remote devices.
            </Text>
          </Box>
          {saving && (
            <Box marginTop={1}>
              <Text dimColor>Saving it on the phone…</Text>
            </Box>
          )}
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
      // Esc closes the pane and leaves the server running — the point is to
      // scan, pocket the phone, and let the agent carry on.
      onCancel={() => onDone(url ? `remote: ${mode} · ${address(url)}` : '')}
      color="permission"
      inputGuide={guide('Esc keeps it running · /remote off to stop')}
    >
      <Box flexDirection="column" paddingLeft={1}>
        {outcome && !outcome.ok && (
          <Box marginBottom={1}>
            <Text color="error">{outcome.text}</Text>
          </Box>
        )}
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
            {otherHosts.length > 0 && (
              <Text dimColor>
                phone on another network? this PC also answers on {otherHosts.join(', ')}
              </Text>
            )}
            {portWarning && <Text color="warning">{portWarning}</Text>}
            {remembered > 0 && (
              <Text dimColor>
                {plural(remembered, 'remembered phone')} reconnect on their own · /remote devices
              </Text>
            )}
          </Box>
        )}
        <Box marginTop={1}>
          {clients > 0 ? (
            <Text color="success">{clients} device(s) connected</Text>
          ) : (
            <Text dimColor>Waiting for a device…</Text>
          )}
        </Box>
      </Box>
    </Dialog>
  )
}

// ─── Remembered phones ───────────────────────────────────────────────

type Row =
  | { kind: 'device'; device: TrustedDevice; online: boolean }
  | { kind: 'phone'; connection: RemoteConnection }

function ago(iso: string | undefined, now = Date.now()): string | null {
  const then = Date.parse(iso ?? '')
  if (!Number.isFinite(then)) return null
  const minutes = Math.round(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 14) return `${plural(days, 'day')} ago`
  if (days < 60) return `${plural(Math.round(days / 7), 'week')} ago`
  return `${plural(Math.round(days / 30), 'month')} ago`
}

function day(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '?'
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function Devices({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [devices, setDevices] = useState<TrustedDevice[]>(() => listRememberedDevices())
  const [live, setLive] = useState<RemoteConnection[]>(() => listConnections())
  const [idx, setIdx] = useState(0)
  const [confirming, setConfirming] = useState<TrustedDevice | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const changes = useRef<string[]>([])

  useEffect(() => subscribeConnections(() => setLive(listConnections())), [])

  const refresh = (): void => {
    setDevices(listRememberedDevices())
    setLive(listConnections())
  }

  const online = new Set(live.map(c => c.deviceId).filter(Boolean))
  const rows: Row[] = [
    ...devices.map(device => ({ kind: 'device' as const, device, online: online.has(device.id) })),
    ...live.filter(isRememberable).map(connection => ({ kind: 'phone' as const, connection })),
  ]
  const selected = rows.length > 0 ? Math.min(idx, rows.length - 1) : -1
  const row = selected >= 0 ? rows[selected] : undefined

  const close = (): void => {
    onDone(changes.current.length > 0 ? `remote: ${changes.current.join(' · ')}` : '')
  }

  const forget = (device: TrustedDevice): void => {
    setConfirming(null)
    setBusy(`Forgetting ${device.name}…`)
    void forgetDevice(device.id)
      .then(
        () => {
          changes.current.push(`forgot ${device.name}`)
          setNote({ ok: true, text: `Forgot ${device.name}. It needs the QR code to connect again.` })
        },
        err => setNote({ ok: false, text: `Could not forget ${device.name}: ${(err as Error).message}` }),
      )
      .finally(() => {
        setBusy(null)
        refresh()
      })
  }

  const remember = (phone: RemoteConnection): void => {
    setBusy(`Saving it on ${phone.name}…`)
    void trustConnection(phone.id)
      .then(result => {
        if (result.ok) {
          changes.current.push(`${result.device.name} remembered`)
          setNote({ ok: true, text: `Remembered ${result.device.name}.` })
        } else {
          setNote({ ok: false, text: `${phone.name} was not remembered: ${result.reason}.` })
        }
      })
      .finally(() => {
        setBusy(null)
        refresh()
      })
  }

  // Esc and N arrive through the Dialog's onCancel; the rest is plain input.
  useInput((input, key) => {
    if (busy) return
    if (confirming) {
      if (input.toLowerCase() === 'y') forget(confirming)
      return
    }
    if (rows.length === 0) return
    if (key.upArrow || input === 'k') {
      setIdx((selected + rows.length - 1) % rows.length)
      return
    }
    if (key.downArrow || input === 'j') {
      setIdx((selected + 1) % rows.length)
      return
    }
    if (row?.kind === 'device' && (key.return || key.delete || key.backspace || input === 'd')) {
      setNote(null)
      setConfirming(row.device)
      return
    }
    if (row?.kind === 'phone' && (key.return || input === 'r')) {
      setNote(null)
      remember(row.connection)
    }
  })

  const keys = confirming
    ? 'Y forget · N keep'
    : busy
      ? ' '
      : row?.kind === 'device'
        ? '↑↓ choose · Enter forget · Esc close'
        : row?.kind === 'phone'
          ? '↑↓ choose · Enter remember · Esc close'
          : 'Esc close'

  return (
    <Dialog
      title="Remote · remembered phones"
      onCancel={() => {
        if (confirming) setConfirming(null)
        else if (!busy) close()
      }}
      color="permission"
      inputGuide={guide(keys)}
    >
      <Box flexDirection="column" paddingLeft={1}>
        <Text dimColor>
          {isOn()
            ? 'These reconnect without a QR code while /remote local is on.'
            : 'Remote is off. These reconnect without a QR code once /remote local or tau --remote-local is on.'}
        </Text>
        {devices.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>
              No remembered phones yet. Run /remote local, scan the code, and press Y when asked.
            </Text>
          </Box>
        )}
        {rows.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            {rows.map((r, i) =>
              r.kind === 'device' ? (
                <Box key={r.device.id} flexDirection="column">
                  <Text color={i === selected ? 'permission' : undefined}>
                    {i === selected ? '❯ ' : '  '}
                    {r.device.name}
                    {r.online ? <Text color="success"> · connected</Text> : null}
                  </Text>
                  <Text dimColor>
                    {'    '}
                    {[
                      r.device.origin,
                      `paired ${day(r.device.pairedAt)}`,
                      r.device.lastSeenAt ? `last seen ${ago(r.device.lastSeenAt)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Box>
              ) : (
                <Box key={r.connection.id} flexDirection="column">
                  {i === devices.length && (
                    <Box marginTop={devices.length > 0 ? 1 : 0}>
                      <Text dimColor>Connected now, not remembered:</Text>
                    </Box>
                  )}
                  <Text color={i === selected ? 'permission' : undefined}>
                    {i === selected ? '❯ ' : '  '}
                    {r.connection.name}
                  </Text>
                  <Text dimColor>
                    {'    '}from {r.connection.address}
                  </Text>
                </Box>
              ),
            )}
          </Box>
        )}
        {confirming && (
          <Box marginTop={1} flexDirection="column">
            <Text>Forget {confirming.name}?</Text>
            <Text dimColor>It is signed out now and needs the QR code to connect again.</Text>
          </Box>
        )}
        {busy && (
          <Box marginTop={1}>
            <Text dimColor>{busy}</Text>
          </Box>
        )}
        {note && (
          <Box marginTop={1}>
            <Text color={note.ok ? 'success' : 'error'}>{note.text}</Text>
          </Box>
        )}
      </Box>
    </Dialog>
  )
}
